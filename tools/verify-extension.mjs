/**
 * Loads the extension unpacked into a real Chromium and drives it.
 *
 * Copy this into the project (usually `tools/verify-extension.mjs`), point
 * EXTENSIONS at the directories, and replace `verify()` with the checks that
 * matter. Everything above that line is the part that is the same every time.
 *
 *   npm install -D @playwright/test && npx playwright install chromium
 *   node tools/verify-extension.mjs [--headed]
 *   SHOT=card.png node tools/verify-extension.mjs   # also save a screenshot of one PR's comments
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
  /** @type {string[]} */
  const watchedQueries = []
  await context.route('https://api.github.com/graphql', async (route) => {
    authHeaders.push(route.request().headers().authorization ?? '')
    if (mode === 'jenkins-hidden') {
      // What a fine-grained token gets: no build data on any PR, plus an error on it.
      const strip = (/** @type {any} */ search) => ({ ...search, nodes: search.nodes.map((/** @type {any} */ n) => ({ ...n, head: { nodes: [{ commit: { statusCheckRollup: null } }] } })) })
      const d = fixture.data
      const errors = d.mine.nodes.map((/** @type {any} */ _, /** @type {number} */ i) => ({ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token', path: ['mine', 'nodes', i, 'head', 'nodes', 0, 'commit', 'statusCheckRollup'] }))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { ...d, mine: strip(d.mine), requested: strip(d.requested), reviewed: strip(d.reviewed) }, errors }) })
    } else if (mode === 'saml-partial') {
      const empty = { ...fixture.data, mine: { issueCount: 0, nodes: [] }, requested: { issueCount: 0, nodes: [] }, reviewed: { issueCount: 0, nodes: [] } }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: empty, errors: [{ type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement.' }] }) })
    } else if (mode === 'sso') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ errors: [{ message: 'Resource protected by organization SAML enforcement.' }] }) })
    } else {
      // Watched repos: GitHub would return their open PRs under the `watched` alias.
      const vars = JSON.parse(route.request().postData() ?? '{}').variables ?? {}
      const watched = vars.hasWatched ? { watched: { issueCount: 1, nodes: [{ ...fixture.data.mine.nodes[0], id: 'WATCHED1', number: 900, title: 'Someone else\'s change', author: { login: 'dave', __typename: 'User' } }] } } : {}
      watchedQueries.push(vars.hasWatched ? vars.watched : '')
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...fixture, data: { ...fixture.data, ...watched } }) })
    }
  })

  const { page, errors } = await openPage(context, `chrome-extension://${id}/pages/app.html`)
  await page.waitForSelector('#empty:not([hidden])')
  check('page loads with no console errors', errors.length === 0, errors[0])
  check('first run opens Settings (no token yet)', await page.isVisible('#settings'))
  check('Settings has no Jenkins job link field', (await page.locator('#jenkins').count()) === 0)
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

  // Jenkins: a chip per PR that has a build, linking to it, without toggling the card.
  const expectedBuilds = await page.evaluate(async () => {
    const { snapshot } = await chrome.storage.local.get('snapshot')
    return /** @type {any} */ (snapshot).mine.filter((/** @type {any} */ p) => p.build).length
  })
  const statusChips = page.locator('.chip.build:not(.b-unknown)')
  check('a Jenkins chip on every PR with a build', (await statusChips.count()) === expectedBuilds, `${await statusChips.count()} vs ${expectedBuilds}`)
  check('no guessed CI Jenkins link while builds are visible', (await page.locator('.chip.b-unknown:not([href*="/search/?q="])').count()) === 0)
  if (expectedBuilds) {
    const firstBuild = page.locator('a.chip.build').first()
    check('the chip links to Jenkins', /jenkins/i.test((await firstBuild.getAttribute('href')) ?? ''))
    const card = page.locator('article.pr').filter({ has: firstBuild }).first().locator('details')
    const openBefore = await card.evaluate((d) => /** @type {HTMLDetailsElement} */ (d).open)
    const [popup] = await Promise.all([context.waitForEvent('page'), firstBuild.click()])
    await popup.close()
    check('clicking the chip opens Jenkins without toggling the card', (await card.evaluate((d) => /** @type {HTMLDetailsElement} */ (d).open)) === openBefore)
  }

  // Deployment repos: a link to their own Jenkins's search, whatever GitHub shows.
  const deployCount = await page.evaluate(async () => {
    const { deployJenkinsLink } = await import('../lib/store.js')
    const { snapshot } = await chrome.storage.local.get('snapshot')
    return /** @type {any[]} */ (/** @type {any} */ (snapshot).mine).filter((p) => !p.build && deployJenkinsLink(p)).length
  })
  const deployChips = page.locator('a.chip.b-unknown[href*="/search/?q="]')
  check('deployment PRs link to their Jenkins (prod-deploy / prod-infra / np-deploy)', (await deployChips.count()) === deployCount, `${await deployChips.count()} vs ${deployCount}`)

  // Grouping: one section per service, stale PRs in a collapsed group at the end.
  const expectedGroups = await page.evaluate(async () => {
    const { groupPRs } = await import('../lib/group.js')
    const { snapshot } = await chrome.storage.local.get('snapshot')
    const g = groupPRs(/** @type {any} */ (snapshot).mine)
    return { services: g.services.map((x) => x.name), stale: g.stale.length }
  })
  const shownGroups = await page.locator('section.group').evaluateAll((els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.group))
  check('PRs are grouped by service, most urgent first', JSON.stringify(shownGroups) === JSON.stringify(expectedGroups.services), `${shownGroups} vs ${expectedGroups.services}`)
  const shownOrder = await page.locator('section.group article.pr').evaluateAll((els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.id))
  const expectedOrder = await page.evaluate(async () => {
    const { groupPRs } = await import('../lib/group.js')
    const { snapshot } = await chrome.storage.local.get('snapshot')
    return groupPRs(/** @type {any[]} */ (/** @type {any} */ (snapshot).mine)).services.flatMap((g) => g.prs.map((/** @type {any} */ p) => p.id))
  })
  check('PRs with unfixed comments come first, then commented, newest first', JSON.stringify(shownOrder) === JSON.stringify(expectedOrder))
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
  // Approvals, for every My PR: the row says exactly what the snapshot says.
  const expectedApprovals = await page.evaluate(async () => {
    const { shortLogin } = await import('../lib/notify.js')
    const { snapshot } = await chrome.storage.local.get('snapshot')
    return /** @type {any[]} */ (/** @type {any} */ (snapshot).mine).map((p) => {
      const n = (/** @type {string[]} */ l) => l.map((x) => (x.startsWith('@') ? `${x.slice(1)} (team)` : shortLogin(x, p.repo))).join(', ')
      const a = p.approvals
      const parts = [a.approvedBy.length ? `Approved by ${n(a.approvedBy)}` : '', a.changesBy.length ? `Changes requested by ${n(a.changesBy)}` : '', a.waitingOn.length ? `Waiting on ${n(a.waitingOn)}` : '']
      const any = parts.some(Boolean)
      return { id: p.id, text: any ? parts.filter(Boolean).join('') : p.isDraft ? '' : 'No reviewer requested yet' }
    })
  })
  const shownApprovals = await page.locator('article.pr').evaluateAll((els) => els.map((e) => ({ id: /** @type {HTMLElement} */ (e).dataset.id, text: e.querySelector('.approvals')?.textContent ?? '' })))
  const approvalMismatch = expectedApprovals.filter((x) => shownApprovals.find((y) => y.id === x.id)?.text !== x.text)
  check('My PRs say who approved, who wants changes and whose review is pending', approvalMismatch.length === 0, JSON.stringify(approvalMismatch[0]))
  if (!process.env.FIXTURE) {
    const row = page.locator('article.pr', { hasText: '#101 ' }).locator('.approvals')
    check('bots are left out, teams and hidden teams are named', ((await row.textContent()) ?? '') === 'Approved by erinChanges requested by carolWaiting on dave, Backend Leads (team), a team', (await row.textContent()) ?? '')
  }

  // Expand the first PR with findings and check one finding's anatomy.
  const withFindings = page.locator('article.pr').filter({ has: page.locator('.findings li') }).first()
  await withFindings.locator('summary').click()
  // Layout: an open PR must not push the list into the Updates panel.
  await page.setViewportSize({ width: Number(process.env.VW ?? 1300), height: 900 })
  await page.locator('article.pr details:not([open]) > summary').evaluateAll((els) => els.forEach((e) => /** @type {HTMLElement} */ (e).click()))
  const gap = await page.evaluate(() => {
    const inbox = /** @type {HTMLElement} */ (document.querySelector('.inbox')).getBoundingClientRect()
    const content = /** @type {HTMLElement} */ (document.querySelector('.content')).getBoundingClientRect()
    let right = content.right
    let culprit = ''
    for (const e of document.querySelectorAll('.content *')) {
      // content scrolled inside a code block or table is clipped, not overflowing
      if (e.parentElement?.closest('pre, table')) continue
      const r = e.getBoundingClientRect()
      if (r.width && r.right > right) { right = r.right; culprit = `${e.tagName}.${e.className}` }
    }
    return { gap: Math.round(inbox.left - right), culprit, inboxWidth: Math.round(inbox.width) }
  })
  if (process.env.SHOT_LAYOUT) await page.screenshot({ path: process.env.SHOT_LAYOUT })
  check('open PRs keep their gap to the Updates panel', gap.gap >= 16 && gap.inboxWidth >= 300, JSON.stringify(gap))
  const first = withFindings.locator('.finding').first()
  check('finding shows a status', ((await first.locator('.status').textContent()) ?? '').length > 0)
  check('finding shows its author', ((await first.locator('.who').textContent()) ?? '').length > 0)
  check('finding shows evidence', ((await first.locator('.evidence-text').textContent()) ?? '').length > 0)
  check('finding shows an avatar', (await first.locator('.f-head .avatar').count()) === 1)
  check('comments sit under a group heading', ((await withFindings.locator('.f-group').first().textContent()) ?? '').includes('·'))
  check('finding links to GitHub', ((await first.locator('a.when').getAttribute('href')) ?? '').startsWith('https://github.com/'))
  if (process.env.SHOT) await withFindings.screenshot({ path: process.env.SHOT })
  check('bot comments are not listed', (await page.locator('.finding .who', { hasText: 'productivity-tools-services' }).count()) === 0)

  // Fixed comments start folded to one line; clicking the header opens them.
  const fixedItem = page.locator('.finding.fixed').first()
  if (await fixedItem.count()) {
    check('fixed comments start folded', (await fixedItem.getAttribute('class'))?.includes('folded') === true && (await fixedItem.locator('.body').isHidden()) && (await fixedItem.locator('.preview').isVisible()))
    check('unfixed comments stay open', (await page.locator('.finding:not(.fixed):not(.no-action).folded').count()) === 0)
    check('no-action comments start folded too', (await page.locator('.finding.no-action:not(.folded)').count()) === 0)
    const fixedId = await fixedItem.getAttribute('data-id')
    await fixedItem.locator('.f-head .who').click()
    check('clicking a folded comment opens it', await page.locator(`.finding[data-id="${fixedId}"] .body`).isVisible())
    await page.click('#tab-toReview')
    await page.click('#tab-mine')
    check('it stays open across a repaint', await page.locator(`.finding[data-id="${fixedId}"] .body`).isVisible())
    await page.locator(`.finding[data-id="${fixedId}"] .f-head .who`).click()
    check('and folds again on a second click', await page.locator(`.finding[data-id="${fixedId}"] .body`).isHidden())
  }

  // Comments render like GitHub (bodyHTML), and hostile HTML is neutralised.
  if (await page.locator('.markdown-body table').count()) {
    check('comments render GitHub formatting (code, tables)', (await page.locator('.markdown-body code').count()) > 0)
    const pwned = await page.evaluate(() => /** @type {any} */ (window).__pwned ?? null)
    check('no script, event handler or javascript: link survives', pwned === null && (await page.locator('.markdown-body script, .markdown-body [onerror], .markdown-body a[href^="javascript:"]').count()) === 0, String(pwned))
    check('relative GitHub links point at github.com and open in a new tab', (await page.locator('.markdown-body a', { hasText: 'relative' }).first().getAttribute('href')) === 'https://github.com/gdncomm/api/pull/1')
  }
  if (await page.locator('.conversation li').count()) {
    check('thread replies show under the comment', ((await page.locator('.conversation li').first().textContent()) ?? '').length > 0)
  }

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
    check('and folds it', (await marked.getAttribute('class'))?.includes('folded') === true)
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

  // The Updates panel keeps the same event, unread, and clicking it marks it read.
  await page.setViewportSize({ width: 1400, height: 900 })
  const item = page.locator('#inbox-list li').first()
  await item.waitFor()
  check('Updates panel sits on the right and lists the new comment', (await page.isVisible('#inbox')) && ((await item.textContent()) ?? '').includes('New comment'))
  const side = await item.locator('.i-side').textContent()
  check('it says whether it is my PR or one to review', side === 'My PR', `${side}`) // target is from mine
  check('it is unread, with a count in the header', (await item.getAttribute('class'))?.includes('unread') === true && (await page.textContent('#unread')) === '1')
  const [tab] = await Promise.all([context.waitForEvent('page'), item.locator('a').click()])
  check('clicking it opens the comment', tab.url().includes('discussion_rNEW'))
  await tab.close()
  check('and marks it read', !((await item.getAttribute('class')) ?? '').includes('unread') && (await page.isHidden('#unread')))
  const inboxBefore = await page.locator('#inbox-list li').count()
  await item.hover()
  await item.locator('.i-remove').click()
  check('an update can be deleted on its own', (await page.locator('#inbox-list li').count()) === inboxBefore - 1)
  const stored = await page.evaluate(async () => /** @type {unknown[]} */ ((await chrome.storage.local.get('inbox')).inbox).length)
  check('and stays deleted', stored === inboxBefore - 1, `${stored}`)
  await page.setViewportSize({ width: 900, height: 900 })
  check('narrow window: panel hidden behind an Updates button', (await page.isHidden('#inbox')) && (await page.isVisible('#toggle-inbox')))
  await page.click('#toggle-inbox')
  check('the button opens it as a drawer', await page.isVisible('#inbox'))
  await page.click('#inbox-close')
  await page.setViewportSize({ width: 1280, height: 720 })

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

  // Watched repos: their PRs join To review, labelled, without a review request.
  await page.click('#toggle-settings')
  await page.fill('#watched', 'api, https://github.com/acme/web')
  await page.click('#settings button[type=submit]')
  await page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh')
  await page.click('#tab-toReview')
  // The watched PR is a copy of a My PR, which may have no unfixed comments.
  if (await page.isChecked('#only-pending')) await page.uncheck('#only-pending')
  await page.waitForSelector('article.pr[data-id="WATCHED1"]', { state: 'attached' })
  check('watched repos are searched by full name', / repo:gdncomm\/api repo:acme\/web$/.test(watchedQueries.at(-1) ?? ''), watchedQueries.at(-1))
  check('a watched PR shows under To review, labelled', ((await page.locator('article.pr[data-id="WATCHED1"] .chip.c-watch').textContent()) ?? '') === 'Watched repo')
  const countWith = Number(await page.textContent('#n-toReview'))
  check('the Watched repos filter appears with its count', (await page.isVisible('#watched-filter')) && (await page.textContent('#n-watched')) === '1')
  await page.uncheck('#show-watched')
  check('unticking it hides watched PRs and drops them from the tab count', (await page.locator('article.pr[data-id="WATCHED1"]').count()) === 0 && Number(await page.textContent('#n-toReview')) === countWith - 1)
  await page.reload()
  await page.waitForSelector('#n-watched:not(:empty)', { state: 'attached' })
  // "Only unfixed" may be remembered from earlier checks; it would hide the PR on its own.
  const pendingOnly = await page.isChecked('#only-pending')
  if (pendingOnly) await page.uncheck('#only-pending')
  check('the filter is remembered', !(await page.isChecked('#show-watched')) && (await page.locator('article.pr[data-id="WATCHED1"]').count()) === 0)
  await page.check('#show-watched')
  check('ticking it brings them back', (await page.locator('article.pr[data-id="WATCHED1"]').count()) === 1)
  if (pendingOnly) await page.check('#only-pending')
  await page.click('#tab-mine')
  check('the filter only shows on To review', await page.isHidden('#watched-filter'))
  await page.click('#tab-toReview')
  await page.click('#toggle-settings')
  check('Settings shows the list back, gdncomm/ dropped', (await page.inputValue('#watched')) === 'api, acme/web')
  await page.fill('#watched', '')
  await page.click('#settings button[type=submit]')
  await page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh')
  check('clearing the list stops the watched search', watchedQueries.at(-1) === '' && (await page.locator('article.pr[data-id="WATCHED1"]').count()) === 0)
  await page.click('#tab-mine')

  // Build status hidden from the token: fall back to a Jenkins job link, no standing banner.
  mode = 'jenkins-hidden'
  await page.click('#refresh')
  await page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh')
  const fallback = page.locator('a.chip.b-unknown:not([href*="/search/?q="])')
  const ciPRs = await page.evaluate(async () => {
    const { NO_CI_REPO, skipsJenkins } = await import('../lib/store.js')
    const tab = document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('data-tab') ?? 'mine'
    const { snapshot } = await chrome.storage.local.get('snapshot')
    const onlyPending = /** @type {HTMLInputElement} */ (document.getElementById('only-pending')).checked
    return /** @type {any[]} */ (/** @type {any} */ (snapshot)[tab])
      .filter((p) => !onlyPending || p.counts.pending > 0)
      .filter((p) => !NO_CI_REPO.test(p.repo.split('/').pop()) && !skipsJenkins(p)).length
  })
  const cucumberIds = await page.evaluate(async () => {
    const { snapshot } = await chrome.storage.local.get('snapshot')
    return [.../** @type {any} */ (snapshot).mine, .../** @type {any} */ (snapshot).toReview].filter((p) => /^cucumber-/i.test(p.repo.split('/').pop())).map((p) => p.id)
  })
  let cucumberChips = 0
  for (const id of cucumberIds) cucumberChips += await page.locator(`article.pr[data-id="${id}"] .chip.build`).count()
  check('cucumber-* automation PRs get no Jenkins chip or link', cucumberChips === 0, `${cucumberChips} on ${cucumberIds.length} PRs`)
  check('hidden build status falls back to a Jenkins job link on every CI PR (not prod/non-prod deploy repos)', (await fallback.count()) === ciPRs, `${await fallback.count()} vs ${ciPRs}`)
  check('fallback link follows the job template', /\/job\/PR-\d+\/$/.test((await fallback.first().getAttribute('href')) ?? ''))
  check('no banner for a hidden build status when the link covers it', await page.isHidden('#warning'))
  check('suggests adding a Jenkins token', await page.isVisible('#jenkins-access'))
  mode = 'ok'
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
