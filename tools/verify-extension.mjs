/**
 * Loads the extension unpacked into a real Chromium and drives it.
 *
 * Copy this into the project (usually `tools/verify-extension.mjs`), point
 * EXTENSIONS at the directories, and replace `verify()` with the checks that
 * matter. Everything above that line is the part that is the same every time.
 *
 *   npm install -D @playwright/test && npx playwright install chromium
 *   node tools/verify-extension.mjs [--headed]
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)))

/** Directories to load, by the `name` in each manifest. */
const EXTENSIONS = {
  'PR Tracker': process.env.EXTENSION_DIR ?? ROOT,
}

const HEADED = process.argv.includes('--headed')

let checks = 0
let failures = 0

/**
 * @param {string} label
 * @param {boolean} condition
 * @param {string} [detail]
 */
function check(label, condition, detail = '') {
  checks += 1
  if (condition) console.log(`  ✔ ${label}`)
  else {
    failures += 1
    console.log(`  ✘ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * An unpacked extension's id is only knowable at runtime. It is the host of the
 * service worker's URL — but with more than one extension loaded, worker order
 * is not stable, so each candidate is confirmed by reading its manifest.
 *
 * @param {import('@playwright/test').BrowserContext} context
 * @param {string} name
 * @returns {Promise<string>}
 */
async function extensionId(context, name) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    for (const worker of context.serviceWorkers()) {
      const id = new URL(worker.url()).host
      const page = await context.newPage()
      try {
        const response = await page.goto(`chrome-extension://${id}/manifest.json`)
        if (JSON.parse((await response?.text()) ?? '{}').name === name) return id
      } finally {
        await page.close()
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`no service worker registered for extension "${name}" — check the card at chrome://extensions`)
}

/**
 * Opens a page and fails the run on any console error or uncaught exception —
 * which is how a CSP rejection and a bad import path both announce themselves.
 *
 * @param {import('@playwright/test').BrowserContext} context
 * @param {string} url
 */
async function openPage(context, url) {
  const page = await context.newPage()
  /** @type {string[]} */
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto(url)
  return { page, errors }
}

// ---------------------------------------------------------------------------
// Replace everything below with the checks for this extension.
// ---------------------------------------------------------------------------

/**
 * The GitHub API is replayed from a captured response (FIXTURE, default the
 * sanitised sample in tests/fixtures) so the run needs no token. Capture a real
 * one with:  gh api graphql --input <(node tools/print-query.mjs) > /tmp/d.json
 */
const FIXTURE = process.env.FIXTURE ?? path.join(ROOT, 'tests/fixtures/dashboard.json')

/**
 * @param {import('@playwright/test').BrowserContext} context
 * @param {string} id
 */
async function verify(context, id) {
  console.log('\nPR Tracker')
  const { readFileSync } = await import('node:fs')
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  /** @type {string[]} */
  const authHeaders = []
  let mode = 'ok'
  await context.route('https://api.github.com/graphql', async (route) => {
    authHeaders.push(route.request().headers().authorization ?? '')
    if (mode === 'sso') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ errors: [{ message: 'Resource protected by organization SAML enforcement.' }] }) })
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) })
    }
  })

  const { page, errors } = await openPage(context, `chrome-extension://${id}/pages/app.html`)
  await page.waitForSelector('#empty:not([hidden])')
  check('page loads with no console errors', errors.length === 0, errors[0])
  check('first run opens Settings (no token yet)', await page.isVisible('#settings'))
  check('no request made without a token', authHeaders.length === 0)

  await page.fill('#token', 'test-token')
  await page.click('#settings button[type=submit]')
  await page.waitForSelector('article.pr')
  check('token is sent as Bearer', authHeaders[0] === 'Bearer test-token', authHeaders[0])
  check('settings form closes after save', !(await page.isVisible('#settings')))
  check('token field is cleared after save', (await page.inputValue('#token')) === '')

  const data = fixture.data
  const nMine = data.mine.nodes.length
  const reviewIds = new Set([...data.requested.nodes, ...data.reviewed.nodes].map((/** @type {any} */ n) => n.id))
  check('To-review count matches', (await page.textContent('#n-toReview')) === String(reviewIds.size))
  check('My-PRs count matches', (await page.textContent('#n-mine')) === String(nMine))
  check('To-review tab renders its PRs', (await page.locator('article.pr').count()) === reviewIds.size)

  await page.click('#tab-mine')
  check('My PRs tab renders its PRs', (await page.locator('article.pr').count()) === nMine)
  const noHuman = await page.locator('article.pr .tally .chip', { hasText: 'No human comments' }).count()
  check('PRs without human comments are labelled', noHuman > 0)

  // Expand the first PR with findings and check one finding's anatomy.
  const withFindings = page.locator('article.pr').filter({ has: page.locator('.findings li') }).first()
  await withFindings.locator('summary').click()
  const first = withFindings.locator('.finding').first()
  check('finding shows a status', ((await first.locator('.status').textContent()) ?? '').length > 0)
  check('finding shows its author', ((await first.locator('.who').textContent()) ?? '').length > 0)
  check('finding shows evidence', ((await first.locator('.evidence').textContent()) ?? '').length > 0)
  check('finding links to GitHub', ((await first.locator('a.when').getAttribute('href')) ?? '').startsWith('https://github.com/'))
  check('bot comments are not listed', (await page.locator('.finding .who', { hasText: 'productivity-tools-services' }).count()) === 0)

  // The [hidden] trap: filter must actually hide cards.
  await page.check('#only-pending')
  const pendingCards = await page.locator('article.pr').count()
  const expected = await page.evaluate(async () => {
    const { snapshot } = await chrome.storage.local.get('snapshot')
    return /** @type {any} */ (snapshot).mine.filter((/** @type {any} */ p) => p.counts.pending > 0).length
  })
  check('"only unfixed" filter hides the rest', pendingCards === expected, `${pendingCards} vs ${expected}`)

  await page.reload()
  await page.waitForSelector('#list')
  await page.waitForTimeout(300)
  check('tab + filter survive reload', (await page.getAttribute('#tab-mine', 'aria-selected')) === 'true' && (await page.isChecked('#only-pending')))
  check('snapshot survives reload without refetch', (await page.locator('article.pr').count()) === expected)

  const badge = await context.serviceWorkers()[0].evaluate(() => chrome.action.getBadgeText({}))
  const requested = data.requested.nodes.length
  check('badge shows review-requested count', badge === (requested ? String(requested) : ''), JSON.stringify(badge))

  mode = 'sso'
  await page.click('#refresh')
  await page.waitForSelector('#error:not([hidden])')
  check('API error is shown', ((await page.textContent('#error')) ?? '').includes('SAML'))
  check('last good data kept on error', (await page.locator('article.pr').count()) === expected)

  check('no console errors across the run', errors.length === 0, errors[0])
  await page.close()
}

// ---------------------------------------------------------------------------

async function main() {
  const profile = mkdtempSync(path.join(tmpdir(), 'ext-verify-'))
  const dirs = Object.values(EXTENSIONS).join(',')

  const context = await chromium.launchPersistentContext(profile, {
    // Playwright's default `chromium_headless_shell` cannot load extensions at
    // all, and says nothing useful when asked to. `channel: 'chromium'` pins
    // the full browser, whose new headless mode can.
    channel: 'chromium',
    headless: !HEADED,
    args: [`--disable-extensions-except=${dirs}`, `--load-extension=${dirs}`],
  })

  try {
    for (const name of Object.keys(EXTENSIONS)) {
      const id = await extensionId(context, name)
      console.log(`Loaded ${name} (${id})`)
      await verify(context, id)
    }
  } finally {
    await context.close()
    rmSync(profile, { recursive: true, force: true })
  }

  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
