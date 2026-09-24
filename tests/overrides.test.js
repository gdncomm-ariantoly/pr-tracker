import assert from 'node:assert/strict'
import { it } from 'node:test'

import { analyzePR } from '../lib/analyze.js'
import { applyOverrides, toggleOverride } from '../lib/overrides.js'

const bob = { login: 'bob', __typename: 'User' }
const raw = /** @type {any} */ ({
  id: 'P', number: 1, title: 't', url: 'u', isDraft: false, createdAt: '', updatedAt: '', reviewDecision: null,
  author: { login: 'me', __typename: 'User' }, repository: { nameWithOwner: 'o/r' },
  commits: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] },
  comments: { nodes: [
    { id: 'A', author: bob, body: 'please add a test', createdAt: '2026-01-01T00:00:00Z', url: 'u' },
    { id: 'B', author: bob, body: 'and rename it', createdAt: '2026-01-01T00:00:01Z', url: 'u' },
  ] },
})
const snap = { viewer: 'me', fetchedAt: '', rateRemaining: 0, mine: [analyzePR(raw)], toReview: [], truncated: { mine: false, toReview: false } }

it('marks a comment no action needed and recounts', () => {
  const out = applyOverrides(snap, toggleOverride({}, 'A', true))
  const [a, b] = out.mine[0].findings
  assert.equal(a.status, 'no-action')
  assert.equal(a.overridden, true)
  assert.equal(b.status, 'open')
  assert.deepEqual(out.mine[0].counts, { total: 2, fixed: 0, noAction: 1, pending: 1 })
  assert.equal(snap.mine[0].findings[0].status, 'open', 'input not mutated')
})

it('undo removes the mark', () => {
  const o = toggleOverride(toggleOverride({}, 'A', true), 'A', false)
  assert.deepEqual(o, {})
  assert.equal(applyOverrides(snap, o), snap)
})
