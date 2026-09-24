import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { analyzePR, claimsFix, classifyIntent, isBot, jenkinsBuild } from '../lib/analyze.js'

const me = { login: 'alice', __typename: 'User' }
const bob = { login: 'bob', __typename: 'User' }
const bot = { login: 'productivity-tools-services', __typename: 'Bot' }

let seq = 0
/** @param {any} author @param {string} body @param {string} at */
const c = (author, body, at) => ({ id: `c${++seq}`, author, body, createdAt: at, url: `https://x/${seq}` })
/** @param {string} at @param {string} [headline] */
const commit = (at, headline = 'fix things') => ({ commit: { oid: `abcdef${++seq}`.padEnd(40, '0'), committedDate: at, messageHeadline: headline } })

/** @param {Partial<import('../lib/analyze.js').RawPR>} over */
function pr(over = {}) {
  return /** @type {import('../lib/analyze.js').RawPR} */ ({
    id: 'PR1', number: 1, title: 't', url: 'u', isDraft: false, createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z', reviewDecision: null, author: me, repository: { nameWithOwner: 'o/r' },
    commits: { nodes: [] }, comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] },
    ...over,
  })
}
/** @param {any[]} comments @param {Partial<{isResolved: boolean, isOutdated: boolean}>} [flags] */
const thread = (comments, flags = {}) => ({
  id: `t${++seq}`, isResolved: false, isOutdated: false, path: 'A.java', line: 3, resolvedBy: null,
  comments: { nodes: comments }, ...flags,
})

describe('isBot', () => {
  it('detects GitHub App bots, [bot] suffix and configured logins', () => {
    assert.equal(isBot(bot), true)
    assert.equal(isBot({ login: 'dependabot[bot]', __typename: 'User' }), true)
    assert.equal(isBot({ login: 'jenkins-ci', __typename: 'User' }, ['jenkins-ci']), true)
    assert.equal(isBot(bob), false)
    assert.equal(isBot(null), false)
  })
})

describe('claimsFix', () => {
  it('reads fix claims in English and Indonesian', () => {
    assert.equal(claimsFix('Done in f0e3cf5f41 — renamed it'), true)
    assert.equal(claimsFix('fixed, thanks'), true)
    assert.equal(claimsFix('sudah diperbaiki'), true)
  })
  it('does not read explanations or refusals as fixes', () => {
    assert.equal(claimsFix('Thanks for flagging! Actually `x` here is never null.'), false)
    assert.equal(claimsFix("Won't fix, this is intended"), false)
    assert.equal(claimsFix('> please fix this\nwhy?'), false)
  })
  it('trusts the opening verdict of a long reply', () => {
    assert.equal(claimsFix('Thanks — addressed both points:\n\n1. removed it\n2. that state won\'t occur'), true)
  })
})

describe('classifyIntent', () => {
  // Phrases taken from real reviews on gdncomm PRs.
  const cases = /** @type {[string, string | null][]} */ ([
    ['**Verdict:** 🟢 `Approve`. PR size is 355 lines.', 'no-action'],
    ['Test coverage looks thorough. No blocking issues.', 'no-action'],
    ['No correctness issues found. Not auto-approving per review policy — flagging as solid for a human reviewer to approve.', 'no-action'],
    ['## Verdict 🟡 `Approve with suggestions` — the concerns are about what happens later.', 'optional'],
    ['**Nit (non-blocking):** `allowedSpecificationKeys` could be a Set.', 'optional'],
    ['Not approving per review policy — please have a human reviewer approve once the case-sensitivity concern is addressed.', null],
    ['Nothing else stood out. Two things worth a look before merge: 1. the null guard', null],
    ['No other issues found in this delta.', null],
    ['ini bisa kena exception kalo entry key nya ga parseable', null],
    ['This is a blocking bug: the cache never expires.', null],
  ])
  for (const [body, expected] of cases) {
    it(`${expected ?? 'actionable'} ← ${body.slice(0, 50)}`, () => {
      assert.equal(classifyIntent(body)?.status ?? null, expected)
    })
  }
  it('trusts GitHub review states', () => {
    assert.equal(classifyIntent('', 'APPROVED')?.status, 'no-action')
    assert.equal(classifyIntent('No blocking issues.', 'CHANGES_REQUESTED'), null)
  })
})

describe('jenkinsBuild', () => {
  /** @param {any[]} checks */
  const withChecks = (checks) => pr({ head: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] } })
  const run = (/** @type {object} */ over) => ({ __typename: 'CheckRun', name: 'Jenkins CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://jenkins-build-ci-2.gdn-app.com/job/GitHub/job/gdncomm/job/GDN/job/TRFCEE/job/product-feed/job/PR-152/3', ...over })

  it('reads the Jenkins CI check run with its build number and link (real shape)', () => {
    assert.deepEqual(jenkinsBuild(withChecks([run({ completedAt: '2026-09-24T05:00:00Z' })])), {
      state: 'success', name: 'Jenkins CI', number: 3, at: '2026-09-24T05:00:00Z',
      url: 'https://jenkins-build-ci-2.gdn-app.com/job/GitHub/job/gdncomm/job/GDN/job/TRFCEE/job/product-feed/job/PR-152/3',
    })
  })
  it('maps running, queued and failed builds', () => {
    assert.equal(jenkinsBuild(withChecks([run({ status: 'IN_PROGRESS', conclusion: null })]))?.state, 'running')
    assert.equal(jenkinsBuild(withChecks([run({ status: 'QUEUED', conclusion: null })]))?.state, 'pending')
    assert.equal(jenkinsBuild(withChecks([run({ conclusion: 'TIMED_OUT' })]))?.state, 'failure')
  })
  it('reads a Jenkins commit status too, and the worst Jenkins job wins', () => {
    const status = { __typename: 'StatusContext', context: 'continuous-integration/jenkins/pr-merge', state: 'FAILURE', targetUrl: 'https://ci/job/x/PR-1/9/display/redirect' }
    assert.deepEqual(jenkinsBuild(withChecks([run({}), status])), { state: 'failure', name: 'continuous-integration/jenkins/pr-merge', number: 9, url: status.targetUrl, at: null })
  })
  it('ignores non-Jenkins checks and missing data', () => {
    assert.equal(jenkinsBuild(withChecks([run({ name: 'SonarCloud', detailsUrl: 'https://sonarcloud.io/x' })])), null)
    assert.equal(jenkinsBuild(pr({})), null)
    assert.equal(jenkinsBuild(pr({ head: { nodes: [null, { commit: { statusCheckRollup: null } }] } })), null)
  })
})

describe('analyzePR', () => {
  it('ignores bot comments and the author’s own comments', () => {
    const s = analyzePR(pr({ comments: { nodes: [c(bot, 'Code quality', '2026-01-01T01:00:00Z'), c(me, 'note', '2026-01-01T02:00:00Z')] } }))
    assert.equal(s.hasHumanComments, false)
    assert.deepEqual(s.counts, { total: 0, fixed: 0, noAction: 0, pending: 0 })
  })

  it('classifies inline threads by resolve / reply / outdated / commit', () => {
    const s = analyzePR(pr({
      commits: { nodes: [commit('2026-01-01T05:00:00Z', 'fix: rename')] },
      reviewThreads: { nodes: [
        thread([c(bob, 'rename', '2026-01-01T01:00:00Z')], { isResolved: true }),
        thread([c(bob, 'nit', '2026-01-01T01:00:00Z'), c(me, 'Done in abc1234', '2026-01-01T02:00:00Z')]),
        thread([c(bob, 'null?', '2026-01-01T01:00:00Z')], { isOutdated: true }),
        thread([c(bob, 'why?', '2026-01-01T01:00:00Z'), c(me, 'Because the API needs it.', '2026-01-01T02:00:00Z')]),
        thread([c(bob, 'typo', '2026-01-01T01:00:00Z')]),
        thread([c(bob, 'late', '2026-01-01T06:00:00Z')]),
      ] },
    }))
    assert.deepEqual(s.findings.map((f) => f.status), ['resolved', 'fixed-reply', 'outdated', 'replied', 'commit-after', 'open'])
    assert.deepEqual(s.counts, { total: 6, fixed: 3, noAction: 0, pending: 3 })
  })

  it('judges a thread from the reviewer’s last word, not the first', () => {
    const s = analyzePR(pr({ reviewThreads: { nodes: [thread([
      c(bob, 'rename', '2026-01-01T01:00:00Z'),
      c(me, 'done', '2026-01-01T02:00:00Z'),
      c(bob, 'still wrong', '2026-01-01T03:00:00Z'),
    ])] } }))
    assert.equal(s.findings[0].status, 'open')
  })

  it('does not count merge commits from the base branch as fixes', () => {
    const s = analyzePR(pr({
      commits: { nodes: [commit('2026-01-01T05:00:00Z', "Merge branch 'release' into feature/x")] },
      comments: { nodes: [c(bob, 'please add a test', '2026-01-01T01:00:00Z')] },
    }))
    assert.equal(s.findings[0].status, 'open')
  })

  it('matches top-level author replies by @mention', () => {
    const carol = { login: 'carol', __typename: 'User' }
    const s = analyzePR(pr({
      reviews: { nodes: [
        { ...c(bob, 'two issues', '2026-01-01T01:00:00Z'), state: 'COMMENTED' },
        { ...c(carol, 'one issue', '2026-01-01T01:00:00Z'), state: 'CHANGES_REQUESTED' },
        { ...c(bob, '', '2026-01-01T01:00:00Z'), state: 'COMMENTED' },
      ] },
      comments: { nodes: [c(me, 'Thanks @bob — addressed both.', '2026-01-01T02:00:00Z')] },
    }))
    const byAuthor = Object.fromEntries(s.findings.map((f) => [f.author, f.status]))
    assert.deepEqual(byAuthor, { bob: 'fixed-reply', carol: 'open' })
    assert.equal(s.findings.length, 2, 'an empty COMMENTED review is not a finding')
  })

  it('survives null connections and null nodes (hidden by SSO / deleted accounts)', () => {
    const s = analyzePR(pr({
      // @ts-expect-error — GitHub really sends these shapes
      commits: { nodes: [null, { commit: null }, commit('2026-01-01T05:00:00Z')] },
      // @ts-expect-error
      comments: { nodes: [null, c(null, 'ghost says hi', '2026-01-01T01:00:00Z')] },
      // @ts-expect-error
      reviews: null,
      // @ts-expect-error
      reviewThreads: { nodes: [null, thread([null, c(bob, 'hm', '2026-01-01T01:00:00Z')])] },
    }))
    // The deleted ("ghost", author null) account cannot be judged human, so only bob's thread counts.
    assert.deepEqual(s.findings.map((f) => [f.author, f.status]), [['bob', 'commit-after']])
  })

  it('counts no-action comments apart from fixed and unfixed', () => {
    const s = analyzePR(pr({
      reviews: { nodes: [
        { ...c(bob, 'No blocking issues.', '2026-01-01T01:00:00Z'), state: 'COMMENTED' },
        { ...c(bob, 'please add a test', '2026-01-01T01:00:00Z'), state: 'COMMENTED' },
      ] },
      reviewThreads: { nodes: [
        thread([c(bob, 'nit (non-blocking): rename', '2026-01-01T01:00:00Z')]),
        thread([c(bob, 'nit: rename', '2026-01-01T01:00:00Z'), c(bob, 'actually this breaks the build', '2026-01-01T02:00:00Z')]),
      ] },
    }))
    assert.deepEqual(s.findings.map((f) => f.status).sort(), ['no-action', 'open', 'open', 'optional'])
    assert.deepEqual(s.counts, { total: 4, fixed: 0, noAction: 2, pending: 2 })
  })
})
