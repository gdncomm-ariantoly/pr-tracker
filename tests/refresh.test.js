import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { refresh, refreshOnePR, stillRequested } from '../lib/refresh.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/dashboard.json', import.meta.url), 'utf8'))

const memory = () => {
  /** @type {Record<string, unknown>} */ const data = {}
  return { data, get: async (/** @type {string} */ k) => ({ [k]: data[k] }), set: async (/** @type {Record<string, unknown>} */ o) => void Object.assign(data, o) }
}

/** GitHub stand-in: the fixture for list searches, `one` for a single-PR query. @param {(id: string) => any} one @param {any[]} [seen] */
const github = (one, seen = []) =>
  /** @type {typeof fetch} */ (
    async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      seen.push(body)
      if (body.query.includes('node(id:')) return new Response(JSON.stringify({ data: { viewer: { login: 'octo-me' }, rateLimit: { remaining: 1, resetAt: '' }, node: one(body.variables.id) } }))
      return new Response(JSON.stringify(fixture))
    }
  )

/** A dashboard already refreshed once. */
async function loaded(/** @type {typeof fetch} */ fetchImpl) {
  const area = memory()
  await area.set({ settings: { token: 't' } })
  await refresh({ area, fetchImpl, retryDelays: [] })
  return area
}

describe('refreshOnePR', () => {
  const mine101 = fixture.data.mine.nodes[0]

  it('re-fetches only that PR and puts it back in place', async () => {
    /** @type {any[]} */ const seen = []
    const area = await loaded(github(() => ({ ...mine101, state: 'OPEN', title: 'Add caching (v2)' }), seen))
    const before = /** @type {any} */ (area.data.snapshot)
    seen.length = 0
    assert.deepEqual(await refreshOnePR(mine101.id, { area, fetchImpl: github(() => ({ ...mine101, state: 'OPEN', title: 'Add caching (v2)' }), seen), retryDelays: [] }), { kind: 'ok' })
    assert.equal(seen.length, 1, 'one GraphQL request')
    assert.deepEqual(seen[0].variables, { id: mine101.id })
    const after = /** @type {any} */ (area.data.snapshot)
    assert.equal(after.mine[0].title, 'Add caching (v2)')
    assert.deepEqual(after.mine.map((/** @type {any} */ p) => p.id), before.mine.map((/** @type {any} */ p) => p.id), 'same order')
    assert.deepEqual(after.toReview, before.toReview, 'other PRs untouched')
  })

  it('drops a merged PR with a note', async () => {
    const area = await loaded(github(() => null))
    assert.deepEqual(await refreshOnePR(mine101.id, { area, fetchImpl: github(() => ({ ...mine101, state: 'MERGED' })), retryDelays: [] }), { kind: 'merged' })
    const after = /** @type {any} */ (area.data.snapshot)
    assert.ok(!after.mine.some((/** @type {any} */ p) => p.id === mine101.id))
    assert.match(after.warnings.at(-1), /#101 was merged; removed from the list/)
  })

  it('reports errors without touching the snapshot', async () => {
    const area = await loaded(github(() => null))
    const before = JSON.stringify(area.data.snapshot)
    const failing = /** @type {typeof fetch} */ (async () => new Response('{}', { status: 502 }))
    const r = await refreshOnePR(mine101.id, { area, fetchImpl: failing, retryDelays: [] })
    assert.equal(r.kind, 'error')
    assert.equal(JSON.stringify(area.data.snapshot), before)
    assert.equal((await refreshOnePR('nope', { area, fetchImpl: failing, retryDelays: [] })).kind, 'gone')
  })
})

describe('stillRequested', () => {
  const req = (/** @type {any[]} */ reviewers) => ({ reviewRequests: { nodes: reviewers.map((r) => ({ requestedReviewer: r })) } })
  it('by name, or through a team only if it was already requested', () => {
    assert.equal(stillRequested(req([{ __typename: 'User', login: 'me' }]), 'me', false), true)
    assert.equal(stillRequested(req([{ __typename: 'User', login: 'bob' }]), 'me', true), false, 'my review is in: no longer requested')
    assert.equal(stillRequested(req([{ __typename: 'Team', slug: 'be' }]), 'me', true), true)
    assert.equal(stillRequested(req([{ __typename: 'Team', slug: 'be' }]), 'me', false), false)
  })
})

describe('tokens in the Keychain', () => {
  it('reads a Keychain-held token only for the refresh, never storing it', async () => {
    const area = memory()
    await area.set({ settings: { token: '@keychain', keychain: true } })
    /** @type {string[]} */ const auth = []
    const fetchImpl = /** @type {typeof fetch} */ (async (_url, init) => (auth.push(String(/** @type {any} */ (init?.headers).Authorization)), new Response(JSON.stringify(fixture))))
    await refresh({ area, fetchImpl, retryDelays: [], secrets: { get: async (name) => (name === 'github' ? 'github_pat_from_keychain' : '') } })
    assert.ok(auth.length > 0 && auth.every((a) => a === 'Bearer github_pat_from_keychain'))
    assert.equal(/** @type {any} */ (area.data.settings).token, '@keychain', 'storage still holds only the reference')
  })

  it('says so when the helper cannot hand the token over', async () => {
    const area = memory()
    await area.set({ settings: { token: '@keychain', keychain: true } })
    await assert.rejects(refresh({ area, fetchImpl: github(() => null), retryDelays: [], secrets: { get: async () => { throw new Error('the Claude Code helper is not connected') } } }), /Couldn't read your GitHub token from the macOS Keychain: the Claude Code helper is not connected/)
    assert.match(String(/** @type {any} */ (area.data).lastError), /macOS Keychain/)
    await assert.rejects(refresh({ area, fetchImpl: github(() => null), retryDelays: [] }), /in the macOS Keychain, but the Claude Code helper isn't available/)
  })
})
