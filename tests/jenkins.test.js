import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { basicAuth, fetchJenkinsBuild, mapLimit, parseLastBuild } from '../lib/jenkins.js'
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
  const TEMPLATE = 'https://jenkins-build-ci-2.gdn-app.com/job/T/job/{repo}/job/PR-{number}/'

  const AUTH = { user: 'u', token: 't' }
  it('does nothing without a token, or until Chrome grants access', async () => {
    const snap = /** @type {any} */ ({ mine: [pr('A', 'o/svc')], toReview: [] })
    const ok = reply(200, { number: 1, result: 'SUCCESS' })
    await addJenkinsBuilds(snap, TEMPLATE, { jenkinsFetch: ok, jenkinsAllowed: async () => true }, null)
    await addJenkinsBuilds(snap, TEMPLATE, { jenkinsFetch: ok, jenkinsAllowed: async () => false }, AUTH)
    assert.equal(snap.mine[0].build, null)
    assert.equal(snap.jenkinsChecked, undefined)
  })

  it('fills builds GitHub lacked, once per PR, and flags a rejected token', async () => {
    /** @type {string[]} */ const asked = []
    const f = /** @type {typeof fetch} */ (async (url) => {
      asked.push(String(url))
      if (String(url).includes('/job/locked/')) return new Response('', { status: 401 })
      if (String(url).includes('/job/deploy/')) return new Response('', { status: 404 })
      return new Response(JSON.stringify({ number: 5, result: 'FAILURE' }), { status: 200 })
    })
    const both = pr('A', 'o/svc')
    const snap = /** @type {any} */ ({
      mine: [both, pr('B', 'o/locked'), pr('C', 'o/deploy'), pr('D', 'o/svc', { state: 'success' })],
      toReview: [{ ...both }],
    })
    let origin = ''
    await addJenkinsBuilds(snap, TEMPLATE, { jenkinsFetch: f, jenkinsAllowed: async (o) => ((origin = o), true) }, AUTH)
    assert.equal(origin, 'https://jenkins-build-ci-2.gdn-app.com')
    assert.equal(asked.length, 3, 'A once (though in both lists), B, C; D already had a build')
    assert.equal(snap.mine[0].build.state, 'failure')
    assert.equal(snap.toReview[0].build.state, 'failure')
    assert.equal(snap.mine[1].build, null)
    assert.equal(snap.mine[2].build, null)
    assert.equal(snap.jenkinsBadToken, true)
  })

  it('never asks Jenkins about cucumber-* automation repos', async () => {
    /** @type {string[]} */ const asked = []
    const f = /** @type {typeof fetch} */ (async (url) => (asked.push(String(url)), new Response(JSON.stringify({ number: 1, result: 'SUCCESS' }))))
    const snap = /** @type {any} */ ({ mine: [pr('A', 'gdncomm/cucumber-seo-backend')], toReview: [] })
    await addJenkinsBuilds(snap, TEMPLATE, { jenkinsFetch: f, jenkinsAllowed: async () => true }, AUTH)
    assert.deepEqual(asked, [])
    assert.equal(snap.mine[0].build, null)
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
