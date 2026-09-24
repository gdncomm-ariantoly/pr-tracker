import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fetchJenkinsBuild, mapLimit, parseLastBuild } from '../lib/jenkins.js'
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
  it('asks lastBuild/api/json with the browser session', async () => {
    /** @type {[string, RequestInit | undefined][]} */ const calls = []
    const f = /** @type {typeof fetch} */ (async (url, init) => {
      calls.push([String(url), init])
      return new Response(JSON.stringify({ number: 3, result: 'SUCCESS' }), { status: 200 })
    })
    const r = await fetchJenkinsBuild(JOB, f)
    assert.equal(r.kind, 'build')
    assert.match(calls[0][0], /PR-152\/lastBuild\/api\/json\?tree=/)
    assert.equal(calls[0][1]?.credentials, 'include')
  })
  it('reads 403 (anonymous) as "sign in", 404 as "no job"', async () => {
    assert.deepEqual(await fetchJenkinsBuild(JOB, reply(403)), { kind: 'login' })
    assert.deepEqual(await fetchJenkinsBuild(JOB, reply(404)), { kind: 'none' })
    assert.equal((await fetchJenkinsBuild(JOB, reply(500))).kind, 'error')
  })
})

describe('addJenkinsBuilds', () => {
  const pr = (/** @type {string} */ id, /** @type {string} */ repo, /** @type {any} */ build = null) => /** @type {any} */ ({ id, repo, number: 7, build })
  const TEMPLATE = 'https://jenkins-build-ci-2.gdn-app.com/job/T/job/{repo}/job/PR-{number}/'

  it('does nothing until access is granted', async () => {
    const snap = /** @type {any} */ ({ mine: [pr('A', 'o/svc')], toReview: [] })
    await addJenkinsBuilds(snap, TEMPLATE, { jenkinsFetch: reply(200, { number: 1, result: 'SUCCESS' }), jenkinsAllowed: async () => false })
    assert.equal(snap.mine[0].build, null)
    assert.equal(snap.jenkinsChecked, undefined)
  })

  it('fills builds GitHub lacked, once per PR, and flags sign-in', async () => {
    /** @type {string[]} */ const asked = []
    const f = /** @type {typeof fetch} */ (async (url) => {
      asked.push(String(url))
      if (String(url).includes('/job/locked/')) return new Response('', { status: 403 })
      if (String(url).includes('/job/deploy/')) return new Response('', { status: 404 })
      return new Response(JSON.stringify({ number: 5, result: 'FAILURE' }), { status: 200 })
    })
    const both = pr('A', 'o/svc')
    const snap = /** @type {any} */ ({
      mine: [both, pr('B', 'o/locked'), pr('C', 'o/deploy'), pr('D', 'o/svc', { state: 'success' })],
      toReview: [{ ...both }],
    })
    let origin = ''
    await addJenkinsBuilds(snap, TEMPLATE, { jenkinsFetch: f, jenkinsAllowed: async (o) => ((origin = o), true) })
    assert.equal(origin, 'https://jenkins-build-ci-2.gdn-app.com')
    assert.equal(asked.length, 3, 'A once (though in both lists), B, C; D already had a build')
    assert.equal(snap.mine[0].build.state, 'failure')
    assert.equal(snap.toReview[0].build.state, 'failure')
    assert.equal(snap.mine[1].jenkins, 'login')
    assert.equal(snap.mine[2].build, null)
    assert.equal(snap.jenkinsLogin, true)
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
