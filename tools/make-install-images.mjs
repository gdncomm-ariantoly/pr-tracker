/**
 * Regenerates the step images on the install page (docs/steps/*.png) from a
 * real Chromium with the extension loaded: chrome://extensions (Developer
 * mode, Load unpacked), the first-run Settings pop-up, and the Claude Code
 * helper's Connect button. Sample data only; nothing is signed in.
 *
 *   node tools/make-install-images.mjs [--headed]
 *
 * GitHub's token page, Jenkins and the browser toolbar (pinning) can't be
 * captured this way — they need a login or are browser UI — so those steps
 * stay text-only.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

import { loadFixture } from './fixture.mjs'

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const OUT = path.join(ROOT, 'docs/steps')
const work = mkdtempSync(path.join(tmpdir(), 'pr-tracker-steps-'))
mkdirSync(OUT, { recursive: true })

/** Draw a ring around the element the step is about (works inside shadow DOM). @param {import('@playwright/test').Locator} target */
const ring = (target) =>
  target.evaluate((el) => {
    const e = /** @type {HTMLElement} */ (el)
    e.style.outline = '3px solid #e5534b'
    e.style.outlineOffset = '4px'
    e.style.borderRadius = e.style.borderRadius || '8px'
  })

/** @param {import('@playwright/test').Locator} target */
const unring = (target) => target.evaluate((el) => (/** @type {HTMLElement} */ (el).style.outline = ''))

const context = await chromium.launchPersistentContext(path.join(work, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  // Narrow enough that chrome://extensions folds its sidebar away.
  viewport: { width: 760, height: 460 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
})
try {
  const fixture = JSON.stringify(loadFixture())
  await context.route('https://api.github.com/graphql', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: fixture }))
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const id = new URL(sw.url()).host

  // Steps 2–3: chrome://extensions.
  const ext = context.pages()[0] ?? (await context.newPage())
  await ext.goto('chrome://extensions')
  const devMode = ext.locator('#devMode')
  await devMode.waitFor()
  if ((await devMode.getAttribute('aria-pressed')) !== 'true') await devMode.click()
  const loadUnpacked = ext.locator('#loadUnpacked')
  await loadUnpacked.waitFor()
  await ext.waitForTimeout(400) // the toggle animates
  await ring(devMode)
  await ext.screenshot({ path: path.join(OUT, 'developer-mode.png') })
  await unring(devMode)
  await ring(loadUnpacked)
  await ext.screenshot({ path: path.join(OUT, 'load-unpacked.png') })

  // Step 7: the first-run Settings pop-up.
  const page = await context.newPage()
  await page.setViewportSize({ width: 900, height: 560 })
  await page.goto(`chrome-extension://${id}/pages/app.html`)
  const dialog = page.locator('#settings-dialog')
  await dialog.waitFor()
  // showModal() focuses the first button (×); a focus ring there would distract.
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur())
  await ring(page.locator('#token'))
  await ring(page.locator('#settings button[type=submit]'))
  await page.screenshot({ path: path.join(OUT, 'paste-token.png') })

  // Step 12: Settings → Claude Code helper → Connect.
  await page.setViewportSize({ width: 900, height: 600 })
  await unring(page.locator('#token'))
  await unring(page.locator('#settings button[type=submit]'))
  const helper = page.locator('.cc-setup', { has: page.locator('#cc-connect') })
  await helper.scrollIntoViewIfNeeded()
  await ring(page.locator('#cc-connect'))
  const box = await helper.boundingBox()
  if (!box) throw new Error('Claude Code helper section not laid out')
  const pad = 14
  await page.screenshot({ path: path.join(OUT, 'connect.png'), clip: { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad } })

  console.log(`Wrote ${OUT}/{developer-mode,load-unpacked,paste-token,connect}.png`)
} finally {
  await context.close()
  rmSync(work, { recursive: true, force: true })
}
