import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fetchSprint } from '../lib/github.js'
import { refresh } from '../lib/refresh.js'
import { buildSprint, classify, formatValue, p75, RULES, scoreAll, sprintAt, sprintSearches } from '../lib/sprint.js'

const H = 3_600_000
/** Hours after SP19 began (2026-10-05 00:00 WIB). */
const at = (/** @type {number} */ h) => new Date(Date.parse('2026-10-05T00:00:00+07:00') + h * H).toISOString()
const user = (/** @type {string} */ login) => ({ login, __typename: 'User' })
/** SP19 once it's over (sprintAt only knows the sprint at a time, so the finished one is spelled out). */
const SP19 = /** @type {import('../lib/sprint.js').SprintWindow} */ ({
  ...sprintAt(Date.parse('2026-10-16T12:00:00+07:00')),
  current: false, until: Date.parse('2026-10-19T00:00:00+07:00'), weeks: 2, day: 10,
})

/** One of my PRs in a scored repo, opened at `open`, first commit 3 h before. */
function pr(/** @type {number} */ n, /** @type {number} */ open, /** @type {Record<string, unknown>} */ over = {}) {
  return {
    number: n, title: `t${n}`, url: `u${n}`, state: 'OPEN', createdAt: at(open), mergedAt: null,
    additions: 100, deletions: 20, baseRefName: 'release/x',
    repository: { nameWithOwner: 'gdncomm/seo-backend' }, author: user('me'),
    commits: { nodes: [{ commit: { authoredDate: at(open - 3), committedDate: at(open - 3) } }, { commit: { authoredDate: at(open + 1), committedDate: at(open + 1) } }] },
    reviews: { nodes: [{ author: user('ana'), submittedAt: at(open + 2), state: 'APPROVED' }] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    ...over,
  }
}

describe('sprint calendar', () => {
  it('the sprint today, its WIB window and weeks so far', () => {
    const w = /** @type {import('../lib/sprint.js').SprintWindow} */ (sprintAt(Date.parse('2026-10-23T12:00:00+07:00')))
    assert.equal(w.name, 'SP20')
    assert.equal(w.current, true)
    assert.equal(new Date(w.from).toISOString(), '2026-10-18T17:00:00.000Z')
    assert.equal(w.day, 5)
    assert.equal(w.weeks, 1)
    assert.equal(sprintAt(Date.parse('2026-10-27T12:00:00+07:00'))?.weeks, 1.4)
    assert.equal(sprintAt(Date.parse('2026-10-19T09:00:00+07:00'))?.weeks, 1, 'never divides by less than a week')
  })
  it('the last days of a sprint, weekend included, still belong to it', () => {
    const w = sprintAt(Date.parse('2026-10-18T22:00:00+07:00'))
    assert.equal(w?.name, 'SP19')
    assert.equal(w?.current, true)
    assert.equal(w?.weeks, 2)
    assert.equal(w?.day, 10)
  })
  it('in a gap week, the sprint before it', () => {
    const w = sprintAt(Date.parse('2026-07-22T10:00:00+07:00'))
    assert.equal(w?.name, 'SP13')
    assert.equal(w?.between?.name, 'Gap week')
  })
  it('outside the calendar: nothing', () => assert.equal(sprintAt(Date.parse('2027-03-01T00:00:00Z')), null))
  it('searches keep the WIB midnight and gdncomm', () => {
    const q = sprintSearches(SP19)
    assert.equal(q.created, 'is:pr org:gdncomm author:@me created:2026-10-05T00:00:00+07:00..2026-10-18T23:59:59+07:00')
    assert.match(q.reviewed, /reviewed-by:@me -author:@me updated:>=2026-10-05T00:00:00\+07:00/)
  })
})

describe('scoring', () => {
  it('P75 interpolates like numpy', () => {
    assert.equal(p75([1, 2, 3, 4]), 3.25)
    assert.equal(p75([5]), 5)
    assert.equal(p75([]), null)
  })
  it('classify follows scoring.json, a threshold gap falls to the worse tier', () => {
    assert.equal(classify(RULES.pr_size, 250), 'ELITE')
    assert.equal(classify(RULES.pr_size, 0), 'NO_ACTIVITY')
    assert.equal(classify(RULES.created_prs, 4.5), 'HIGH')
    assert.equal(classify(RULES.cycle_time_variance, 1.5), 'HIGH')
    assert.equal(classify(RULES.cycle_time_variance, 4.5), 'MEDIUM')
    assert.equal(classify(RULES.cycle_time, null), 'NO_ACTIVITY')
  })
  it('categories sum points; overall is their mean, rounded like Python', () => {
    const card = scoreAll({
      cycle_time: { value: 20, samples: 1 }, coding_time: { value: 1, samples: 1 }, cycle_time_variance: { value: 3, samples: 2 },
      commits_after_pr: { value: 1, samples: 1 }, pr_size: { value: 300, samples: 1 }, unreviewed_prs_merged: { value: 0, samples: 1 },
      created_prs: { value: 6, samples: 6 }, merge_rate: { value: 100, samples: 6 }, coding_days: { value: 5, samples: 5 }, lines_changed: { value: 100, samples: 6 },
      time_to_first_comment: { value: 7, samples: 1 }, comment_count_per_pr: { value: 3, samples: 1 }, prs_reviewed: { value: 1, samples: 1 },
    })
    assert.deepEqual(card.categories.map((c) => [c.key, c.score, c.tier]), [['speed', 95, 'ELITE'], ['quality', 95, 'ELITE'], ['throughput', 75, 'HIGH'], ['collaboration', 75, 'HIGH']])
    assert.equal(card.overall, 85)
    assert.equal(card.overallTier, 'HIGH', 'Elite needs more than 85')
    assert.equal(card.metrics.pr_size.next, 'Elite at ≤ 250 lines (+5 pts)')
    assert.equal(card.metrics.time_to_first_comment.next, 'Elite at ≤ 6h (+10 pts)')
    assert.equal(card.metrics.cycle_time.next, '')
    assert.equal(card.metrics.pick_up_time.tier, 'NO_ACTIVITY')
    assert.equal(formatValue(card.metrics.created_prs), '6/wk')
    assert.equal(formatValue(card.metrics.pr_size), '300 lines')
    assert.equal(formatValue(card.metrics.pick_up_time), '—')
    const tie = scoreAll({ cycle_time: { value: 20, samples: 1 }, coding_time: { value: 1, samples: 1 }, cycle_time_variance: { value: 3, samples: 2 }, commits_after_pr: { value: 1, samples: 1 }, pr_size: { value: 300, samples: 1 }, unreviewed_prs_merged: { value: 0, samples: 1 }, created_prs: { value: 6, samples: 6 }, merge_rate: { value: 100, samples: 6 }, coding_days: { value: 5, samples: 5 }, lines_changed: { value: 100, samples: 6 }, time_to_first_comment: { value: 7, samples: 1 }, comment_count_per_pr: { value: 3, samples: 1 }, prs_reviewed: { value: 3, samples: 3 } })
    assert.equal(tie.overall, 86.2, '345 / 4 = 86.25 rounds to even, as Python does')
  })
})

describe('buildSprint', () => {
  const merged = pr(2, 30, { state: 'MERGED', mergedAt: at(40) })
  const card = buildSprint({
    login: 'me',
    window: SP19,
    created: [pr(1, 10), merged, pr(3, 50, { baseRefName: 'master' }), pr(4, -20)],
    merged: [merged, pr(5, -30, { state: 'MERGED', mergedAt: at(5), reviews: { nodes: [] } })],
    reviewed: [pr(9, 20, { author: user('ana'), reviews: { nodes: [{ author: user('me'), submittedAt: at(25), state: 'APPROVED' }] } }), pr(10, 20, { author: user('ana'), reviews: { nodes: [{ author: user('me'), submittedAt: at(-50), state: 'APPROVED' }] } })],
    open: [],
    now: Date.parse(at(400)),
  })
  const m = /** @type {import('../lib/sprint.js').Scorecard} */ (card.card).metrics
  it('scores only PRs in scope and in the window', () => {
    assert.deepEqual(card.prs.map((p) => p.ref), ['gdncomm/seo-backend#2', 'gdncomm/seo-backend#1'])
    assert.equal(m.created_prs.raw, 2)
    assert.equal(m.created_prs.value, 1)
  })
  it('merged PRs: cycle time, unreviewed share, merge rate', () => {
    assert.equal(m.cycle_time.samples, 2)
    assert.equal(m.unreviewed_prs_merged.value, 50)
    assert.equal(m.merge_rate.value, 50)
  })
  it('PRs reviewed: someone else\'s, reviewed by me inside the window', () => assert.equal(m.prs_reviewed.raw, 1))
  it('per-PR rows for the tab', () => {
    const one = card.prs[1]
    assert.equal(one.size, 120)
    assert.equal(one.codingH, 3)
    assert.equal(one.commitsAfter, 1)
    assert.equal(one.firstResponseH, 2)
    assert.equal(one.cycleH, null)
  })
  it('nothing in the sprint: no card, not a page of zeros', () =>
    assert.equal(buildSprint({ login: 'me', window: SP19, created: [], merged: [], reviewed: [], open: [] }).card, null))
})

describe('fetchSprint', () => {
  it('reads every page of each search', async () => {
    /** @type {any[]} */
    const seen = []
    const fetchImpl = /** @type {typeof fetch} */ (async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      seen.push(body.variables)
      const page = body.variables.after ? 2 : 1
      return new Response(JSON.stringify({ data: { viewer: { login: 'me' }, search: { issueCount: 2, pageInfo: { hasNextPage: page === 1, endCursor: 'c1' }, nodes: [pr(page, 10), {}] } } }))
    })
    const got = await fetchSprint({ token: 't', searches: { created: 'q1' }, fetchImpl, retryDelays: [] })
    assert.equal(got.viewer, 'me')
    assert.deepEqual(got.results.created.map((p) => p.number), [1, 2])
    assert.deepEqual(seen, [{ q: 'q1', after: null }, { q: 'q1', after: 'c1' }])
  })
})

describe('refresh keeps the sprint card', () => {
  const memory = () => {
    /** @type {Record<string, unknown>} */ const data = {}
    return { data, get: async (/** @type {string} */ k) => ({ [k]: data[k] }), set: async (/** @type {Record<string, unknown>} */ o) => void Object.assign(data, o) }
  }
  const dashboard = { data: { viewer: { login: 'me' }, rateLimit: { remaining: 1 }, mine: { issueCount: 0, nodes: [] }, requested: { issueCount: 0, nodes: [] }, reviewed: { issueCount: 0, nodes: [] } } }
  /** @param {boolean} sprintFails */
  const github = (sprintFails) => /** @type {typeof fetch} */ (async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    if (!body.query.includes('query Sprint')) return new Response(JSON.stringify(dashboard))
    if (sprintFails) return new Response('{}', { status: 502 })
    return new Response(JSON.stringify({ data: { viewer: { login: 'me' }, search: { pageInfo: { hasNextPage: false }, nodes: [] } } }))
  })

  it('stored with the snapshot; a failed sprint search keeps the last card and says why', async () => {
    const area = memory()
    await area.set({ settings: { token: 't' } })
    const first = await refresh({ area, fetchImpl: github(false), retryDelays: [] })
    assert.ok(first.sprint?.sprint.name)
    const second = await refresh({ area, fetchImpl: github(true), retryDelays: [] })
    assert.equal(second.sprint?.computedAt, first.sprint?.computedAt)
    assert.match(String(second.sprint?.error), /502/)
  })
  it('not asked when OrgSignals is off', async () => {
    const area = memory()
    await area.set({ settings: { token: 't', signals: false } })
    assert.equal((await refresh({ area, fetchImpl: github(false), retryDelays: [] })).sprint, undefined)
  })
})
