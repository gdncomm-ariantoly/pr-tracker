/**
 * Browser check for the Claude Code session link, end to end with the real
 * native helper: a copy of the extension with nativeMessaging granted, the
 * helper registered in the throwaway profile's NativeMessagingHosts, and a
 * fake ~/.claude/projects (CLAUDE_CONFIG_DIR) holding one session that
 * reviewed fixture PR acme/api#101.
 *
 *   node tools/verify-sessions.mjs [--headed]
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

import { loadFixture } from './fixture.mjs'

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const SESSION = '57609ddd-15b6-4739-a098-97387dc48b05'
const KEYCHAIN_TEST = `com.gdncomm.pr-tracker.verify-${process.pid}`
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
const fixture = loadFixture()
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
  /** @type {string[]} */ const githubAuth = []
  await context.route('https://api.github.com/graphql', (r) => (githubAuth.push(r.request().headers().authorization ?? ''), r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) })))
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const id = new URL(sw.url()).host

  // Register the helper for this profile, as install.sh does for real Chrome.
  const runner = path.join(work, 'host-run.sh')
  // A stand-in claude CLI for Summarize: prints a fixed judgement, records the prompt.
  const fakeClaude = path.join(work, 'claude-bin')
  writeFileSync(fakeClaude, `#!/bin/sh\nif [ "$1" = auth ]; then printf '%s' '${JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'team', orgName: 'acme' })}'; exit 0; fi\ncat > "${work}/claude-stdin"\nprintf '%s' '${JSON.stringify({ subtype: 'success', is_error: false, structured_output: { summary: 'Judged locally.', verdicts: [] } })}'\n`)
  chmodSync(fakeClaude, 0o755)
  // A throwaway Keychain service, so the real PR Tracker items are never touched.
  writeFileSync(runner, `#!/bin/sh\nexport PR_TRACKER_CLAUDE="${fakeClaude}"\nexport PR_TRACKER_KEYCHAIN_SERVICE="${KEYCHAIN_TEST}"\nexport HOME="${homedir()}"\nexport PR_TRACKER_CACHE="${path.join(work, 'cache.json')}"\nexec "${process.execPath}" "${path.join(ext, 'native/host.mjs')}" "$@"\n`)
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
  await page.click('#settings-close')

  console.log('\nPR Tracker — Summarize via Claude Code')
  const ask = card.locator('.ai-ask:not([hidden])')
  check('Summarize is offered once the helper is connected', (await ask.count()) === 1)
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

  console.log('\nPR Tracker — tokens in the macOS Keychain')
  const stored = async () => /** @type {any} */ (await page.evaluate(async () => (await chrome.storage.local.get('settings')).settings))
  /** Wait until Save has written settings matching `ok`, and the refresh after it has finished. @param {(s: any) => boolean} ok */
  const saved = async (ok) => {
    for (let i = 0; i < 60 && !ok(await stored()); i++) await page.waitForTimeout(100)
    await page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh')
  }
  const openSettings = async () => {
    if (await page.isHidden('#settings')) await page.click('#toggle-settings')
  }
  await openSettings()
  check('the Keychain option is offered once the helper is connected', await page.isEnabled('#keychain'))
  await page.check('#keychain')
  await page.fill('#token', 'not a token!')
  await page.click('#settings button[type=submit]')
  await page.waitForFunction(() => !!document.querySelector('#settings-error:not([hidden])')?.textContent)
  check('a Keychain failure is shown in Settings and nothing is saved', ((await page.textContent('#settings-error')) ?? '').includes('Keychain') && (await page.isVisible('#settings')) && (await stored()).keychain !== true, (await page.textContent('#settings-error')) ?? '')
  await openSettings()
  await page.fill('#token', 'github_pat_keychain_test')
  await page.click('#settings button[type=submit]')
  await saved((x) => x.keychain === true)
  for (let i = 0; i < 30 && githubAuth.at(-1) !== 'Bearer github_pat_keychain_test'; i++) await page.waitForTimeout(100)
  const s1 = await stored()
  check("Chrome's storage keeps only a reference, not the token", s1.token === '@keychain' && s1.keychain === true, JSON.stringify({ token: s1.token, error: await page.textContent('#error') }))
  const inKeychain = execFileSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_TEST, '-a', 'github', '-w']).toString().trim()
  check('the token is in the Keychain', inKeychain === 'github_pat_keychain_test')
  check('refreshes use it, read through the helper', githubAuth.at(-1) === 'Bearer github_pat_keychain_test', githubAuth.at(-1))
  await openSettings()
  await page.uncheck('#keychain')
  await page.click('#settings button[type=submit]')
  await saved((x) => x.keychain === false)
  const s2 = await stored()
  let gone = false
  try {
    execFileSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_TEST, '-a', 'github'], { stdio: 'pipe' })
  } catch {
    gone = true
  }
  check('unticking moves it back and deletes it from the Keychain', s2.token === 'github_pat_keychain_test' && !s2.keychain && gone)
  check('no page errors', errors.length === 0, errors[0])
} finally {
  for (const name of ['github', 'jenkins']) {
    try {
      execFileSync('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_TEST, '-a', name], { stdio: 'pipe' })
    } catch {
      // not there
    }
  }
  await context.close()
  rmSync(work, { recursive: true, force: true })
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
