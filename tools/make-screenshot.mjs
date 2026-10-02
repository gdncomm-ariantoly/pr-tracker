/**
 * Regenerates docs/screenshot.png for the install page: the fixture dashboard
 * on My PRs, PR #101 open (approvals, a Claude summary, comments grouped),
 * with a few entries in the Updates panel. Sample data only.
 *
 *   node tools/make-screenshot.mjs [out.png] [--headed]
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

import { loadFixture } from './fixture.mjs'

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const out = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? path.join(ROOT, 'docs/screenshot.png')
const fixture = JSON.stringify(loadFixture())
const work = mkdtempSync(path.join(tmpdir(), 'pr-tracker-shot-'))

const context = await chromium.launchPersistentContext(path.join(work, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  viewport: { width: 1360, height: 820 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
})
try {
  await context.route('https://api.github.com/graphql', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: fixture }))
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const page = await context.newPage()
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/pages/app.html`)
  await page.fill('#token', 'x')
  await page.click('#settings button[type=submit]')
  await page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh' && document.querySelector('article.pr'))

  // A Claude summary on #101 and some updates, as a few days of use would leave them.
  await page.evaluate(async () => {
    const { snapshot } = /** @type {any} */ (await chrome.storage.local.get('snapshot'))
    for (const pr of snapshot.mine) if (pr.number === 101) pr.aiSummary = 'One naming comment is still open; the cache TTL question was answered in the thread.'
    // The fixture carries layout stress tests (unbroken words, endless code lines, hostile HTML); not for a picture.
    const tidy = (/** @type {any} */ o) => {
      for (const k of ['bodyHTML', 'body']) {
        if (typeof o?.[k] !== 'string') continue
        o[k] = o[k].replace(/<p>[^<]*averyvery[^<]*<\/p>/g, '').replace(/\S*averyvery\S*/g, '').replace(/<\/p><img[^]*$/, '</p>').replace(/ \/\/ evicted-after[^<]*/g, '')
      }
      for (const v of Object.values(o ?? {})) if (v && typeof v === 'object') tidy(v)
    }
    tidy(snapshot)
    const at = (/** @type {number} */ minutes) => new Date(Date.now() - minutes * 60_000).toISOString()
    const inbox = [
      { key: 'a', url: 'https://github.com/acme/api/pull/101', title: 'acme/api#101 Add caching to product lookup', context: 'My PR', message: 'bob approved', side: 'mine', at: at(4), read: false },
      { key: 'b', url: 'https://github.com/acme/api/pull/103', title: 'acme/api#103 Refactor pricing rules', context: 'To review', message: 'Your review was requested', side: 'toReview', at: at(38), read: false },
      { key: 'c', url: 'https://github.com/acme/api/pull/104', title: 'acme/api#104 Fix timezone in reports', context: 'To review', message: 'Your comment was fixed by a commit', side: 'toReview', at: at(170), read: true },
    ]
    await chrome.storage.local.set({ snapshot, inbox })
  })
  await page.reload()
  await page.waitForFunction(() => document.querySelector('article.pr'))
  await page.click('#tab-mine')
  await page.locator('article.pr', { hasText: '#101 ' }).locator('summary').click()
  await page.mouse.move(0, 0)
  await page.screenshot({ path: out })
  console.log(`Saved ${out}`)
} finally {
  await context.close()
  rmSync(work, { recursive: true, force: true })
}
