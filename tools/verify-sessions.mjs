/**
 * Browser check for the Claude Code session link, end to end with the real
 * native helper: a copy of the extension with nativeMessaging granted, the
 * helper registered in the throwaway profile's NativeMessagingHosts, and a
 * fake ~/.claude/projects (CLAUDE_CONFIG_DIR) holding one session that
 * reviewed fixture PR acme/api#101.
 *
 *   node tools/verify-sessions.mjs [--headed]
 */

import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const SESSION = '57609ddd-15b6-4739-a098-97387dc48b05'
let checks = 0
let failures = 0
/** @param {string} label @param {boolean} ok @param {string} [detail] */
function check(label, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '✔' : '✘'} ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const work = mkdtempSync(path.join(tmpdir(), 'pr-tracker-sessions-'))
const ext = path.join(work, 'ext')
cpSync(ROOT, ext, { recursive: true, filter: (src) => !/node_modules|\.git(\/|$)|\/dist(\/|$)/.test(src) })
const manifest = JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf8'))
manifest.permissions = [...manifest.permissions, 'nativeMessaging']
manifest.optional_permissions = []
writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2))

// A fake Claude Code home with one session that reviewed acme/api#101.
const claudeHome = path.join(work, 'claude')
mkdirSync(path.join(claudeHome, 'projects', '-work-api'), { recursive: true })
writeFileSync(
  path.join(claudeHome, 'projects', '-work-api', `${SESSION}.jsonl`),
  [
    JSON.stringify({ type: 'user', cwd: '/work/api', timestamp: '2026-09-20T01:00:00Z', message: { content: '/code-review review this PR https://github.com/acme/api/pull/101' } }),
    JSON.stringify({ type: 'custom-title', customTitle: 'Review caching PR' }),
  ].join('\n'),
)

// Marker in one fixture comment, as the hook would have added it.
const fixture = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/dashboard.json'), 'utf8'))
const thread = fixture.data.mine.nodes[0].reviewThreads.nodes[0].comments.nodes[0]
thread.body = `${thread.body}\n\n<!-- claude-code-session: ${SESSION} -->`

const profile = path.join(work, 'profile')
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, HOME: work },
})
try {
  await context.route('https://api.github.com/graphql', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) }))
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const id = new URL(sw.url()).host

  // Register the helper for this profile, as install.sh does for real Chrome.
  const runner = path.join(work, 'host-run.sh')
  // A stand-in claude CLI for Summarize: prints a fixed judgement, records the prompt.
  const fakeClaude = path.join(work, 'claude-bin')
  writeFileSync(fakeClaude, `#!/bin/sh\ncat > "${work}/claude-stdin"\nprintf '%s' '${JSON.stringify({ subtype: 'success', is_error: false, structured_output: { summary: 'Judged locally.', verdicts: [] } })}'\n`)
  chmodSync(fakeClaude, 0o755)
  writeFileSync(runner, `#!/bin/sh\nexport PR_TRACKER_CLAUDE="${fakeClaude}"\nexec "${process.execPath}" "${path.join(ext, 'native/host.mjs')}" "$@"\n`)
  chmodSync(runner, 0o755)
  mkdirSync(path.join(profile, 'NativeMessagingHosts'), { recursive: true })
  writeFileSync(
    path.join(profile, 'NativeMessagingHosts', 'com.gdncomm.pr_tracker.json'),
    JSON.stringify({ name: 'com.gdncomm.pr_tracker', description: 'test', path: runner, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] }),
  )

  const page = await context.newPage()
  /** @type {string[]} */ const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`chrome-extension://${id}/pages/app.html`)
  await page.waitForFunction(() => !!document.querySelector('#cc-install')?.textContent)
  check('Settings shows the install command with this extension id', ((await page.textContent('#cc-install')) ?? '') === `sh native/install.sh ${id}`, (await page.textContent('#cc-install')) ?? '')
  await page.fill('#token', 'x')
  await page.click('#settings button[type=submit]')
  await page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh' && document.querySelector('article.pr'))
  await page.click('#tab-mine')

  console.log('\nPR Tracker — Claude Code sessions')
  const card = page.locator('article.pr', { hasText: '#101 ' })
  check('the PR gets a Claude Code chip with the session count', ((await card.locator('.chip.c-cc').textContent()) ?? '') === 'Claude Code · 1', (await card.locator('.chip.c-cc').textContent()) ?? '')
  await card.locator('summary').click()
  const row = card.locator('.cc-sessions li').first()
  check('the session is listed as a review, with its title and project', ((await row.textContent()) ?? '').startsWith('ReviewedReview caching PRapi'), (await row.textContent()) ?? '')
  // Capture what gets copied (the headless clipboard can't be read back).
  await page.evaluate(() => {
    navigator.clipboard.writeText = async (text) => void (/** @type {any} */ (window).copied = text)
  })
  await row.locator('.cc-copy').click()
  const copied = await page.evaluate(() => /** @type {any} */ (window).copied)
  check('copy gives a working resume command', copied === `cd '/work/api' && claude --resume ${SESSION}`, copied)
  const marked = card.locator('.finding .cc:not([hidden])').first()
  check('the comment carrying the marker says Claude Code', (await marked.count()) === 1 && ((await marked.textContent()) ?? '') === 'Claude Code')
  check('and resumes in the project the helper knows', ((await marked.getAttribute('title')) ?? '').startsWith(`cd '/work/api' && claude --resume ${SESSION}`))
  await page.click('#toggle-settings')
  check('Settings says the helper is connected', ((await page.textContent('#cc-status')) ?? '').startsWith('Connected — sessions are looked up'), (await page.textContent('#cc-status')) ?? '')

  console.log('\nPR Tracker — Summarize via Claude Code')
  await page.selectOption('#claude-via', 'claude-code')
  check('choosing Claude Code hides the API key field', await page.locator('#claude-key').isHidden())
  await page.click('#settings button[type=submit]')
  await page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh')
  const ask = card.locator('.ai-ask:not([hidden])')
  check('Summarize is offered without an API key', (await ask.count()) === 1)
  await ask.click()
  await page.waitForFunction(() => [...document.querySelectorAll('.ai-summary-text')].some((e) => e.textContent === 'Judged locally.'), null, { timeout: 30000 }).catch(() => {})
  check("the summary comes from the local claude run", ((await card.locator('.ai-summary-text').textContent()) ?? '') === 'Judged locally.', (await card.locator('.ai-summary-text').textContent()) ?? '')
  let stdin = ''
  try {
    stdin = readFileSync(path.join(work, 'claude-stdin'), 'utf8')
  } catch {
    // not run
  }
  check('claude got the PR description on stdin', stdin.includes('Comment id='), stdin.slice(0, 80))
  check('no page errors', errors.length === 0, errors[0])
} finally {
  await context.close()
  rmSync(work, { recursive: true, force: true })
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
