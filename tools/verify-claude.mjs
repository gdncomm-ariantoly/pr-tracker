/**
 * Browser check for Claude judging comments and summarising PRs.
 *
 * Loads a copy of the extension with nativeMessaging granted (Playwright
 * can't click Chrome's permission prompt), the real helper registered in the
 * throwaway profile, and a stand-in `claude` CLI behind it: every comment it's
 * shown comes back "fixed", except the first, which stays "unfixed". GitHub is
 * replayed from the fixture.
 *
 *   node tools/verify-claude.mjs [--headed]
 */

import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
let checks = 0
let failures = 0
/** @param {string} label @param {boolean} ok @param {string} [detail] */
function check(label, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '✔' : '✘'} ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const work = mkdtempSync(path.join(tmpdir(), 'pr-tracker-claude-'))
const ext = path.join(work, 'ext')
cpSync(ROOT, ext, { recursive: true, filter: (src) => !/node_modules|\.git(\/|$)|\/dist(\/|$)/.test(src) })
const manifest = JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf8'))
manifest.permissions = [...manifest.permissions, 'nativeMessaging']
manifest.optional_permissions = []
writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2))

// The stand-in claude CLI: logs each run (model + prompt), answers from the prompt's comment ids.
const calls = path.join(work, 'calls.jsonl')
const fakeClaude = path.join(work, 'claude-bin')
writeFileSync(fakeClaude, `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'auth') {
  process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(work, 'auth.json'))}, 'utf8'))
  process.exit(0)
}
const prompt = fs.readFileSync(0, 'utf8')
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ model: args[args.indexOf('--model') + 1], tools: args[args.indexOf('--tools') + 1], prompt }) + '\\n')
const ids = [...prompt.matchAll(/Comment id=(\\S+)/g)].map((m) => m[1])
const verdicts = ids.map((id, i) => ({ id, verdict: i === 0 ? 'unfixed' : 'fixed', reason: i === 0 ? 'Nothing in the commits touches this.' : 'A later commit covers it.' }))
process.stdout.write(JSON.stringify({ subtype: 'success', is_error: false, structured_output: { summary: 'Claude summary: ' + ids.length + ' comments looked at.', verdicts } }))
`)
chmodSync(fakeClaude, 0o755)
/** What `claude auth status` reports; the run switches it to a personal plan later. @param {string} plan */
const signIn = (plan) => writeFileSync(path.join(work, 'auth.json'), JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: plan, orgName: plan === 'team' ? 'acme' : undefined }))
signIn('team')
/** @returns {{model: string, tools: string, prompt: string}[]} */
const runs = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const fixture = readFileSync(path.join(ROOT, 'tests/fixtures/dashboard.json'), 'utf8')

const context = await chromium.launchPersistentContext(path.join(work, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
})
try {
  await context.route('https://api.github.com/graphql', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: fixture }))
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const id = new URL(sw.url()).host
  // Register the helper for this profile, as install.sh does for real Chrome, pointing at the stand-in claude.
  const runner = path.join(work, 'host-run.sh')
  writeFileSync(runner, `#!/bin/sh\nexport PR_TRACKER_CLAUDE="${fakeClaude}"\nexec "${process.execPath}" "${path.join(ext, 'native/host.mjs')}" "$@"\n`)
  chmodSync(runner, 0o755)
  mkdirSync(path.join(work, 'profile', 'NativeMessagingHosts'), { recursive: true })
  writeFileSync(path.join(work, 'profile', 'NativeMessagingHosts', 'com.gdncomm.pr_tracker.json'), JSON.stringify({ name: 'com.gdncomm.pr_tracker', description: 'test', path: runner, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] }))
  const page = await context.newPage()
  /** @type {string[]} */ const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const settled = () => page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh')
  const openAll = () => page.evaluate(() => document.querySelectorAll('details').forEach((d) => d.setAttribute('open', '')))

  await page.goto(`chrome-extension://${id}/pages/app.html`)
  await page.fill('#token', 'x')
  await page.click('#settings button[type=submit]')
  await page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh' && document.querySelector('article.pr'))
  await page.click('#tab-mine')

  console.log('\nPR Tracker — Claude')
  await page.click('#toggle-settings')
  check('no API key field any more: Claude runs through Claude Code only', (await page.locator('#claude-key, #claude-via').count()) === 0)
  check('Sonnet 5 is the default model, asking only on demand', (await page.inputValue('#claude-model')) === 'claude-sonnet-5' && !(await page.isChecked('#claude-auto')))
  const autoRow = await page.evaluate(() => {
    const label = /** @type {HTMLElement} */ (document.querySelector('#claude-auto')?.closest('label'))
    const text = /** @type {HTMLElement} */ (label.querySelector('span'))
    return { lines: Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight || '20')), em: getComputedStyle(label).display, emInline: getComputedStyle(/** @type {HTMLElement} */ (label.querySelector('em'))).display }
  })
  check('the "Ask automatically" option reads as one sentence, not columns', autoRow.emInline === 'inline', JSON.stringify(autoRow))
  await page.click('#settings button[type=submit]')
  await settled()
  check('on demand: a refresh asks Claude nothing', runs().length === 0, `${runs().length} calls`)
  const ask = page.locator('.ai-ask:not([hidden])').first()
  check('PRs with comments offer "Summarize with Claude"', ((await ask.textContent()) ?? '') === 'Summarize with Claude')
  const askedCard = page.locator('article.pr', { has: ask }).first()
  const askedId = await askedCard.getAttribute('data-id')
  const openBefore = await askedCard.locator('details').evaluate((d) => /** @type {HTMLDetailsElement} */ (d).open)
  await ask.click()
  const pinned = page.locator(`article.pr[data-id="${askedId}"]`).first()
  await pinned.locator('.ai-summary-text').filter({ hasText: 'Claude summary' }).waitFor()
  check('clicking it asks about that PR only and shows the summary', runs().length === 1)
  check('without toggling the card open or shut', (await pinned.locator('details').evaluate((d) => /** @type {HTMLDetailsElement} */ (d).open)) === openBefore)
  await page.click('#refresh')
  await settled()
  check('the answer survives a refresh without a new call', runs().length === 1 && ((await pinned.locator('.ai-summary-text').textContent()) ?? '').startsWith('Claude summary'))

  // Automatic from here on.
  await page.click('#toggle-settings')
  await page.check('#claude-auto')
  await page.selectOption('#claude-model', 'claude-opus-5-5')
  await page.click('#settings button[type=submit]')
  await settled()
  await openAll()
  const auto = runs().slice(1)
  check('Claude Code runs with the chosen model and no tools', auto[0]?.model === 'claude-opus-5-5' && auto[0]?.tools === '', JSON.stringify(auto[0] && { model: auto[0].model, tools: auto[0].tools }))
  const judged = await page.evaluate(async () => {
    const { snapshot } = await chrome.storage.local.get('snapshot')
    const s = /** @type {any} */ (snapshot)
    return new Set([...s.mine, ...s.toReview].filter((p) => p.hasHumanComments).map((p) => p.id)).size
  })
  check('one run per PR with comments', auto.length === judged, `${auto.length} runs for ${judged} PRs`)
  const summary = page.locator('.ai-summary:not([hidden])').first()
  check('PR cards show Claude\'s summary, marked as Claude\'s', /^Claude summary: \d+ comments looked at\.$/.test(((await summary.locator('.ai-summary-text').textContent()) ?? '').trim()) && (await summary.locator('.ai-mark').isVisible()), (await summary.textContent()) ?? '')
  if (process.env.SHOT) await page.locator('article.pr', { has: summary }).first().screenshot({ path: process.env.SHOT })
  check('statuses say they came from Claude', (await page.locator('.status.by-claude').count()) > 0)
  const reason = page.locator('.evidence-text', { hasText: 'Claude: Nothing in the commits touches this.' })
  check('the reason is shown as the evidence', (await reason.count()) > 0)
  // Pin by id: marking it changes the evidence text the locator matched on.
  const cardId = await page.locator('.finding', { has: reason }).first().getAttribute('data-id')
  const card = page.locator(`.finding[data-id="${cardId}"]`).first()
  check('a Claude-unfixed comment still has the No action needed button', await card.locator('button.mark', { hasText: 'No action needed' }).isVisible())
  await card.locator('button.mark').click()
  check('and it works', ((await card.locator('.status').textContent()) ?? '').startsWith('No action needed'))

  const before = runs().length
  await page.click('#refresh')
  await settled()
  check('nothing changed: no new Claude runs on refresh', runs().length === before, `${runs().length - before} new`)


  // Signed in with a personal plan: nothing goes to Claude, and Settings says why.
  signIn('pro')
  const runsBefore = runs().length
  await page.click('#toggle-settings')
  await page.waitForFunction(() => (document.querySelector('#claude-account')?.textContent ?? '').includes('personal'))
  check('Settings names the account and why it is refused', ((await page.textContent('#claude-account')) ?? '').includes('personal Pro plan'), (await page.textContent('#claude-account')) ?? '')
  await page.selectOption('#claude-model', 'claude-haiku-4-5') // new model: every PR would be asked again
  await page.click('#settings button[type=submit]')
  await settled()
  check('a personal plan: no Claude run at all', runs().length === runsBefore, `${runs().length - runsBefore} runs`)
  check('and Summarize is no longer offered', (await page.locator('.ai-ask:not([hidden])').count()) === 0)
  check('no page errors', errors.length === 0, errors[0])
} finally {
  await context.close()
  rmSync(work, { recursive: true, force: true })
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
