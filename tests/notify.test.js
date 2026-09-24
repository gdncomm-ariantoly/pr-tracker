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
    assert.equal(events[0].title, 'New comment · api#1')
    assert.equal(events[0].context, 'bob · A.java:1')
    assert.equal(events[0].message, 'rename this')
  })

  it('reports a reviewer following up in an existing thread', () => {
    const prev = snap({ mine: [pr({ findings: [finding({})] })] })
    const next = snap({ mine: [pr({ findings: [finding({ lastReviewerAt: '2026-01-02T00:00:00Z', lastReviewer: 'carol', lastReviewerBody: 'still null here' })] })] })
    assert.deepEqual(diffSnapshots(prev, next).map((e) => [e.title, e.context, e.message]), [['New reply · api#1', 'carol · A.java:1', 'still null here']])
  })

  it('reports approval but not every decision change', () => {
    const prev = snap({ mine: [pr({})] })
    assert.deepEqual(diffSnapshots(prev, snap({ mine: [pr({ reviewDecision: 'APPROVED' })] })).map((e) => e.title), ['Approved · api#1'])
    assert.deepEqual(diffSnapshots(prev, snap({ mine: [pr({ reviewDecision: null })] })), [])
  })

  it('does not flood when a PR first appears', () => {
    assert.deepEqual(diffSnapshots(snap({}), snap({ mine: [pr({ findings: [finding({})] })] })), [])
  })

  it('reports a new review request', () => {
    const events = diffSnapshots(snap({}), snap({ toReview: [pr({ author: 'bob', requested: true })] }))
    assert.deepEqual(events.map((e) => e.title), ['Review requested · api#1'])
  })

  it('reports my comment being fixed or answered on a PR I review', () => {
    const mine = finding({ author: 'me' })
    const prev = snap({ toReview: [pr({ author: 'bob', findings: [mine, finding({ id: 'F2', author: 'carol' })] })] })
    const fixed = snap({ toReview: [pr({ author: 'bob', findings: [
      { ...mine, status: 'fixed-reply', fixed: true },
      finding({ id: 'F2', author: 'carol', status: 'resolved', fixed: true }),
    ] })] })
    assert.deepEqual(diffSnapshots(prev, fixed).map((e) => e.title), ['Your comment fixed · api#1'], 'only my comments')

    const replied = snap({ toReview: [pr({ author: 'bob', findings: [{ ...mine, status: 'replied', evidence: 'bob replied: no' }] })] })
    assert.deepEqual(diffSnapshots(prev, replied).map((e) => e.title), ['Reply to your comment · api#1'])
  })

  it('keeps the org prefix off logins and the path down to the file name', () => {
    const f = finding({ author: 'gdncomm-ricardo-franclinton', path: 'product-feed-properties/src/main/java/com/gdn/product/feed/properties/FacebookClientProperties.java', line: 42, body: '**Nit:** use `Duration`' })
    const [e] = diffSnapshots(snap({ mine: [pr({ repo: 'gdncomm/product-feed' })] }), snap({ mine: [pr({ repo: 'gdncomm/product-feed', findings: [f] })] }))
    assert.equal(e.title, 'New comment · product-feed#1')
    assert.equal(e.context, 'ricardo-franclinton · FacebookClientProperties.java:42')
    assert.equal(e.message, 'Nit: use Duration')
  })

  it('reports my build failing and recovering, not every change', () => {
    const b = (/** @type {any} */ state) => ({ state, url: 'https://ci/job/PR-1/4', name: 'Jenkins CI', number: 4, at: null })
    const at = (/** @type {any} */ build) => snap({ mine: [pr({ build })] })
    assert.deepEqual(diffSnapshots(at(b('running')), at(b('failure'))).map((e) => [e.title, e.context, e.url]), [['Build failed · api#1', 'Jenkins CI #4', 'https://ci/job/PR-1/4']])
    assert.deepEqual(diffSnapshots(at(b('failure')), at(b('success'))).map((e) => e.title), ['Build fixed · api#1'])
    assert.deepEqual(diffSnapshots(at(b('running')), at(b('success'))), [], 'an ordinary pass is not news')
  })

  it('says nothing when nothing changed', () => {
    const s = snap({ mine: [pr({ findings: [finding({})] })], toReview: [pr({ id: 'P2', requested: true })] })
    assert.deepEqual(diffSnapshots(s, structuredClone(s)), [])
  })

  it('reports a new PR in a repo that was already watched, not a newly watched one', () => {
    const w = pr({ id: 'W', repo: 'o/API', author: 'dave', requested: false, watched: true })
    const before = snap({ watchedRepos: ['o/api'] })
    assert.deepEqual(diffSnapshots(before, snap({ watchedRepos: ['o/api'], toReview: [w] })).map((e) => e.title), ['New PR · API#1'])
    assert.deepEqual(diffSnapshots(snap({}), snap({ watchedRepos: ['o/api'], toReview: [w] })), [])
  })
})
