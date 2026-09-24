/**
 * Browser check for reading build status straight from Jenkins.
 *
 * Chrome's permission prompt can't be clicked from Playwright, so this loads a
 * copy of the extension with the Jenkins host already granted (moved from
 * optional_host_permissions to host_permissions). GitHub is replayed with
 * builds hidden; Jenkins is replayed per PR. A SameSite=Lax session cookie is
 * planted for the Jenkins host to prove the extension's requests carry it —
 * the whole feature rests on that.
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
  await context.addCookies([{ name: 'JSESSIONID.test', value: 'signed-in', domain: 'jenkins-build-ci-2.gdn-app.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }])
  await context.route('https://api.github.com/graphql', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(github) }))
  // Only build lookups are replayed; anything else (whoAmI below) goes to the real Jenkins.
  /** @type {string[]} */ const authHeaders = []
  await context.route(`${JENKINS}/**/lastBuild/api/json*`, async (route) => {
    const url = route.request().url()
    const auth = (await route.request().allHeaders()).authorization ?? ''
    authHeaders.push(auth)
    // A token is judged on its own: the good one sees every build, a bad one gets 401.
    if (auth === `Basic ${Buffer.from('ci.user:bad').toString('base64')}`) return route.fulfill({ status: 401, body: 'Invalid password/token' })
    if (auth && url.includes('/PR-104/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ number: 9, result: 'SUCCESS', building: false }) })
    const json = (/** @type {object} */ b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })
    if (url.includes('/PR-101/')) return json({ number: 12, result: 'SUCCESS', building: false, url: `${JENKINS}/job/x/job/PR-101/12/`, timestamp: Date.now() - 60_000, duration: 30_000 })
    if (url.includes('/PR-103/')) return json({ number: 4, result: null, building: true, url: `${JENKINS}/job/x/job/PR-103/4/` })
    if (url.includes('/PR-104/')) return route.fulfill({ status: 403, body: 'anonymous' })
    return route.fulfill({ status: 404, body: 'no job' })
  })

  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const id = new URL(sw.url()).host
  const page = await context.newPage()
  /** @type {string[]} */ const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`chrome-extension://${id}/pages/app.html`)
  await page.fill('#token', 'x')
  await page.click('#settings button[type=submit]')
  await page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh' && document.querySelector('article.pr'))
  await page.evaluate(() => document.querySelectorAll('details.stale').forEach((d) => /** @type {HTMLDetailsElement} */ (d).setAttribute('open', '')))

  console.log('\nPR Tracker — Jenkins direct')
  // Intercepted requests don't report cookies, so prove it on a real one: the
  // browser's own record (CDP) of what an extension-page fetch sent.
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  /** @type {string[]} */ const sent = []
  cdp.on('Network.requestWillBeSentExtraInfo', (e) => sent.push(String(e.headers.cookie ?? e.headers.Cookie ?? '')))
  const reachable = await page.evaluate((j) => fetch(`${j}/whoAmI/api/json`, { credentials: 'include' }).then(() => true, () => false), JENKINS)
  await page.waitForTimeout(800)
  if (reachable) check('Jenkins requests carry the browser session cookie (real request)', sent.some((c) => c.includes('JSESSIONID.test=signed-in')), JSON.stringify(sent))
  else console.log('  – skipped cookie check: Jenkins not reachable from here (VPN?)')
  await page.click('#tab-mine')
  await page.evaluate(() => document.querySelectorAll('details.stale').forEach((d) => /** @type {HTMLDetailsElement} */ (d).setAttribute('open', '')))
  const chipOf = (/** @type {number} */ n) => page.locator('article.pr', { hasText: `#${n} ` }).locator('.chip.build').first()
  check('passing build read from Jenkins', ((await chipOf(101).textContent()) ?? '') === 'Jenkins #12 passed', (await chipOf(101).textContent()) ?? '')
  check('chip links to that build', (await chipOf(101).getAttribute('href')) === `${JENKINS}/job/x/job/PR-101/12/`)
  await page.click('#tab-toReview')
  await page.evaluate(() => document.querySelectorAll('details.stale').forEach((d) => /** @type {HTMLDetailsElement} */ (d).setAttribute('open', '')))
  check('running build read from Jenkins', ((await chipOf(103).textContent()) ?? '') === 'Jenkins #4 running', (await chipOf(103).textContent()) ?? '')
  check('403 asks to sign in to Jenkins', ((await chipOf(104).textContent()) ?? '').includes('sign in'))
  check('sign-in banner shown', await page.isVisible('#jenkins-login'))
  check('no "allow access" banner once granted', await page.isHidden('#jenkins-access'))
  await page.click('#tab-mine')
  check('no job (404) means no chip, not a dead link', (await page.locator('article.pr', { hasText: '#102 ' }).locator('.chip.build').count()) === 0)

  // API token: saved in Settings, sent as Basic auth, lifts the sign-in requirement.
  await page.click('#toggle-settings')
  await page.fill('#jenkins-user', 'ci.user')
  await page.fill('#jenkins-token', 'good')
  authHeaders.length = 0
  await page.click('#settings button[type=submit]')
  await page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh')
  check('Jenkins token sent as Basic auth', authHeaders.length > 0 && authHeaders.every((h) => h === `Basic ${Buffer.from('ci.user:good').toString('base64')}`), authHeaders[0])
  check('token field cleared, token kept', (await page.inputValue('#jenkins-token')) === '' && (await page.getAttribute('#jenkins-token', 'placeholder'))?.includes('saved') === true)
  await page.click('#tab-toReview')
  await page.evaluate(() => document.querySelectorAll('details.stale').forEach((d) => /** @type {HTMLDetailsElement} */ (d).setAttribute('open', '')))
  check('with a token, the PR that needed sign-in shows its build', ((await chipOf(104).textContent()) ?? '') === 'Jenkins #9 passed', (await chipOf(104).textContent()) ?? '')
  check('sign-in banner gone with a token', await page.isHidden('#jenkins-login'))

  await page.click('#toggle-settings')
  await page.fill('#jenkins-token', 'bad')
  await page.click('#settings button[type=submit]')
  await page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh')
  check('a rejected token says so', await page.isVisible('#jenkins-bad-token'))
  await page.click('#toggle-settings')
  await page.click('#jenkins-token-clear')
  await page.waitForFunction(() => document.querySelector('#refresh')?.textContent === 'Refresh')
  check('removing the token falls back to the browser session', await page.isHidden('#jenkins-bad-token') && (await page.evaluate(async () => /** @type {any} */ ((await chrome.storage.local.get('settings')).settings).jenkinsToken)) === '')
  check('no page errors', errors.length === 0, errors[0])
} finally {
  await context.close()
  rmSync(work, { recursive: true, force: true })
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
