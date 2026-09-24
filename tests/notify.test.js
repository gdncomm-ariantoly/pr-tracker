import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { diffSnapshots } from '../lib/notify.js'

/** @param {Partial<import('../lib/analyze.js').Finding>} over @returns {import('../lib/analyze.js').Finding} */
const finding = (over) => ({
  id: 'F1', kind: 'inline', author: 'bob', body: 'rename this', createdAt: '2026-01-01T01:00:00Z', url: 'https://github.com/o/r/pull/1#f1',
  path: 'A.java', line: 1, replies: 0, status: 'open', fixed: false, evidence: '', lastReviewerAt: '2026-01-01T01:00:00Z', lastReviewer: 'bob',
  ...over,
})
/** @param {Partial<import('../lib/github.js').ReviewPR>} over @returns {import('../lib/github.js').ReviewPR} */
const pr = (over) => ({
  id: 'P1', repo: 'o/api', number: 1, title: 'Add cache', url: 'https://github.com/o/r/pull/1', author: 'me', isDraft: false,
  updatedAt: '2026-01-01T00:00:00Z', reviewDecision: 'REVIEW_REQUIRED', hasHumanComments: false, findings: [],
  counts: { total: 0, fixed: 0, noAction: 0, pending: 0 }, ...over,
})
/** @param {Partial<import('../lib/github.js').Snapshot>} over @returns {import('../lib/github.js').Snapshot} */
const snap = (over) => ({
  viewer: 'me', fetchedAt: '', rateRemaining: 0, mine: [], toReview: [], truncated: { mine: false, toReview: false }, ...over,
})

describe('diffSnapshots', () => {
  it('is silent on the first fetch and on an account switch', () => {
    const next = snap({ mine: [pr({ findings: [finding({})] })] })
    assert.deepEqual(diffSnapshots(null, next), [])
    assert.deepEqual(diffSnapshots(snap({ viewer: 'other' }), next), [])
  })

  it('reports a new human comment on my PR', () => {
    const events = diffSnapshots(snap({ mine: [pr({})] }), snap({ mine: [pr({ findings: [finding({})] })] }))
    assert.equal(events.length, 1)
    assert.equal(events[0].title, 'bob commented on api#1')
    assert.match(events[0].message, /A\.java: rename this/)
  })

  it('reports a reviewer following up in an existing thread', () => {
    const prev = snap({ mine: [pr({ findings: [finding({})] })] })
    const next = snap({ mine: [pr({ findings: [finding({ lastReviewerAt: '2026-01-02T00:00:00Z', lastReviewer: 'carol' })] })] })
    assert.deepEqual(diffSnapshots(prev, next).map((e) => e.title), ['carol replied on api#1'])
  })

  it('reports approval but not every decision change', () => {
    const prev = snap({ mine: [pr({})] })
    assert.deepEqual(diffSnapshots(prev, snap({ mine: [pr({ reviewDecision: 'APPROVED' })] })).map((e) => e.title), ['api#1 approved'])
    assert.deepEqual(diffSnapshots(prev, snap({ mine: [pr({ reviewDecision: null })] })), [])
  })

  it('does not flood when a PR first appears', () => {
    assert.deepEqual(diffSnapshots(snap({}), snap({ mine: [pr({ findings: [finding({})] })] })), [])
  })

  it('reports a new review request', () => {
    const events = diffSnapshots(snap({}), snap({ toReview: [pr({ author: 'bob', requested: true })] }))
    assert.deepEqual(events.map((e) => e.title), ['Review requested: api#1'])
  })

  it('reports my comment being fixed or answered on a PR I review', () => {
    const mine = finding({ author: 'me' })
    const prev = snap({ toReview: [pr({ author: 'bob', findings: [mine, finding({ id: 'F2', author: 'carol' })] })] })
    const fixed = snap({ toReview: [pr({ author: 'bob', findings: [
      { ...mine, status: 'fixed-reply', fixed: true },
      finding({ id: 'F2', author: 'carol', status: 'resolved', fixed: true }),
    ] })] })
    assert.deepEqual(diffSnapshots(prev, fixed).map((e) => e.title), ['bob fixed your comment on api#1'], 'only my comments')

    const replied = snap({ toReview: [pr({ author: 'bob', findings: [{ ...mine, status: 'replied', evidence: 'bob replied: no' }] })] })
    assert.deepEqual(diffSnapshots(prev, replied).map((e) => e.title), ['bob answered your comment on api#1'])
  })

  it('says nothing when nothing changed', () => {
    const s = snap({ mine: [pr({ findings: [finding({})] })], toReview: [pr({ id: 'P2', requested: true })] })
    assert.deepEqual(diffSnapshots(s, structuredClone(s)), [])
  })
})
