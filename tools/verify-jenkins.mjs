/**
 * Browser check for reading build status straight from Jenkins.
 *
 * Chrome's permission prompt can't be clicked from Playwright, so this loads a
 * copy of the extension with the Jenkins host already granted (moved from
 * optional_host_permissions to host_permissions). GitHub is replayed with
 * builds hidden; Jenkins is replayed per PR. Lookups go by API token only
 * (credentials: 'omit' is covered by tests/jenkins.test.js — intercepted
 * requests here never expose cookies, so it can't be checked from this side).
 *
 *   node tools/verify-jenkins.mjs [--headed]
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const JENKINS = 'https://jenkins-build-ci-2.gdn-app.com'
let checks = 0
let failures = 0
/** @param {string} label @param {boolean} ok @param {string} [detail] */
function check(label, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '✔' : '✘'} ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const work = mkdtempSync(path.join(tmpdir(), 'pr-tracker-jenkins-'))
const ext = path.join(work, 'ext')
cpSync(ROOT, ext, { recursive: true, filter: (src) => !/node_modules|\.git(\/|$)|\/dist(\/|$)/.test(src) })
const manifest = JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf8'))
manifest.host_permissions = [...manifest.host_permissions, `${JENKINS}/*`]
writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2))

const fixture = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/dashboard.json'), 'utf8'))
const hide = (/** @type {any} */ s) => ({ ...s, nodes: s.nodes.map((/** @type {any} */ n) => ({ ...n, head: { nodes: [{ commit: { statusCheckRollup: null } }] } })) })
const d = fixture.data
const github = {
  data: { ...d, mine: hide(d.mine), requested: hide(d.requested), reviewed: hide(d.reviewed) },
  errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token', path: ['mine', 'nodes', 0, 'head', 'nodes', 0, 'commit', 'statusCheckRollup'] }],
}

const context = await chromium.launchPersistentContext(path.join(work, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
})
try {
  await context.route('https://api.github.com/graphql', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(github) }))
  // Build lookups are replayed. The good token sees every build; a bad one gets 401.
  /** @type {{auth: string}[]} */ const calls = []
  const GOOD = `Basic ${Buffer.from('ci.user:good').toString('base64')}`
  await context.route(`${JENKINS}/**/lastBuild/api/json*`, async (route) => {
    const url = route.request().url()
    const headers = await route.request().allHeaders()
    calls.push({ auth: headers.authorization ?? '' })
    if (headers.authorization !== GOOD) return route.fulfill({ status: 401, body: 'Invalid password/token' })
    const json = (/** @type {object} */ b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })
    if (url.includes('/PR-101/')) return json({ number: 12, result: 'SUCCESS', building: false, url: `${JENKINS}/job/x/job/PR-101/12/`, timestamp: Date.now() - 60_000, duration: 30_000 })
    if (url.includes('/PR-103/')) return json({ number: 4, result: null, building: true, url: `${JENKINS}/job/x/job/PR-103/4/` })
    return route.fulfill({ status: 404, body: 'no job' })
  })

  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const id = new URL(sw.url()).host
  const page = await context.newPage()
  /** @type {string[]} */ const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const settled = () => page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh')
  const openStale = () => page.evaluate(() => document.querySelectorAll('details.stale').forEach((d) => d.setAttribute('open', '')))
  const chipOf = (/** @type {number} */ n) => page.locator('article.pr', { hasText: `#${n} ` }).locator('.chip.build').first()

  await page.goto(`chrome-extension://${id}/pages/app.html`)
  await page.fill('#token', 'x')
  await page.click('#settings button[type=submit]')
  await page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh' && document.querySelector('article.pr'))
  await page.click('#tab-mine')
  await openStale()

  console.log('\nPR Tracker — Jenkins (token only)')
  check('without a token, Jenkins is never asked (no browser-session lookups)', calls.length === 0, `${calls.length} calls`)
  check('without a token, the banner offers adding one', await page.isVisible('#jenkins-access'))
  check('without a token, PRs link to their Jenkins job', ((await chipOf(101).textContent()) ?? '') === 'Jenkins ↗')

  await page.click('#jenkins-setup')
  check('"Add Jenkins token" opens Settings at the token field', await page.isVisible('#settings') && (await page.evaluate(() => document.activeElement?.id)) === 'jenkins-user')
  await page.fill('#jenkins-user', 'ci.user')
  await page.fill('#jenkins-token', 'good')
  await page.click('#settings button[type=submit]')
  await settled()
  await openStale()
  check('token sent as Basic auth on every lookup', calls.length > 0 && calls.every((c) => c.auth === GOOD), calls[0]?.auth)
  check('token field cleared, token kept', (await page.inputValue('#jenkins-token')) === '' && (await page.getAttribute('#jenkins-token', 'placeholder'))?.includes('saved') === true)
  check('passing build read from Jenkins', ((await chipOf(101).textContent()) ?? '') === 'Jenkins #12 passed', (await chipOf(101).textContent()) ?? '')
  check('chip links to that build', (await chipOf(101).getAttribute('href')) === `${JENKINS}/job/x/job/PR-101/12/`)
  check('no job (404) means no chip, not a dead link', (await page.locator('article.pr', { hasText: '#102 ' }).locator('.chip.build').count()) === 0)
  check('token banner gone once a token is set', await page.isHidden('#jenkins-access'))
  await page.click('#tab-toReview')
  await openStale()
  check('running build read from Jenkins', ((await chipOf(103).textContent()) ?? '') === 'Jenkins #4 running', (await chipOf(103).textContent()) ?? '')

  await page.click('#toggle-settings')
  await page.fill('#jenkins-token', 'bad')
  await page.click('#settings button[type=submit]')
  await settled()
  check('a rejected token says so', await page.isVisible('#jenkins-bad-token'))
  await page.click('#toggle-settings')
  await page.click('#jenkins-token-clear')
  await settled()
  check('removing the token stops lookups and offers adding one again', await page.isHidden('#jenkins-bad-token') && (await page.isVisible('#jenkins-access')))
  check('no page errors', errors.length === 0, errors[0])
} finally {
  await context.close()
  rmSync(work, { recursive: true, force: true })
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
