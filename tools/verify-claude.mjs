/**
 * Browser check for Claude judging comments and summarising PRs.
 *
 * Like verify-jenkins.mjs, loads a copy of the extension with api.anthropic.com
 * already granted (Playwright can't click Chrome's permission prompt). GitHub
 * is replayed from the fixture; the Anthropic API is replayed too: every
 * comment it's shown comes back "fixed", except the first, which stays
 * "unfixed".
 *
 *   node tools/verify-claude.mjs [--headed]
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
manifest.host_permissions = [...manifest.host_permissions, 'https://api.anthropic.com/*']
writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2))
const fixture = readFileSync(path.join(ROOT, 'tests/fixtures/dashboard.json'), 'utf8')

const context = await chromium.launchPersistentContext(path.join(work, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
})
try {
  await context.route('https://api.github.com/graphql', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: fixture }))
  /** @type {{headers: Record<string, string>, body: any}[]} */ const calls = []
  await context.route('https://api.anthropic.com/v1/messages', async (route) => {
    const headers = await route.request().allHeaders()
    const body = JSON.parse(route.request().postData() ?? '{}')
    calls.push({ headers, body })
    if (headers['x-api-key'] !== 'sk-ant-good') return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'invalid x-api-key' } }) })
    const ids = [...String(body.messages?.[0]?.content ?? '').matchAll(/Comment id=(\S+)/g)].map((m) => m[1])
    const verdicts = ids.map((id, i) => ({ id, verdict: i === 0 ? 'unfixed' : 'fixed', reason: i === 0 ? 'Nothing in the commits touches this.' : 'A later commit covers it.' }))
    const judgement = { summary: `Claude summary: ${ids.length} comments looked at.`, verdicts }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(judgement) }] }) })
  })

  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const id = new URL(sw.url()).host
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
  check('without a key, Claude is never asked', calls.length === 0, `${calls.length} calls`)
  check('without a key, no summaries and no Claude statuses', (await page.locator('.ai-summary:not([hidden])').count()) === 0 && (await page.locator('.status.by-claude').count()) === 0)

  await page.click('#toggle-settings')
  check('Sonnet 5 is the default model, asking only on demand', (await page.inputValue('#claude-model')) === 'claude-sonnet-5' && !(await page.isChecked('#claude-auto')))
  await page.fill('#claude-key', 'sk-ant-good')
  await page.click('#settings button[type=submit]')
  await settled()
  check('on demand: a refresh asks Claude nothing', calls.length === 0, `${calls.length} calls`)
  const ask = page.locator('.ai-ask:not([hidden])').first()
  check('PRs with comments offer "Summarize with Claude"', ((await ask.textContent()) ?? '') === 'Summarize with Claude')
  const askedCard = page.locator('article.pr', { has: ask }).first()
  const askedId = await askedCard.getAttribute('data-id')
  const openBefore = await askedCard.locator('details').evaluate((d) => /** @type {HTMLDetailsElement} */ (d).open)
  await ask.click()
  const pinned = page.locator(`article.pr[data-id="${askedId}"]`).first()
  await pinned.locator('.ai-summary-text').filter({ hasText: 'Claude summary' }).waitFor()
  check('clicking it asks about that PR only and shows the summary', calls.length === 1)
  check('without toggling the card open or shut', (await pinned.locator('details').evaluate((d) => /** @type {HTMLDetailsElement} */ (d).open)) === openBefore)
  await page.click('#refresh')
  await settled()
  check('the answer survives a refresh without a new call', calls.length === 1 && ((await pinned.locator('.ai-summary-text').textContent()) ?? '').startsWith('Claude summary'))

  // Automatic from here on.
  await page.click('#toggle-settings')
  await page.check('#claude-auto')
  await page.selectOption('#claude-model', 'claude-opus-5-5')
  await page.click('#settings button[type=submit]')
  await settled()
  await openAll()
  calls.splice(0, 1)
  const first = calls[0]
  check('key, API version and browser-access header sent', first?.headers['x-api-key'] === 'sk-ant-good' && first.headers['anthropic-version'] === '2023-06-01' && first.headers['anthropic-dangerous-direct-browser-access'] === 'true')
  check('the chosen model is used, with JSON-schema output', first?.body.model === 'claude-opus-5-5' && first.body.output_config?.format?.type === 'json_schema')
  const judged = await page.evaluate(async () => {
    const { snapshot } = await chrome.storage.local.get('snapshot')
    const s = /** @type {any} */ (snapshot)
    return new Set([...s.mine, ...s.toReview].filter((p) => p.hasHumanComments).map((p) => p.id)).size
  })
  check('one call per PR with comments', calls.length === judged, `${calls.length} calls for ${judged} PRs`)
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

  const before = calls.length
  await page.click('#refresh')
  await settled()
  check('nothing changed: no new Claude calls on refresh', calls.length === before, `${calls.length - before} new`)

  await page.click('#toggle-settings')
  await page.fill('#claude-key', 'sk-ant-bad')
  await page.selectOption('#claude-model', 'claude-haiku-4-5') // new model: new signature, asked again
  await page.click('#settings button[type=submit]')
  await settled()
  check('a rejected key says so', await page.isVisible('#claude-bad-key'))
  await page.click('#toggle-settings')
  await page.click('#claude-key-clear')
  await settled()
  check('removing the key drops the banner and the summaries', (await page.isHidden('#claude-bad-key')) && (await page.locator('.ai-summary:not([hidden])').count()) === 0)
  check('no page errors', errors.length === 0, errors[0])
} finally {
  await context.close()
  rmSync(work, { recursive: true, force: true })
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
