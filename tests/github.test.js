import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fetchDashboard, GitHubError, toSnapshot, watchedSearch } from '../lib/github.js'
import { badgeFor, refresh } from '../lib/refresh.js'

/** @param {string} id @param {string} updatedAt */
const node = (id, updatedAt) => ({
  id, number: 1, title: id, url: 'u', isDraft: false, createdAt: updatedAt, updatedAt, reviewDecision: null,
  author: { login: 'bob', __typename: 'User' }, repository: { nameWithOwner: 'o/r' },
  commits: { nodes: [] }, comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] },
})

const DATA = {
  viewer: { login: 'alice' },
  rateLimit: { remaining: 4000 },
  mine: { issueCount: 1, nodes: [node('M1', '2026-01-01T00:00:00Z')] },
  requested: { issueCount: 1, nodes: [node('R1', '2026-01-01T00:00:00Z')] },
  reviewed: { issueCount: 2, nodes: [node('D1', '2026-02-01T00:00:00Z'), node('R1', '2026-01-01T00:00:00Z')] },
}

/** @param {number} status @param {unknown} body */
const fakeFetch = (status, body) => /** @type {typeof fetch} */ (async () => new Response(JSON.stringify(body), { status }))

function fakeArea(/** @type {Record<string, unknown>} */ initial = {}) {
  /** @type {Record<string, unknown>} */ const data = { ...initial }
  return {
    data,
    get: async (/** @type {string} */ k) => (k in data ? { [k]: data[k] } : {}),
    set: async (/** @type {Record<string, unknown>} */ items) => void Object.assign(data, items),
  }
}

describe('toSnapshot', () => {
  it('merges requested + reviewed, requested first, no duplicates', () => {
    const s = toSnapshot(DATA)
    assert.equal(s.viewer, 'alice')
    assert.deepEqual(s.toReview.map((p) => [p.id, p.requested]), [['R1', true], ['D1', false]])
    assert.equal(s.mine.length, 1)
    assert.equal(badgeFor(s), '1')
  })
})

describe('fetchDashboard', () => {
  it('refuses to run without a token', async () => {
    await assert.rejects(fetchDashboard({ token: '' }), (e) => e instanceof GitHubError && e.kind === 'auth')
  })
  it('reports a 401 as an auth problem', async () => {
    await assert.rejects(fetchDashboard({ token: 't', fetchImpl: fakeFetch(401, {}) }), /401/)
  })
  it('surfaces GraphQL errors', async () => {
    await assert.rejects(
      fetchDashboard({ token: 't', fetchImpl: fakeFetch(200, { errors: [{ message: 'SAML enforcement' }] }) }),
      /SAML/,
    )
  })
})

describe('partial errors', () => {
  it('keeps GitHub errors that arrive alongside data (SAML hides every org PR)', async () => {
    const empty = { ...DATA, mine: { issueCount: 0, nodes: [] }, requested: { issueCount: 0, nodes: [] }, reviewed: { issueCount: 0, nodes: [] } }
    const saml = 'Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.'
    const s = await fetchDashboard({ token: 't', fetchImpl: fakeFetch(200, { data: empty, errors: [{ type: 'FORBIDDEN', message: saml }, { type: 'FORBIDDEN', message: saml }] }) })
    assert.equal(s.warnings?.length, 1, 'deduplicated')
    assert.match(s.warnings?.[0] ?? '', /SAML.*fine-grained token with Resource owner gdncomm/)
  })
  it('one unreadable PR does not blank the dashboard', () => {
    // A comment without createdAt: nothing GitHub should send, but analysis throws on it.
    const bad = { id: 'X', author: { login: 'bob', __typename: 'User' }, body: 'x', url: 'u' }
    const broken = { ...node('B1', '2026-01-01T00:00:00Z'), comments: { nodes: [bad, { ...bad, id: 'Y' }] } }
    const s = toSnapshot({ ...DATA, mine: { issueCount: 2, nodes: [broken, ...DATA.mine.nodes] } })
    assert.equal(s.mine.length, 2)
    assert.match(s.warnings?.[0] ?? '', /Could not read comments on o\/r#1/)
  })
  it('explains fine-grained access errors by what they hid', () => {
    const msg = 'Resource not accessible by personal access token'
    const s = toSnapshot(DATA, [], [
      { type: 'FORBIDDEN', message: msg, path: ['reviewed', 'nodes', 2] },
      { type: 'FORBIDDEN', message: msg, path: ['requested', 'nodes', 0] },
      { type: 'FORBIDDEN', message: msg, path: ['mine', 'nodes', 1, 'commits'] },
      { type: 'FORBIDDEN', message: msg, path: ['mine', 'nodes', 3, 'commits'] },
    ])
    assert.equal(s.warnings?.length, 2)
    assert.match(s.warnings?.[0] ?? '', /missing Contents: Read-only/)
    assert.match(s.warnings?.[1] ?? '', /^2 PRs are in repositories your token doesn't cover/)
  })
  it('says a hidden Jenkins build only affects the build chip', () => {
    const msg = 'Resource not accessible by personal access token'
    const s = toSnapshot(DATA, [], [{ message: msg, path: ['mine', 'nodes', 0, 'head', 'nodes', 0, 'commit', 'statusCheckRollup'] }])
    assert.equal(s.warnings?.length, 1)
    assert.match(s.warnings?.[0] ?? '', /^Jenkins build status is hidden.*Comments are unaffected/)
  })
  it('falls back to the checklist when it cannot tell what was hidden', () => {
    const s = toSnapshot(DATA, [], [{ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token' }])
    assert.match(s.warnings?.[0] ?? '', /pending approval.*Resource owner gdncomm/)
  })
  it('has no warnings on a clean response', () => {
    assert.deepEqual(toSnapshot(DATA).warnings, [])
  })
})

describe('refresh', () => {
  it('persists the snapshot and clears the error', async () => {
    const area = fakeArea({ settings: { token: 't' }, lastError: 'old' })
    await refresh({ area, fetchImpl: fakeFetch(200, { data: DATA }) })
    assert.equal(/** @type {any} */ (area.data.snapshot).viewer, 'alice')
    assert.equal(area.data.lastError, null)
  })
  it('keeps the last good snapshot when a refresh fails', async () => {
    const area = fakeArea({ settings: { token: 't' }, snapshot: { viewer: 'old' } })
    await assert.rejects(refresh({ area, fetchImpl: fakeFetch(502, { message: 'Bad gateway' }) }))
    assert.equal(/** @type {any} */ (area.data.snapshot).viewer, 'old')
    assert.match(String(area.data.lastError), /502/)
  })
})

describe('watched repositories', () => {
  it('searches only when there is something to watch', async () => {
    /** @type {any[]} */
    const sent = []
    const fetchImpl = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ _url, /** @type {any} */ init) => {
      sent.push(JSON.parse(init.body).variables)
      return new Response(JSON.stringify({ data: { viewer: { login: 'me' }, rateLimit: { remaining: 1 }, mine: { nodes: [] }, requested: { nodes: [] }, reviewed: { nodes: [] } } }))
    }))
    await fetchDashboard({ token: 't', fetchImpl })
    const snap = await fetchDashboard({ token: 't', watchedRepos: ['gdncomm/a', 'gdncomm/b'], fetchImpl })
    assert.equal(sent[0].hasWatched, false)
    assert.equal(sent[1].hasWatched, true)
    assert.equal(sent[1].watched, watchedSearch(['gdncomm/a', 'gdncomm/b']))
    assert.match(sent[1].watched, /-author:@me .*repo:gdncomm\/a repo:gdncomm\/b$/)
    assert.deepEqual(snap.watchedRepos, ['gdncomm/a', 'gdncomm/b'])
  })

  it('adds watched PRs to To review, without relabelling ones I am already on', () => {
    const snap = toSnapshot({
      viewer: { login: 'me' },
      requested: { nodes: [node('R', '2026-01-02T00:00:00Z')] },
      reviewed: { nodes: [] },
      mine: { nodes: [] },
      watched: { nodes: [node('R', '2026-01-02T00:00:00Z'), node('W', '2026-01-01T00:00:00Z')] },
    })
    assert.deepEqual(snap.toReview.map((p) => [p.id, p.requested, !!p.watched]), [['R', true, false], ['W', false, true]])
  })
})
