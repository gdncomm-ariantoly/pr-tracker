import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { basicAuth, fetchJenkinsBuild, mapLimit, parseFolders, parseLastBuild } from '../lib/jenkins.js'
import { addJenkinsBuilds } from '../lib/refresh.js'

const JOB = 'https://jenkins-build-ci-2.gdn-app.com/job/GitHub/job/gdncomm/job/GDN/job/TRFCEE/job/product-feed/job/PR-152/'
/** @param {number} status @param {unknown} [body] */
const reply = (status, body = {}) => /** @type {typeof fetch} */ (async () => new Response(JSON.stringify(body), { status }))

describe('parseLastBuild', () => {
  it('maps Jenkins results', () => {
    const b = (/** @type {object} */ o) => parseLastBuild({ number: 3, url: `${JOB}3/`, timestamp: 1_000, duration: 500, ...o }, JOB)
    assert.deepEqual(b({ result: 'SUCCESS', building: false }), { state: 'success', url: `${JOB}3/`, name: 'Jenkins', number: 3, at: new Date(1_500).toISOString() })
    assert.equal(b({ result: null, building: true })?.state, 'running')
    assert.equal(b({ result: 'FAILURE' })?.state, 'failure')
    assert.deepEqual([b({ result: 'UNSTABLE' })?.state, b({ result: 'UNSTABLE' })?.name], ['failure', 'Jenkins (unstable)'])
    assert.equal(b({ result: 'ABORTED' })?.state, 'cancelled')
  })
  it('never trusts a non-https build url', () => {
    assert.equal(parseLastBuild({ number: 1, result: 'SUCCESS', url: 'javascript:alert(1)' }, JOB)?.url, JOB)
  })
})

describe('fetchJenkinsBuild', () => {
  const AUTH = { user: 'u', token: 't' }
  it('asks lastBuild/api/json with the token, never the browser session', async () => {
    /** @type {[string, RequestInit | undefined][]} */ const calls = []
    const f = /** @type {typeof fetch} */ (async (url, init) => {
      calls.push([String(url), init])
      return new Response(JSON.stringify({ number: 3, result: 'SUCCESS' }), { status: 200 })
    })
    const r = await fetchJenkinsBuild(JOB, f, AUTH)
    assert.equal(r.kind, 'build')
    assert.match(calls[0][0], /PR-152\/lastBuild\/api\/json\?tree=/)
    assert.equal(calls[0][1]?.credentials, 'omit')
  })
  it('sends an API token as Basic auth, without the session', async () => {
    /** @type {RequestInit | undefined} */ let init
    const f = /** @type {typeof fetch} */ (async (_url, i) => ((init = i), new Response(JSON.stringify({ number: 1, result: 'SUCCESS' }), { status: 200 })))
    await fetchJenkinsBuild(JOB, f, { user: 'ari.antoly', token: '11abc' })
    assert.equal(/** @type {Record<string, string>} */ (init?.headers).Authorization, `Basic ${Buffer.from('ari.antoly:11abc').toString('base64')}`)
    assert.equal(init?.credentials, 'omit')
  })
  it('reads 401 with a token as a bad token, not a sign-in', async () => {
    assert.deepEqual(await fetchJenkinsBuild(JOB, reply(401), { user: 'u', token: 't' }), { kind: 'bad-token' })
    assert.equal((await fetchJenkinsBuild(JOB, reply(403), { user: 'u', token: 't' })).kind, 'error')
  })
  it('encodes non-ASCII user names', () => {
    assert.equal(basicAuth({ user: 'ñ', token: 't' }), `Basic ${Buffer.from('ñ:t').toString('base64')}`)
  })
  it('reads 404 as "no job" and other failures as errors', async () => {
    assert.deepEqual(await fetchJenkinsBuild(JOB, reply(404), AUTH), { kind: 'none' })
    assert.equal((await fetchJenkinsBuild(JOB, reply(500), AUTH)).kind, 'error')
  })
})

describe('addJenkinsBuilds', () => {
  const pr = (/** @type {string} */ id, /** @type {string} */ repo, /** @type {any} */ build = null) => /** @type {any} */ ({ id, repo, number: 7, build })
  const TEMPLATE = 'https://jenkins-build-ci-2.gdn-app.com/job/GDN/job/{folder}/job/{repo}/job/PR-{number}/'
  const AUTH = { user: 'u', token: 't' }
  const memory = () => {
    /** @type {Record<string, unknown>} */ const data = {}
    return { data, get: async (/** @type {string} */ k) => ({ [k]: data[k] }), set: async (/** @type {Record<string, unknown>} */ o) => void Object.assign(data, o) }
  }
  // Team folders as Jenkins lists them: svc in TRFCEE, seo in SEO, shared in both (only SEO builds it).
  const LISTING = { jobs: [{ name: 'TRFCEE', jobs: [{ name: 'svc' }, { name: 'locked' }, { name: 'shared' }] }, { name: 'SEO', jobs: [{ name: 'seo' }, { name: 'shared' }] }] }
  /** @param {string[]} asked */
  const jenkins = (asked) => /** @type {typeof fetch} */ (async (url) => {
    const u = String(url)
    asked.push(u)
    if (u.includes('/api/json?tree=jobs')) return new Response(JSON.stringify(LISTING), { status: 200 })
    if (u.includes('/job/locked/')) return new Response('', { status: 401 })
    if (u.includes('/TRFCEE/job/shared/')) return new Response('', { status: 404 })
    return new Response(JSON.stringify({ number: 5, result: 'FAILURE' }), { status: 200 })
  })

  it('parses the folder listing, keeping repos that sit in several folders', () => {
    assert.deepEqual(parseFolders(LISTING), { svc: ['TRFCEE'], locked: ['TRFCEE'], shared: ['TRFCEE', 'SEO'], seo: ['SEO'] })
    assert.deepEqual(parseFolders(null), {})
  })

  it('does nothing without a token, or until Chrome grants access', async () => {
    /** @type {string[]} */ const asked = []
    const snap = /** @type {any} */ ({ mine: [pr('A', 'o/svc')], toReview: [] })
    await addJenkinsBuilds(snap, TEMPLATE, { area: memory(), jenkinsFetch: jenkins(asked), jenkinsAllowed: async () => true }, null)
    await addJenkinsBuilds(snap, TEMPLATE, { area: memory(), jenkinsFetch: jenkins(asked), jenkinsAllowed: async () => false }, AUTH)
    assert.deepEqual(asked, [])
    assert.equal(snap.jenkinsChecked, undefined)
  })

  it("looks each PR up in its repo's own team folder, once per PR", async () => {
    /** @type {string[]} */ const asked = []
    const both = pr('A', 'o/svc')
    const snap = /** @type {any} */ ({
      mine: [both, pr('S', 'gdncomm/seo'), pr('X', 'o/shared'), pr('N', 'o/unknown'), pr('D', 'o/svc', { state: 'success' })],
      toReview: [{ ...both }],
    })
    const area = memory()
    await addJenkinsBuilds(snap, TEMPLATE, { area, jenkinsFetch: jenkins(asked), jenkinsAllowed: async () => true }, AUTH)
    const builds = asked.filter((u) => u.includes('lastBuild'))
    assert.ok(builds.some((u) => u.includes('/job/TRFCEE/job/svc/job/PR-7/')))
    assert.ok(builds.some((u) => u.includes('/job/SEO/job/seo/job/PR-7/')), 'SEO repo looked up under SEO, not TRFCEE')
    assert.equal(builds.filter((u) => u.includes('/job/svc/')).length, 1, 'A once, though in both lists; D already had a build')
    assert.ok(!builds.some((u) => u.includes('/unknown/')), 'a repo in no folder is not guessed')
    assert.equal(snap.mine[0].build.state, 'failure')
    assert.equal(snap.toReview[0].build.state, 'failure')
    assert.equal(snap.mine[1].build.state, 'failure')
    assert.ok(builds.some((u) => u.includes('/TRFCEE/job/shared/')) && builds.some((u) => u.includes('/SEO/job/shared/')), 'a repo in two folders: tried in both')
    assert.equal(snap.mine[2].build.state, 'failure', 'the folder that has the build wins')
    assert.equal(snap.mine[3].build, null)

    // The folder map is cached: the next refresh doesn't list folders again.
    const listed = asked.filter((u) => u.includes('tree=jobs')).length
    await addJenkinsBuilds(/** @type {any} */ ({ mine: [pr('A', 'o/svc')], toReview: [] }), TEMPLATE, { area, jenkinsFetch: jenkins(asked), jenkinsAllowed: async () => true }, AUTH)
    assert.equal(asked.filter((u) => u.includes('tree=jobs')).length, listed)
  })

  it('flags a rejected token', async () => {
    const snap = /** @type {any} */ ({ mine: [pr('B', 'o/locked')], toReview: [] })
    await addJenkinsBuilds(snap, TEMPLATE, { area: memory(), jenkinsFetch: jenkins([]), jenkinsAllowed: async () => true }, AUTH)
    assert.equal(snap.jenkinsBadToken, true)
    const listing401 = /** @type {typeof fetch} */ (async () => new Response('', { status: 401 }))
    const snap2 = /** @type {any} */ ({ mine: [pr('A', 'o/svc')], toReview: [] })
    await addJenkinsBuilds(snap2, TEMPLATE, { area: memory(), jenkinsFetch: listing401, jenkinsAllowed: async () => true }, AUTH)
    assert.equal(snap2.jenkinsBadToken, true)
  })
})

it('mapLimit keeps order and caps concurrency', async () => {
  let live = 0
  let peak = 0
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    peak = Math.max(peak, ++live)
    await new Promise((r) => setTimeout(r, 5))
    live--
    return n * 2
  })
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14])
  assert.equal(peak, 3)
})
