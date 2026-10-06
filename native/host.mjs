#!/usr/bin/env node
/**
 * Chrome native-messaging host for PR Tracker. Two jobs:
 *   - "which local Claude Code sessions touched these PRs?" Read-only; never
 *     returns transcript content, only session metadata (see scan.mjs).
 *   - "judge this PR's comments": runs Claude Code headless (`claude -p`) on
 *     the user's own subscription, with every tool switched off, no settings,
 *     no MCP servers and no saved session — text in, JSON out. Only when
 *     Claude Code is signed in under a company plan (Team / Enterprise, or
 *     Bedrock / Vertex): a personal plan is refused before anything is sent.
 *   - optionally, keep the GitHub and Jenkins tokens in the macOS Keychain
 *     instead of Chrome's storage (`security`; the secret goes in on stdin,
 *     never in a process's arguments).
 *
 * Protocol (Chrome's): each message is a 4-byte little-endian length, then
 * that many bytes of UTF-8 JSON, on stdin / stdout.
 *
 *   → {type: 'sessions', prs: ['gdncomm/product-feed#104', …]}
 *   ← {ok: true, sessions: {'gdncomm/product-feed#104': [{sessionId, cwd, title, lastAt, kind}]}}
 *   → {type: 'judge', model, system, schema, prompt}  ← {ok: true, output: {summary, verdicts}}
 *   → {type: 'secret-set', name: 'github' | 'jenkins', value}  ← {ok: true}
 *   → {type: 'secret-get', name}  ← {ok: true, value}   (value '' when there is none)
 *   → {type: 'secret-delete', name}  ← {ok: true}
 *   → {type: 'ping'}  ← {ok: true, version: 4, claude: <found the claude CLI?>, keychain: true, account: {ok, label} | {ok: false, reason}}
 */

import { spawn } from 'node:child_process'
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { indexAll, sessionsFor } from './scan.mjs'

const ROOT = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects') : path.join(homedir(), '.claude', 'projects')
const CACHE = process.env.PR_TRACKER_CACHE || path.join(homedir(), '.cache', 'pr-tracker', 'claude-sessions.json')
/** PR Tracker's own repo: its sessions mention PRs as test data, not as work on them. */
const SELF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const VERSION = 4
/** Claude.ai plans that are a company's, not a person's. */
export const COMPANY_PLANS = new Set(['team', 'enterprise'])
/** Keychain item service; the account is the secret's name. */
export const KEYCHAIN_SERVICE = 'com.gdncomm.pr-tracker'
const SECRET_NAMES = new Set(['github', 'jenkins'])
/** GitHub and Jenkins tokens: letters, digits, _ - . : — nothing that needs quoting. */
const SECRET_VALUE = /^[A-Za-z0-9_.:-]{1,512}$/
/** A judge run longer than this is killed. */
const JUDGE_TIMEOUT_MS = 4 * 60 * 1000

/**
 * The claude CLI: install.sh pins it (Chrome starts helpers with a bare PATH),
 * else the usual install locations.
 * @returns {string | null}
 */
export function findClaude(env = process.env) {
  const candidates = [env.PR_TRACKER_CLAUDE, path.join(homedir(), '.local/bin/claude'), path.join(homedir(), '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  for (const c of candidates) {
    if (!c) continue
    try {
      accessSync(c, constants.X_OK)
      return c
    } catch {
      // next
    }
  }
  return null
}

/**
 * May PR content go to Claude under this login? From `claude auth status --json`.
 * Company plans and a company cloud (Bedrock, Vertex, …) may; a personal plan,
 * a signed-out CLI or a login we can't place may not.
 *
 * @param {any} status
 * @returns {{ok: true, label: string} | {ok: false, reason: string}}
 */
export function accountPolicy(status) {
  const fix = 'In a terminal run claude, then /logout and /login with your company account.'
  if (!status || status.loggedIn !== true) return { ok: false, reason: `Claude Code isn't signed in. ${fix}` }
  if (typeof status.apiProvider === 'string' && status.apiProvider !== 'firstParty') return { ok: true, label: `${status.apiProvider} (your company's cloud)` }
  const plan = typeof status.subscriptionType === 'string' ? status.subscriptionType.toLowerCase() : ''
  const org = typeof status.orgName === 'string' && status.orgName ? ` · ${status.orgName}` : ''
  if (COMPANY_PLANS.has(plan)) return { ok: true, label: `${plan[0].toUpperCase()}${plan.slice(1)} plan${org}` }
  const what = plan ? `a personal ${plan[0].toUpperCase()}${plan.slice(1)} plan` : status.authMethod === 'claude.ai' ? 'an account without a Team or Enterprise plan' : "an API key PR Tracker can't tell is your company's"
  return { ok: false, reason: `Claude Code is signed in with ${what}${org}. PR Tracker only sends PR content to Claude under a company Team or Enterprise plan (or Bedrock / Vertex). ${fix}` }
}

/** @param {string | null} bin */
export async function claudeAccount(bin = findClaude()) {
  if (!bin) return /** @type {const} */ ({ ok: false, reason: "The claude command wasn't found — re-run native/install.sh from a terminal where claude works." })
  const r = await run(bin, ['auth', 'status', '--json'], '', 20_000)
  /** @type {any} */ let status = null
  try {
    status = JSON.parse(r.stdout)
  } catch {
    // unreadable: refused below
  }
  return accountPolicy(status)
}

/**
 * @param {string} bin @param {string[]} args @param {string} input @param {number} timeoutMs
 * @returns {Promise<{code: number | null, signal: string | null, stdout: string, stderr: string, timedOut: boolean}>}
 */
function run(bin, args, input, timeoutMs) {
  return new Promise((resolve) => {
    // A scratch directory: no project CLAUDE.md or settings get picked up.
    const child = spawn(bin, args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    // claude catches SIGTERM and exits 143 by itself, so `signal` stays null: remember that we sent it.
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => resolve({ code: -1, signal: null, stdout, stderr: String(e), timedOut }))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
    child.stdin.end(input)
  })
}

/** The `claude -p` arguments for one judgement: no tools, settings, MCP or saved session. */
export function judgeArgs(/** @type {{model: string, system: string, schema: object}} */ r) {
  return ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(r.schema), '--model', r.model, '--system-prompt', r.system, '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence']
}

/**
 * @param {any} request
 * @param {string | null} [bin]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok: true, output: unknown} | {ok: false, error: string}>}
 */
export async function judge(request, bin = findClaude(), timeoutMs = JUDGE_TIMEOUT_MS) {
  const { model, system, schema, prompt } = request ?? {}
  if (typeof model !== 'string' || !/^claude-[a-z0-9-]{1,40}$/.test(model)) return { ok: false, error: 'bad model' }
  if (typeof system !== 'string' || typeof prompt !== 'string' || !schema || typeof schema !== 'object') return { ok: false, error: 'bad request' }
  if (prompt.length > 1_000_000) return { ok: false, error: 'PR too large to judge' }
  if (!bin) return { ok: false, error: "the claude command wasn't found — re-run native/install.sh from a terminal where `claude` works" }
  // Checked on every run, here in the helper: the page can't skip it.
  const account = await claudeAccount(bin)
  if (!account.ok) return { ok: false, error: account.reason }
  const { code, signal, stdout, stderr, timedOut } = await run(bin, judgeArgs({ model, system, schema }), prompt, timeoutMs)
  if (timedOut) return { ok: false, error: `no answer within ${Math.round(timeoutMs / 60_000) || 1} min, so it was stopped. Try again; a very large PR or a slower model (Opus) takes longer.` }
  // 143 = 128 + SIGTERM: stopped from outside (quit, logout, sleep) before it answered.
  if (signal || code === 143 || code === 137) return { ok: false, error: `it was stopped before it answered (${signal ?? `exit ${code}`}). Try again.` }
  /** @type {any} */ let json = null
  try {
    json = JSON.parse(stdout)
  } catch {
    // fall through with the exit code / stderr
  }
  if (!json) return { ok: false, error: (stderr || stdout).trim().split('\n').slice(-1)[0] || `claude exited ${code}` }
  if (json.is_error || json.subtype !== 'success') return { ok: false, error: String(json.result || json.subtype || 'failed') }
  if (json.structured_output) return { ok: true, output: json.structured_output }
  try {
    return { ok: true, output: JSON.parse(json.result) }
  } catch {
    return { ok: false, error: 'Claude Code answered without the expected JSON' }
  }
}

/**
 * Run macOS `security`, optionally feeding it commands on stdin (`-i`).
 * @param {string[]} args
 * @param {string} [input]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function security(args, input, bin = process.env.PR_TRACKER_SECURITY || '/usr/bin/security') {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin.end(input ?? '')
  })
}

/**
 * The Keychain side: read, write or delete one token.
 * @param {any} request
 * @returns {Promise<{ok: true, value?: string} | {ok: false, error: string}>}
 */
export async function secret(request) {
  const name = request?.name
  if (!SECRET_NAMES.has(name)) return { ok: false, error: 'unknown secret' }
  const base = ['-s', process.env.PR_TRACKER_KEYCHAIN_SERVICE || KEYCHAIN_SERVICE, '-a', name]
  if (request.type === 'secret-get') {
    const r = await security(['find-generic-password', ...base, '-w'])
    if (r.code === 44) return { ok: true, value: '' } // not found
    if (r.code !== 0) return { ok: false, error: `Keychain: ${r.stderr.trim() || `security exited ${r.code}`}` }
    return { ok: true, value: r.stdout.replace(/\n$/, '') }
  }
  if (request.type === 'secret-delete') {
    const r = await security(['delete-generic-password', ...base])
    return r.code === 0 || r.code === 44 ? { ok: true } : { ok: false, error: `Keychain: ${r.stderr.trim() || `security exited ${r.code}`}` }
  }
  const value = request.value
  if (typeof value !== 'string' || !SECRET_VALUE.test(value)) return { ok: false, error: "That token has characters PR Tracker doesn't expect" }
  // Interactive mode reads the command from stdin, so the token never shows in `ps`.
  await security(['-i'], `add-generic-password -U ${base.join(' ')} -w "${value}"\n`)
  const back = await security(['find-generic-password', ...base, '-w'])
  return back.code === 0 && back.stdout.replace(/\n$/, '') === value ? { ok: true } : { ok: false, error: `Keychain: couldn't save the token (${back.stderr.trim() || back.code})` }
}

/** @param {unknown} message */
function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  process.stdout.write(Buffer.concat([head, body]))
}

/** @param {any} request */
export function handle(request, root = ROOT, cacheFile = CACHE) {
  if (request?.type === 'ping') return claudeAccount().then((account) => ({ ok: true, version: VERSION, claude: !!findClaude(), keychain: true, account }))
  if (/^secret-(?:get|set|delete)$/.test(String(request?.type))) return secret(request)
  if (request?.type === 'judge') return judge(request)
  if (request?.type !== 'sessions' || !Array.isArray(request.prs)) return { ok: false, error: 'unknown request' }
  /** @type {Record<string, import('./scan.mjs').FileIndex>} */
  let cache = {}
  try {
    cache = JSON.parse(readFileSync(cacheFile, 'utf8'))
  } catch {
    // first run, or a corrupt cache: rebuild
  }
  const index = indexAll(root, cache)
  try {
    // Private to this user: session titles and project paths can be sensitive.
    mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 })
    writeFileSync(cacheFile, JSON.stringify(index), { mode: 0o600 })
    chmodSync(cacheFile, 0o600) // an older cache was created world-readable
  } catch {
    // a read-only home still answers, just slower next time
  }
  const prs = request.prs.filter((/** @type {unknown} */ k) => typeof k === 'string').slice(0, 500)
  const own = Object.fromEntries(Object.entries(index).filter(([, e]) => e.cwd !== SELF && !e.cwd.startsWith(`${SELF}/`)))
  return { ok: true, sessions: sessionsFor(own, prs) }
}

// Read framed messages until Chrome closes stdin.
/** Run as a program (not imported by a test)? Compares real paths: /var vs /private/var, symlinks. */
function isMain() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? '')
  } catch {
    return false
  }
}

if (isMain()) {
  let buffer = Buffer.alloc(0)
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0)
      if (buffer.length < 4 + size) break
      const raw = buffer.subarray(4, 4 + size).toString('utf8')
      buffer = buffer.subarray(4 + size)
      Promise.resolve()
        .then(() => /** @type {Promise<unknown> | unknown} */ (handle(JSON.parse(raw))))
        .then(send, (error) => send({ ok: false, error: String(error) }))
    }
  })
}
