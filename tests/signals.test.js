import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { analyzePR } from '../lib/analyze.js'
import { formatHours, inScope, isSignalsBot, prSignals, readings, tierOf, worstTier } from '../lib/signals.js'

const H = 3_600_000
const at = (/** @type {number} */ hours) => new Date(Date.UTC(2026, 8, 28, 0) + hours * H).toISOString()
const user = (/** @type {string} */ login) => ({ login, __typename: 'User' })

/** An open PR in a scored repo, opened at hour 10, first commit at hour 7. */
function pr(/** @type {Record<string, unknown>} */ over = {}) {
  return {
    id: 'P1', number: 7, title: 't', url: 'u', isDraft: false, createdAt: at(10), updatedAt: at(12), reviewDecision: null,
    author: user('me'),
    repository: { nameWithOwner: 'gdncomm/seo-backend' },
    baseRefName: 'master',
    additions: 300, deletions: 20,
    commits: { totalCount: 3, nodes: [
      { commit: { oid: 'a', authoredDate: at(7), committedDate: at(9), messageHeadline: 'one' } },
      { commit: { oid: 'b', authoredDate: at(11), committedDate: at(11), messageHeadline: 'two' } },
      { commit: { oid: 'c', authoredDate: at(12), committedDate: at(12), messageHeadline: 'Merge branch master into x' } },
    ] },
    firstCommit: { nodes: [{ commit: { authoredDate: at(7) } }] },
    reviews: { nodes: [
      { id: 'r1', author: user('ana'), state: 'COMMENTED', body: '', createdAt: at(13), submittedAt: at(14), url: '' },
      { id: 'r2', author: user('me'), state: 'COMMENTED', body: 'self', createdAt: at(11), submittedAt: at(11), url: '' },
      { id: 'r3', author: { login: 'sonarcloud', __typename: 'Bot' }, state: 'COMMENTED', body: 'bot', createdAt: at(10.5), url: '' },
    ] },
    reviewThreads: { nodes: [
      { id: 't1', isResolved: false, isOutdated: false, path: 'a.js', line: 1, resolvedBy: null, comments: { nodes: [
        { id: 'c1', author: user('bob'), body: 'nit', createdAt: at(12), url: '' },
        { id: 'c2', author: user('ci-jenkins'), body: 'build', createdAt: at(10.2), url: '' },
      ] } },
    ] },
    comments: { nodes: [{ id: 'g1', author: user('cara'), body: 'lgtm?', createdAt: at(10.1), url: '' }] },
    ...over,
  }
}

describe('OrgSignals scope', () => {
  it('scores team repos merging into master or release/*', () => {
    assert.equal(inScope('gdncomm/seo-backend', 'master'), true)
    assert.equal(inScope('gdncomm/Seo-Backend', 'release/2026.10'), true)
  })
  it('never deployment (nonprod / prod) repos, other repos or other branches', () => {
    assert.equal(inScope('gdncomm/seo-backend-deployment-nonprod', 'master'), false)
    assert.equal(inScope('gdncomm/seo-backend-deployment-prod', 'master'), false)
    assert.equal(inScope('gdncomm/nonprod-rundeck-gdn-preprod', 'master'), false)
    assert.equal(inScope('gdncomm/prod-infra-gdn-traffic-tracker-aggregator-mongo-updates', 'master'), false)
    assert.equal(inScope('gdncomm/pr-tracker', 'master'), false)
    assert.equal(inScope('acme/seo-backend', 'master'), false)
    assert.equal(inScope('gdncomm/seo-backend', 'develop'), false)
    assert.equal(inScope('gdncomm/seo-backend', 'release'), false)
    assert.equal(inScope('gdncomm/seo-backend', undefined), false)
  })
  it('out of scope means no metrics on the PR at all', () => {
    assert.equal(prSignals(pr({ repository: { nameWithOwner: 'gdncomm/seo-backend-deployment-prod' } })), undefined)
    assert.equal(analyzePR(/** @type {any} */ (pr({ baseRefName: 'develop' }))).signals, undefined)
    assert.ok(analyzePR(/** @type {any} */ (pr())).signals)
  })
})

describe('prSignals', () => {
  const f = /** @type {import('../lib/signals.js').SignalsFacts} */ (prSignals(pr()))
  it('measures from the earliest authored commit', () => assert.equal(f.firstCommitAt, at(7)))
  it('PR size is additions + deletions', () => assert.equal(f.lines, 320))
  it('counts every commit pushed after opening, merges included', () => assert.equal(f.commitsAfter, 2))
  it('first response: a review (when submitted) or inline comment by someone else; not bots, Jenkins, the author or conversation comments', () =>
    assert.equal(f.firstResponseAt, at(12)))
  it('comments: reviews + inline + conversation by other humans', () => assert.equal(f.comments, 3))
  it('reviewed once someone else reviewed', () => assert.equal(f.reviewed, true))
  it('a first commit after opening (rebased) never makes coding time negative', () =>
    assert.equal(prSignals(pr({ firstCommit: { nodes: [{ commit: { authoredDate: at(20) } }] }, commits: { nodes: [] } }))?.firstCommitAt, at(10)))
  it('more commits than fetched, all after opening: a lower bound', () => {
    const many = prSignals(pr({ commits: { totalCount: 80, nodes: [{ commit: { oid: 'x', authoredDate: at(11), committedDate: at(11), messageHeadline: 'x' } }] } }))
    assert.equal(many?.commitsAfter, 1)
    assert.equal(many?.commitsAfterAtLeast, true)
  })
  it('the bot rule is OrgSignals\', not the page\'s list', () => {
    assert.equal(isSignalsBot(null), true)
    assert.equal(isSignalsBot(user('renovate[bot]')), true)
    assert.equal(isSignalsBot(user('svc-jenkins-ci')), true)
    assert.equal(isSignalsBot(user('ana')), false)
  })
})

describe('tiers', () => {
  it('follow scoring.json bounds', () => {
    assert.equal(tierOf('pr_size', 250), 'ELITE')
    assert.equal(tierOf('pr_size', 251), 'HIGH')
    assert.equal(tierOf('pr_size', 600), 'MEDIUM')
    assert.equal(tierOf('pr_size', 1410), 'NEEDS_FOCUS')
    assert.equal(tierOf('time_to_first_comment', 6), 'ELITE')
    assert.equal(tierOf('time_to_first_comment', 31), 'NEEDS_FOCUS')
    assert.equal(tierOf('commits_after_pr', 0), 'ELITE')
    assert.equal(tierOf('cycle_time', 97), 'HIGH')
  })
  it('zero comments or lines is no activity, not elite', () => {
    assert.equal(tierOf('comment_count_per_pr', 0), 'NO_ACTIVITY')
    assert.equal(tierOf('pr_size', 0), 'NO_ACTIVITY')
  })
})

describe('readings', () => {
  const f = /** @type {import('../lib/signals.js').SignalsFacts} */ (prSignals(pr()))
  const byKey = (/** @type {import('../lib/signals.js').Reading[]} */ list) => Object.fromEntries(list.map((r) => [r.key, r]))
  it('one chip per metric, with its tier and the scale in the tooltip', () => {
    const r = byKey(readings(f, Date.parse(at(30))))
    assert.deepEqual(Object.keys(r), ['pr_size', 'coding_time', 'commits_after_pr', 'time_to_first_comment', 'comment_count_per_pr', 'cycle_time'])
    assert.equal(r.pr_size.text, 'Size 320')
    assert.equal(r.pr_size.tier, 'HIGH')
    assert.match(r.pr_size.title, /PR size: 320 lines — High\. .*Elite ≤ 250 lines/)
    assert.equal(r.coding_time.text, 'Coding 3h')
    assert.equal(r.commits_after_pr.text, '2 after open')
    assert.equal(r.time_to_first_comment.text, '1st review 2h')
    assert.equal(r.cycle_time.text, 'Cycle 23h')
    assert.match(r.cycle_time.title, /if merged now/)
    assert.equal(r.pr_size.value, '320 lines')
    assert.match(r.pr_size.scale, /^Elite ≤ 250 lines, High ≤ 400 lines, Medium ≤ 600 lines/)
    assert.equal(r.cycle_time.value, '23h')
    assert.equal(r.cycle_time.note, 'so far · if merged now')
  })
  it('the button takes the weakest tier', () => {
    assert.equal(worstTier(readings(f, Date.parse(at(30)))), 'HIGH')
    assert.equal(worstTier(readings(f, Date.parse(at(300)))), 'NEEDS_FOCUS')
    assert.equal(worstTier([]), 'ELITE')
  })
  it('no review yet: the clock keeps running, and merging now would count as unreviewed', () => {
    const lonely = /** @type {import('../lib/signals.js').SignalsFacts} */ (prSignals(pr({ reviews: { nodes: [] }, reviewThreads: { nodes: [] }, comments: { nodes: [] } })))
    const r = byKey(readings(lonely, Date.parse(at(50))))
    assert.equal(r.time_to_first_comment.text, 'No review · 40h')
    assert.equal(r.time_to_first_comment.tier, 'NEEDS_FOCUS')
    assert.equal(r.comment_count_per_pr.tier, 'NO_ACTIVITY')
    assert.equal(r.unreviewed_prs_merged.text, 'Unreviewed')
    assert.equal(r.time_to_first_comment.value, '40h')
    assert.equal(r.time_to_first_comment.note, 'no review yet · if someone reviews now')
    const late = byKey(readings(lonely, Date.parse(at(300))))
    assert.equal(late.cycle_time.value, '12d')
    assert.equal(late.cycle_time.note, 'so far · 293h · if merged now', 'OrgSignals counts hours: say how many')
  })
  it('hours read short', () => {
    assert.equal(formatHours(0.2), '12m')
    assert.equal(formatHours(0.9999), '1h', 'never "60m"')
    assert.equal(formatHours(5.25), '5.3h')
    assert.equal(formatHours(99.94), '99.9h')
    assert.equal(formatHours(241.04), '10d')
  })
})
