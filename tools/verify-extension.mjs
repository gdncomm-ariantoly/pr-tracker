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
    if (mode === 'saml-partial') {
      const empty = { ...fixture.data, mine: { issueCount: 0, nodes: [] }, requested: { issueCount: 0, nodes: [] }, reviewed: { issueCount: 0, nodes: [] } }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: empty, errors: [{ type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement.' }] }) })
    } else if (mode === 'sso') {
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
  // attached, not visible: every PR may be inside the collapsed Stale group
  await page.waitForSelector('article.pr', { state: 'attached' })
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

  // Grouping: one section per service, stale PRs in a collapsed group at the end.
  const expectedGroups = await page.evaluate(async () => {
    const { groupPRs } = await import('../lib/group.js')
    const { snapshot } = await chrome.storage.local.get('snapshot')
    const g = groupPRs(/** @type {any} */ (snapshot).mine)
    return { services: g.services.map((x) => x.name), stale: g.stale.length }
  })
  const shownGroups = await page.locator('section.group').evaluateAll((els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.group))
  check('PRs are grouped by service, alphabetically', JSON.stringify(shownGroups) === JSON.stringify(expectedGroups.services), `${shownGroups} vs ${expectedGroups.services}`)
  const staleBox = page.locator('details.group.stale')
  if (expectedGroups.stale) {
    check('stale PRs sit in a Stale group', (await staleBox.locator('article.pr').count()) === expectedGroups.stale)
    check('Stale group starts collapsed', !(await staleBox.evaluate((d) => /** @type {HTMLDetailsElement} */ (d).open)))
    check('Stale group is last', await page.locator('main > :last-child').evaluate((e) => e.classList.contains('stale')))
    await staleBox.locator(':scope > summary').click() // open it so the checks below can reach every card
  } else {
    check('no Stale group when nothing is stale', (await staleBox.count()) === 0)
  }
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

  // Manual "No action needed" on an unfixed comment: recount, survive reload, undo.
  const firstUnfixed = page.locator('article.pr').filter({ has: page.locator('.chip.c-pending') }).first()
  if (await firstUnfixed.count()) {
    // Pin by id: once its only unfixed comment is marked, a "has unfixed" locator would jump to another card.
    const unfixedCard = page.locator(`article.pr[data-id="${await firstUnfixed.getAttribute('data-id')}"]`)
    if (!(await unfixedCard.locator('details').evaluate((d) => /** @type {HTMLDetailsElement} */ (d).open))) await unfixedCard.locator('summary').click()
    const pendingBefore = await unfixedCard.locator('.finding[data-status=open], .finding[data-status=replied], .finding[data-status=commit-after]').count()
    const target = unfixedCard.locator('.finding').filter({ has: page.locator('button.mark', { hasText: 'No action needed' }) }).first()
    const id = await target.getAttribute('data-id')
    await target.locator('button.mark').click()
    const marked = page.locator(`.finding[data-id="${id}"]`)
    check('marking a comment switches it to No action needed', (await marked.locator('.status').textContent()) === 'No action needed')
    check('the PR stops counting it as unfixed', (await unfixedCard.locator('.finding[data-status=open], .finding[data-status=replied], .finding[data-status=commit-after]').count()) === pendingBefore - 1)
    const stored = await page.evaluate(() => chrome.storage.local.get('overrides'))
    check('the mark is saved', Object.keys(stored.overrides ?? {}).length === 1)
    await marked.locator('button.mark', { hasText: 'Undo' }).click()
    check('undo restores it', (await unfixedCard.locator('.finding[data-status=open], .finding[data-status=replied], .finding[data-status=commit-after]').count()) === pendingBefore)
  } else {
    check('fixture has an unfixed comment to mark', false)
  }

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

  // Updates → notifications. Serve a second response with one new human
  // comment on my first PR, and check the worker raised a notification for it.
  const worker = context.serviceWorkers()[0]
  const before = await worker.evaluate(() => chrome.notifications.getAll())
  check('no notifications on the first fetch', Object.keys(before).length === 0, JSON.stringify(before))
  const updated = structuredClone(fixture)
  const target = updated.data.mine.nodes[0]
  target.reviewThreads.nodes.push({
    id: 'T-new', isResolved: false, isOutdated: false, path: 'src/New.java', line: 7, resolvedBy: null,
    comments: { nodes: [{ id: 'C-new', author: { login: 'new-reviewer', __typename: 'User' }, body: 'Please handle the empty list.', createdAt: '2099-01-01T00:00:00Z', url: `${target.url}#discussion_rNEW` }] },
  })
  const original = fixture.data
  fixture.data = updated.data
  await page.click('#refresh')
  await page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh')
  /** @type {Record<string, unknown>} */
  let shown = {}
  for (let i = 0; i < 20 && Object.keys(shown).length === 0; i++) {
    await page.waitForTimeout(150)
    shown = await worker.evaluate(() => chrome.notifications.getAll())
  }
  const ids = Object.keys(shown)
  check('a new comment raises exactly one notification', ids.length === 1, JSON.stringify(ids))
  check('notification opens the comment on GitHub', ids[0]?.startsWith(`${target.url}#discussion_rNEW|`), ids[0])

  // Turning notifications off in Settings silences the next update.
  await worker.evaluate(() => chrome.notifications.getAll().then((all) => Promise.all(Object.keys(all).map((id) => chrome.notifications.clear(id)))))
  await page.click('#toggle-settings')
  await page.uncheck('#notify')
  await page.click('#settings button[type=submit]')
  await page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh')
  fixture.data = original // the comment "disappears", then comes back
  await page.click('#refresh')
  await page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh')
  fixture.data = updated.data
  await page.click('#refresh')
  await page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh')
  await page.waitForTimeout(500)
  const silenced = await worker.evaluate(() => chrome.notifications.getAll())
  check('notifications can be switched off', Object.keys(silenced).length === 0, JSON.stringify(silenced))
  fixture.data = original
  await page.click('#refresh')
  await page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh')

  // SSO not authorised: GitHub returns 200 with empty lists *and* errors. The
  // user must see why the lists are empty.
  mode = 'saml-partial'
  await page.click('#refresh')
  await page.waitForSelector('#warning:not([hidden])')
  check('SSO partial error is shown as a warning, not an empty page', ((await page.textContent('#warning')) ?? '').includes('fine-grained'))
  mode = 'ok'
  await page.click('#refresh')
  await page.waitForSelector('#warning[hidden]', { state: 'attached' })
  check('warning clears once GitHub stops sending it', await page.isHidden('#warning'))
  await page.check('#only-pending')

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
