/**
 * The whole-sprint OrgSignals scorecard: the 13 scored metrics, 3 context
 * metrics, 4 category scores and the overall score, ported from the
 * growth-signals `sprint-score` skill (`scripts/metrics.py`, `scoring.py`,
 * `sprint_calendar.py`; rules and calendar from its `references/`, 0.6.2).
 *
 * Same scope as the per-PR metrics (`signals.js` → inScope): the team's
 * tracked repos, merging into `release/*` only.
 *
 * When the lead changes thresholds or the calendar gets a new year, update
 * RULES / PERIODS here.
 */

import { formatHours, inScope, isSignalsBot } from './signals.js'

/** @typedef {import('./signals.js').Tier} Tier */
/** @typedef {[('gt' | 'ge' | 'lt' | 'le' | 'eq'), number]} Cond */
/** @typedef {{label: string, unit: string, better: 'lower' | 'higher', means: string, tiers: {tier: Tier, points: number, conds: Cond[]}[]}} Rule */

/** @param {number} e @param {number} h @param {number} m @param {number[]} [p] tiers for "lower is better", Elite from 0.01 (a duration) */
const duration = (e, h, m, p = [0, 0, 0, 0]) => /** @type {Rule['tiers']} */ ([
  { tier: 'ELITE', points: p[0], conds: [['ge', 0.01], ['le', e]] },
  { tier: 'HIGH', points: p[1], conds: [['gt', e], ['le', h]] },
  { tier: 'MEDIUM', points: p[2], conds: [['gt', h], ['le', m]] },
  { tier: 'NEEDS_FOCUS', points: p[3], conds: [['gt', m]] },
  { tier: 'NO_ACTIVITY', points: 0, conds: [['eq', 0]] },
])

/** @param {number} e @param {number} h @param {number} m @param {number[]} p "higher is better", per week: Elite > e, High ≥ h, Medium ≥ m */
const perWeek = (e, h, m, p) => /** @type {Rule['tiers']} */ ([
  { tier: 'ELITE', points: p[0], conds: [['gt', e]] },
  { tier: 'HIGH', points: p[1], conds: [['ge', h], ['le', e]] },
  { tier: 'MEDIUM', points: p[2], conds: [['ge', m], ['lt', h]] },
  { tier: 'NEEDS_FOCUS', points: p[3], conds: [['gt', 0], ['lt', m]] },
  { tier: 'NO_ACTIVITY', points: 0, conds: [['le', 0]] },
])

/** scoring.json → metrics, as of growth-signals 0.6.2. @type {Record<string, Rule>} */
export const RULES = {
  cycle_time: { label: 'Cycle time', unit: 'h', better: 'lower', means: 'first commit → merged, P75 of PRs merged in the period', tiers: duration(27, 97, 174, [50, 40, 30, 20]) },
  coding_time: { label: 'Coding time', unit: 'h', better: 'lower', means: 'first commit → PR opened, P75 of PRs opened in the period', tiers: duration(2, 9, 28, [25, 15, 10, 5]) },
  cycle_time_variance: {
    label: 'Cycle time variance', unit: 'h', better: 'lower', means: 'how much cycle times differ (standard deviation), 2+ merged PRs',
    tiers: [
      { tier: 'ELITE', points: 25, conds: [['ge', 0.01], ['le', 1]] },
      { tier: 'HIGH', points: 20, conds: [['gt', 2], ['le', 4]] },
      { tier: 'MEDIUM', points: 15, conds: [['gt', 5], ['le', 10]] },
      { tier: 'NEEDS_FOCUS', points: 10, conds: [['gt', 10]] },
      { tier: 'NO_ACTIVITY', points: 0, conds: [['eq', 0]] },
    ],
  },
  commits_after_pr: {
    label: 'Commits after PR raised', unit: '', better: 'lower', means: 'commits pushed after opening, P75 of PRs opened in the period',
    tiers: [
      { tier: 'ELITE', points: 40, conds: [['ge', 0], ['le', 1]] },
      { tier: 'HIGH', points: 30, conds: [['gt', 1], ['le', 4]] },
      { tier: 'MEDIUM', points: 20, conds: [['gt', 4], ['le', 5]] },
      { tier: 'NEEDS_FOCUS', points: 10, conds: [['gt', 5]] },
      { tier: 'NO_ACTIVITY', points: 0, conds: [['eq', -1]] },
    ],
  },
  pr_size: {
    label: 'PR size', unit: 'lines', better: 'lower', means: 'lines added + deleted, P75 of PRs opened in the period',
    tiers: [
      { tier: 'ELITE', points: 30, conds: [['gt', 0], ['le', 250]] },
      { tier: 'HIGH', points: 25, conds: [['gt', 250], ['le', 400]] },
      { tier: 'MEDIUM', points: 20, conds: [['gt', 400], ['le', 600]] },
      { tier: 'NEEDS_FOCUS', points: 15, conds: [['gt', 600]] },
      { tier: 'NO_ACTIVITY', points: 0, conds: [['eq', 0]] },
    ],
  },
  unreviewed_prs_merged: {
    label: 'Unreviewed PRs merged', unit: '%', better: 'lower', means: 'share of PRs merged in the period that nobody else reviewed',
    tiers: [
      { tier: 'ELITE', points: 30, conds: [['ge', 0], ['le', 5]] },
      { tier: 'HIGH', points: 25, conds: [['gt', 5], ['le', 15]] },
      { tier: 'MEDIUM', points: 20, conds: [['gt', 15], ['le', 25]] },
      { tier: 'NEEDS_FOCUS', points: 15, conds: [['gt', 25]] },
      { tier: 'NO_ACTIVITY', points: 0, conds: [['le', -1]] },
    ],
  },
  created_prs: { label: 'Created PRs', unit: '/wk', better: 'higher', means: 'PRs opened per week', tiers: perWeek(5, 4, 2, [30, 20, 10, 5]) },
  merge_rate: {
    label: 'Merge rate', unit: '%', better: 'higher', means: 'share of PRs opened in the period that are merged',
    tiers: [
      { tier: 'ELITE', points: 20, conds: [['gt', 90]] },
      { tier: 'HIGH', points: 15, conds: [['gt', 75], ['le', 90]] },
      { tier: 'MEDIUM', points: 10, conds: [['gt', 60], ['le', 75]] },
      { tier: 'NEEDS_FOCUS', points: 5, conds: [['gt', 0], ['le', 60]] },
      { tier: 'NO_ACTIVITY', points: 0, conds: [['eq', 0]] },
    ],
  },
  coding_days: {
    label: 'Coding days', unit: '/wk', better: 'higher', means: 'days with a commit of yours (WIB), per week',
    tiers: [
      { tier: 'ELITE', points: 20, conds: [['gt', 4]] },
      { tier: 'HIGH', points: 15, conds: [['ge', 3], ['le', 4]] },
      { tier: 'MEDIUM', points: 10, conds: [['gt', 1], ['lt', 3]] },
      { tier: 'NEEDS_FOCUS', points: 5, conds: [['gt', 0], ['le', 1]] },
      { tier: 'NO_ACTIVITY', points: 0, conds: [['le', 0]] },
    ],
  },
  lines_changed: {
    label: 'Lines of code changed', unit: '/wk', better: 'higher', means: 'lines added + deleted in PRs opened in the period, per week',
    tiers: [
      { tier: 'ELITE', points: 30, conds: [['ge', 500]] },
      { tier: 'HIGH', points: 20, conds: [['ge', 375], ['lt', 500]] },
      { tier: 'MEDIUM', points: 10, conds: [['ge', 250], ['lt', 375]] },
      { tier: 'NEEDS_FOCUS', points: 5, conds: [['gt', 0], ['lt', 250]] },
      { tier: 'NO_ACTIVITY', points: 0, conds: [['le', 0]] },
    ],
  },
  time_to_first_comment: { label: 'Time to first comment', unit: 'h', better: 'lower', means: 'PR opened → first review or inline comment by someone else, P75', tiers: duration(6, 18, 30, [40, 30, 20, 10]) },
  comment_count_per_pr: {
    label: 'Comment count per PR', unit: '', better: 'lower', means: 'reviews + inline + conversation comments by others, P75 of PRs opened in the period',
    tiers: [
      { tier: 'ELITE', points: 40, conds: [['gt', 0], ['le', 5]] },
      { tier: 'HIGH', points: 30, conds: [['gt', 5], ['le', 10]] },
      { tier: 'MEDIUM', points: 20, conds: [['gt', 10], ['le', 15]] },
      { tier: 'NEEDS_FOCUS', points: 10, conds: [['gt', 15]] },
      { tier: 'NO_ACTIVITY', points: 0, conds: [['le', 0]] },
    ],
  },
  prs_reviewed: {
    label: 'PRs reviewed', unit: '/wk', better: 'higher', means: 'other people\'s PRs you reviewed, per week',
    tiers: [
      { tier: 'ELITE', points: 20, conds: [['gt', 5]] },
      { tier: 'HIGH', points: 15, conds: [['ge', 4], ['le', 5]] },
      { tier: 'MEDIUM', points: 10, conds: [['ge', 2], ['lt', 4]] },
      { tier: 'NEEDS_FOCUS', points: 5, conds: [['gt', 0], ['lt', 2]] },
      { tier: 'NO_ACTIVITY', points: 0, conds: [['eq', 0]] },
    ],
  },
  pick_up_time: { label: 'Pick-up time', unit: 'h', better: 'lower', means: 'PR opened → first response (part of cycle time; not scored)', tiers: [...duration(3, 4, 15)].map((t, i) => (i === 0 ? { ...t, conds: [['ge', 0.05], ['le', 3]] } : t)) },
  review_time: { label: 'Review time', unit: 'h', better: 'lower', means: 'first response → last approval (part of cycle time; not scored)', tiers: [...duration(3, 10, 22)].map((t, i) => (i === 0 ? { ...t, conds: [['ge', 0.05], ['le', 3]] } : t)) },
  merge_time: { label: 'Merge time', unit: 'h', better: 'lower', means: 'last approval → merged (part of cycle time; not scored)', tiers: [...duration(3, 4, 14)].map((t, i) => (i === 0 ? { ...t, conds: [['ge', 0.05], ['le', 3]] } : t)) },
}

export const CATEGORIES = [
  { key: 'speed', label: 'Speed', metrics: ['cycle_time', 'coding_time', 'cycle_time_variance'] },
  { key: 'quality', label: 'Quality', metrics: ['commits_after_pr', 'pr_size', 'unreviewed_prs_merged'] },
  { key: 'throughput', label: 'Throughput', metrics: ['created_prs', 'merge_rate', 'coding_days', 'lines_changed'] },
  { key: 'collaboration', label: 'Collaboration', metrics: ['time_to_first_comment', 'comment_count_per_pr', 'prs_reviewed'] },
]
export const CONTEXT = ['pick_up_time', 'review_time', 'merge_time']
/** Category and overall score → tier: the first whose `gt` the score beats. */
const CATEGORY_TIERS = /** @type {const} */ ([['ELITE', 85], ['HIGH', 70], ['MEDIUM', 55], ['NEEDS_FOCUS', 0]])

/** sprint-calendar.json (Confluence "Sprint Global Calendar 2026", v20). Dates are WIB. */
export const PERIODS = /** @type {{kind: 'sprint' | 'gap' | 'hack', name: string, start: string, end: string}[]} */ ([
  ['SP01', '2026-01-05', '2026-01-16'], ['SP02', '2026-01-19', '2026-01-30'], ['SP03', '2026-02-02', '2026-02-13'],
  ['SP04', '2026-02-16', '2026-02-27'], ['SP05', '2026-03-02', '2026-03-13'], ['gap', '2026-03-16', '2026-03-20'],
  ['SP06', '2026-03-23', '2026-04-03'], ['SP07', '2026-04-06', '2026-04-17'], ['SP08', '2026-04-20', '2026-05-01'],
  ['hack', '2026-05-04', '2026-05-08'], ['SP09', '2026-05-11', '2026-05-22'], ['SP10', '2026-05-25', '2026-06-05'],
  ['SP11', '2026-06-08', '2026-06-19'], ['SP12', '2026-06-22', '2026-07-03'], ['SP13', '2026-07-06', '2026-07-17'],
  ['gap', '2026-07-20', '2026-07-24'], ['SP14', '2026-07-27', '2026-08-07'], ['SP15', '2026-08-10', '2026-08-21'],
  ['SP16', '2026-08-24', '2026-09-04'], ['SP17', '2026-09-07', '2026-09-18'], ['SP18', '2026-09-21', '2026-10-02'],
  ['SP19', '2026-10-05', '2026-10-16'], ['SP20', '2026-10-19', '2026-10-30'], ['SP21', '2026-11-02', '2026-11-13'],
  ['SP22', '2026-11-16', '2026-11-27'], ['SP23', '2026-11-30', '2026-12-11'], ['SP24', '2026-12-14', '2026-12-25'],
  ['gap', '2026-12-28', '2027-01-01'], ['SP01', '2027-01-04', '2027-01-15'],
].map(([name, start, end]) => ({
  kind: name === 'gap' ? 'gap' : name === 'hack' ? 'hack' : 'sprint',
  name: name === 'gap' ? 'Gap week' : name === 'hack' ? 'Hack week' : name,
  start,
  end,
})))

const DAY = 86_400_000
const H = 3_600_000
const WIB = 7 * H
/** 00:00 WIB of a calendar date. @param {string} date YYYY-MM-DD */
const midnight = (date) => Date.parse(`${date}T00:00:00+07:00`)
/** The WIB calendar date of an instant. @param {number} ms */
export const wibDate = (ms) => new Date(ms + WIB).toISOString().slice(0, 10)
/** ISO with the WIB offset, so GitHub's search uses the calendar's midnight. @param {number} ms */
export const wibIso = (ms) => `${new Date(ms + WIB).toISOString().slice(0, 19)}+07:00`

/** Mon–Fri dates in [first, last], inclusive. @param {string} first @param {string} last */
function weekdays(first, last) {
  let count = 0
  for (let t = Date.parse(`${first}T00:00:00Z`); t <= Date.parse(`${last}T00:00:00Z`); t += DAY) {
    const d = new Date(t).getUTCDay()
    if (d !== 0 && d !== 6) count += 1
  }
  return count
}

/**
 * @typedef {object} SprintWindow
 * @property {string} key  "2026-SP20", or "2026" for the whole year
 * @property {'sprint' | 'year'} kind
 * @property {string} name  "SP20", or "Whole 2026"
 * @property {number} year
 * @property {string} start  first day (WIB)
 * @property {string} end  last working day (WIB)
 * @property {number} from  window start, ms
 * @property {number} until  window end (now, while it's running), ms
 * @property {boolean} current
 * @property {number} weeks  what per-week metrics divide by
 * @property {number} day  working day so far
 * @property {number} days  working days in it
 * @property {{name: string, start: string, end: string} | undefined} [between]  a gap / hack week we're in: the last sprint is shown
 */

/** When the period after PERIODS[k] starts: the window's end. @param {number} k */
const endOf = (k) => (k + 1 < PERIODS.length ? midnight(PERIODS[k + 1].start) : midnight(PERIODS[k].end) + DAY)

/**
 * The window of PERIODS[first..last] at `now`; null when it hasn't started.
 * @param {number} first @param {number} last @param {number} now
 * @param {Pick<SprintWindow, 'key' | 'kind' | 'name'>} id
 * @returns {SprintWindow | null}
 */
function windowOf(first, last, now, id) {
  const p = PERIODS[first]
  const from = midnight(p.start)
  if (from > now) return null
  const end = endOf(last)
  const current = now < end
  const lastDay = PERIODS[last].end
  const days = weekdays(p.start, lastDay)
  const day = current ? Math.max(1, Math.min(days, weekdays(p.start, wibDate(now)))) : days
  return {
    ...id,
    year: Number(p.start.slice(0, 4)),
    start: p.start,
    end: lastDay,
    from,
    until: current ? now : end,
    current,
    weeks: current ? Math.min(days / 5, Math.max(1, day / 5)) : days / 5,
    day,
    days,
  }
}

/** @param {number} k */
const sprintId = (k) => ({ key: `${PERIODS[k].start.slice(0, 4)}-${PERIODS[k].name}`, kind: /** @type {const} */ ('sprint'), name: PERIODS[k].name })

/**
 * The sprint to score at `now`: the current one, or the one before a gap or
 * hack week. Null when the calendar doesn't cover today.
 *
 * @param {number} now
 * @returns {SprintWindow | null}
 */
export function sprintAt(now) {
  const today = wibDate(now)
  const i = PERIODS.findIndex((p, k) => p.start <= today && (k + 1 < PERIODS.length ? today < PERIODS[k + 1].start : today <= p.end))
  if (i === -1) return null
  let k = i
  while (k >= 0 && PERIODS[k].kind !== 'sprint') k -= 1
  if (k < 0) return null
  const w = /** @type {SprintWindow} */ (windowOf(k, k, now, sprintId(k)))
  return i !== k ? { ...w, between: { name: PERIODS[i].name, start: PERIODS[i].start, end: PERIODS[i].end } } : w
}

/**
 * A sprint ("2026-SP19") or a whole calendar year ("2026", every period that
 * starts in it, gap and hack weeks included). Null when unknown or not begun.
 *
 * @param {string} key
 * @param {number} now
 * @returns {SprintWindow | null}
 */
export function windowFor(key, now) {
  if (/^\d{4}$/.test(key)) {
    const ks = PERIODS.map((p, k) => (p.start.startsWith(key) ? k : -1)).filter((k) => k >= 0)
    return ks.length ? windowOf(ks[0], ks[ks.length - 1], now, { key, kind: 'year', name: `Whole ${key}` }) : null
  }
  const k = PERIODS.findIndex((p, j) => p.kind === 'sprint' && sprintId(j).key === key)
  return k === -1 ? null : windowOf(k, k, now, sprintId(k))
}

/**
 * What the picker offers, newest first: every sprint begun by now and, per
 * year, the whole year.
 *
 * @param {number} now
 * @returns {{key: string, label: string, year: number, kind: 'sprint' | 'year'}[]}
 */
export function sprintChoices(now) {
  /** @type {{key: string, label: string, year: number, kind: 'sprint' | 'year'}[]} */
  const out = []
  for (let k = PERIODS.length - 1; k >= 0; k--) {
    const p = PERIODS[k]
    if (p.kind !== 'sprint' || midnight(p.start) > now) continue
    const year = Number(p.start.slice(0, 4))
    if (!out.some((c) => c.kind === 'year' && c.year === year)) out.push({ key: String(year), label: `Whole ${year}`, year, kind: 'year' })
    out.push({ key: sprintId(k).key, label: `${p.name} ${year} · ${p.start.slice(5)} – ${p.end.slice(5)}`, year, kind: 'sprint' })
  }
  return out
}

/** The sprints of a year begun by now, oldest first, for the trend line. @param {number} year @param {number} now */
export function sprintsOfYear(year, now) {
  return PERIODS.map((p, k) => ({ p, k })).filter(({ p }) => p.kind === 'sprint' && p.start.startsWith(String(year)) && midnight(p.start) <= now).map(({ k }) => sprintId(k))
}

/**
 * GitHub searches for the window, like sprint-score's gh_client.queries, kept
 * to gdncomm (the token covers only it). A PR reviewed in the window was
 * opened before it ended, which keeps an old sprint's review search short.
 *
 * @param {SprintWindow} w
 */
export function sprintSearches(w) {
  const a = wibIso(w.from)
  const b = wibIso(w.until - 1000)
  return {
    created: `is:pr org:gdncomm author:@me created:${a}..${b}`,
    merged: `is:pr org:gdncomm author:@me merged:${a}..${b}`,
    reviewed: `is:pr org:gdncomm reviewed-by:@me -author:@me updated:>=${a} created:<=${b}`,
    ...(w.current ? { open: `is:pr org:gdncomm is:open author:@me` } : {}),
  }
}

/**
 * A long window (a whole year) as searches GitHub can run side by side: the
 * PRs opened and merged, a month at a time, plus the one review search.
 *
 * @param {SprintWindow} w
 * @returns {[string, string][]}
 */
export function splitSearches(w) {
  const q = sprintSearches(w)
  /** @type {[string, string][]} */
  const out = []
  for (let a = w.from; a < w.until; ) {
    const d = new Date(a + WIB)
    const next = Math.min(w.until, Date.parse(`${new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)}T00:00:00+07:00`))
    const range = `${wibIso(a)}..${wibIso(next - 1000)}`
    out.push(['created', `is:pr org:gdncomm author:@me created:${range}`], ['merged', `is:pr org:gdncomm author:@me merged:${range}`])
    a = next
  }
  out.push(['reviewed', q.reviewed])
  if (q.open) out.push(['open', q.open])
  return out
}

/** 75th percentile with linear interpolation (numpy's default). @param {number[]} values */
export function p75(values) {
  const xs = [...values].sort((a, b) => a - b)
  if (!xs.length) return null
  const pos = 0.75 * (xs.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.min(lo + 1, xs.length - 1)
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)
}

/**
 * A PR as the sprint searches return it.
 * @typedef {object} SprintRawPR
 * @property {number} number
 * @property {string} [title]
 * @property {string} [url]
 * @property {string} [state]
 * @property {string} createdAt
 * @property {string | null} [mergedAt]
 * @property {number} [additions]
 * @property {number} [deletions]
 * @property {string} [baseRefName]
 * @property {{nameWithOwner: string}} repository
 * @property {import('./signals.js').Actor} author
 * @property {{nodes: ({commit: {authoredDate: string, committedDate: string}} | null)[]} | null} [commits]
 * @property {{nodes: ({author: import('./signals.js').Actor, submittedAt?: string | null, state?: string} | null)[]} | null} [reviews]
 * @property {{nodes: ({comments: {nodes: ({author: import('./signals.js').Actor, createdAt: string} | null)[]} | null} | null)[]} | null} [reviewThreads]
 * @property {{nodes: ({author: import('./signals.js').Actor, createdAt: string} | null)[]} | null} [comments]
 */

/**
 * @template T
 * @param {{nodes: (T | null)[]} | null | undefined} list
 * @returns {T[]}
 */
const nodes = (list) => /** @type {T[]} */ ((list?.nodes ?? []).filter(Boolean))
/** @param {string | number} a @param {string | number} b */
const hours = (a, b) => ((typeof b === 'number' ? b : Date.parse(b)) - (typeof a === 'number' ? a : Date.parse(a))) / H
/** @param {string[]} times */
const earliest = (times) => (times.length ? times.reduce((x, y) => (Date.parse(y) < Date.parse(x) ? y : x)) : null)

/** One PR, read the way models.PullRequest reads it. @param {SprintRawPR} pr */
export function readPR(pr) {
  const author = pr.author?.login ?? ''
  /** @param {import('./signals.js').Actor} a */
  const other = (a) => !isSignalsBot(a) && a?.login !== author
  const commits = nodes(pr.commits).map((n) => n.commit).filter(Boolean)
  // A PENDING review has no submittedAt: not visible to the author yet.
  const reviews = nodes(pr.reviews).filter((r) => r.submittedAt)
  const otherReviews = reviews.filter((r) => other(r.author))
  const inline = nodes(pr.reviewThreads).flatMap((t) => nodes(t.comments)).filter((c) => other(c.author))
  const conversation = nodes(pr.comments).filter((c) => other(c.author))
  const approvals = otherReviews.filter((r) => r.state === 'APPROVED').map((r) => /** @type {string} */ (r.submittedAt))
  return {
    ref: `${pr.repository.nameWithOwner}#${pr.number}`,
    repo: pr.repository.nameWithOwner,
    number: pr.number,
    title: pr.title ?? '',
    url: pr.url ?? '',
    author,
    merged: pr.state === 'MERGED' || !!pr.mergedAt,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt ?? null,
    size: (pr.additions ?? 0) + (pr.deletions ?? 0),
    commits,
    firstCommitAt: /** @type {string} */ (earliest([...commits.map((c) => c.authoredDate), pr.createdAt])),
    commitsAfter: commits.filter((c) => Date.parse(c.committedDate) > Date.parse(pr.createdAt)).length,
    firstResponseAt: earliest([...otherReviews.map((r) => /** @type {string} */ (r.submittedAt)), ...inline.map((c) => c.createdAt)]),
    lastApprovalAt: approvals.length ? approvals.reduce((x, y) => (Date.parse(y) > Date.parse(x) ? y : x)) : null,
    reviewed: otherReviews.length > 0,
    comments: otherReviews.length + inline.length + conversation.length,
    reviewsBy: reviews.map((r) => ({ login: r.author?.login ?? '', bot: isSignalsBot(r.author), at: /** @type {string} */ (r.submittedAt) })),
  }
}

/** @typedef {ReturnType<typeof readPR>} SprintPR */
/** @typedef {{value: number | null, samples: number, raw?: number}} MetricValue */

const MIN_HOURS = 0.01 // OrgSignals' Elite floor: a real 20-second PR is Elite, not "no activity"
/** @param {number[]} hs @returns {MetricValue} */
const durationOf = (hs) => {
  const v = p75(hs)
  return { value: v === null ? null : Math.max(v, MIN_HOURS), samples: hs.length }
}
/** Population standard deviation. @param {number[]} xs */
const pstdev = (xs) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length)
}

/**
 * The 13 scored + 3 context values, as metrics.compute does. PRs are already
 * in scope; created / merged are filtered to the window here.
 *
 * @param {{login: string, created: SprintPR[], merged: SprintPR[], reviewed: SprintPR[], open: SprintPR[], window: SprintWindow}} input
 * @returns {Record<string, MetricValue>}
 */
export function computeMetrics({ login, created: c0, merged: m0, reviewed, open, window: w }) {
  const inWindow = (/** @type {string | null} */ t) => !!t && Date.parse(t) >= w.from && Date.parse(t) < w.until
  const created = c0.filter((p) => inWindow(p.createdAt))
  const merged = m0.filter((p) => inWindow(p.mergedAt))
  /** @type {Record<string, MetricValue>} */
  const out = {}

  const cycles = merged.map((p) => hours(p.firstCommitAt, /** @type {string} */ (p.mergedAt)))
  out.cycle_time = durationOf(cycles)
  out.coding_time = durationOf(created.map((p) => hours(p.firstCommitAt, p.createdAt)))
  out.cycle_time_variance = { value: cycles.length >= 2 ? Math.max(pstdev(cycles), MIN_HOURS) : null, samples: cycles.length }

  out.commits_after_pr = { value: p75(created.map((p) => p.commitsAfter)), samples: created.length }
  out.pr_size = { value: p75(created.map((p) => p.size)), samples: created.length }
  const unreviewed = merged.filter((p) => !p.reviewed).length
  out.unreviewed_prs_merged = { value: merged.length ? (100 * unreviewed) / merged.length : null, samples: merged.length, raw: unreviewed }

  out.created_prs = { value: created.length / w.weeks, samples: created.length, raw: created.length }
  const mergedCount = created.filter((p) => p.merged).length
  out.merge_rate = { value: created.length ? (100 * mergedCount) / created.length : null, samples: created.length, raw: mergedCount }
  // Still-open PRs opened before the window: their commits this sprint are coding days too.
  const own = new Map([...open, ...created, ...merged].map((p) => [p.ref, p]))
  const days = new Set([...own.values()].flatMap((p) => p.commits.map((c) => Date.parse(c.authoredDate)).filter((t) => t >= w.from && t < w.until).map(wibDate)))
  out.coding_days = { value: days.size / w.weeks, samples: days.size, raw: days.size }
  const lines = created.reduce((a, p) => a + p.size, 0)
  out.lines_changed = { value: lines / w.weeks, samples: created.length, raw: lines }

  const responses = created.filter((p) => p.firstResponseAt).map((p) => Math.max(0, hours(p.createdAt, /** @type {string} */ (p.firstResponseAt))))
  out.time_to_first_comment = durationOf(responses)
  out.comment_count_per_pr = { value: p75(created.map((p) => p.comments)), samples: created.length }
  const reviewedRefs = new Set(reviewed.filter((p) => p.author !== login && p.reviewsBy.some((r) => r.login === login && !r.bot && Date.parse(r.at) >= w.from && Date.parse(r.at) < w.until)).map((p) => p.ref))
  out.prs_reviewed = { value: reviewedRefs.size / w.weeks, samples: reviewedRefs.size, raw: reviewedRefs.size }

  out.pick_up_time = durationOf(responses)
  out.review_time = durationOf(merged.filter((p) => p.firstResponseAt).map((p) => Math.max(0, hours(/** @type {string} */ (p.firstResponseAt), /** @type {string} */ (p.lastApprovalAt ?? p.mergedAt)))))
  out.merge_time = durationOf(merged.filter((p) => p.lastApprovalAt).map((p) => Math.max(0, hours(/** @type {string} */ (p.lastApprovalAt), /** @type {string} */ (p.mergedAt)))))
  return out
}

const OPS = { gt: (/** @type {number} */ a, /** @type {number} */ b) => a > b, ge: (/** @type {number} */ a, /** @type {number} */ b) => a >= b, lt: (/** @type {number} */ a, /** @type {number} */ b) => a < b, le: (/** @type {number} */ a, /** @type {number} */ b) => a <= b, eq: (/** @type {number} */ a, /** @type {number} */ b) => a === b }
const REAL = /** @type {const} */ (['ELITE', 'HIGH', 'MEDIUM', 'NEEDS_FOCUS'])

/**
 * A value's tier, as scoring.classify: the first tier whose conditions all
 * hold; a value in a threshold gap (variance 1–2 h) falls to the worse side.
 *
 * @param {Rule} rule
 * @param {number | null} value
 * @returns {Tier}
 */
export function classify(rule, value) {
  if (value === null) return 'NO_ACTIVITY'
  for (const t of rule.tiers) if (t.conds.every(([op, b]) => OPS[op](value, b))) return t.tier
  const real = rule.tiers.filter((t) => REAL.includes(/** @type {any} */ (t.tier)))
  for (const t of real) {
    const bound = t.conds.find(([op]) => (rule.better === 'lower' ? op === 'gt' || op === 'ge' : op === 'lt' || op === 'le'))
    if (bound && (rule.better === 'lower' ? bound[1] >= value : bound[1] <= value)) return t.tier
  }
  return 'NEEDS_FOCUS'
}

const SYMBOL = { gt: '>', ge: '≥', lt: '<', le: '≤', eq: '=' }

/** What a value must reach to enter `tier` from below it. @param {Rule} rule @param {Tier} tier */
function entry(rule, tier) {
  const t = rule.tiers.find((x) => x.tier === tier)
  const bound = t?.conds.find(([op]) => (rule.better === 'lower' ? op === 'le' || op === 'lt' : op === 'ge' || op === 'gt'))
  return bound ? `${SYMBOL[bound[0]]} ${bound[1]}${rule.unit === 'h' || rule.unit === '%' || rule.unit === '/wk' ? '' : ' '}${rule.unit}`.trim() : ''
}

/**
 * @typedef {object} ScoredMetric
 * @property {string} key
 * @property {string} label
 * @property {string} means
 * @property {string} unit
 * @property {number | null} value
 * @property {number} samples
 * @property {number} [raw]
 * @property {Tier} tier
 * @property {number} points
 * @property {number} max
 * @property {string} next  e.g. "High at ≤ 400 lines (+5 pts)", or ''
 */

/**
 * @typedef {object} Scorecard
 * @property {Record<string, ScoredMetric>} metrics
 * @property {{key: string, label: string, score: number, tier: Tier}[]} categories
 * @property {number} overall  plain mean of the categories (OrgSignals' weights aren't public)
 * @property {Tier} overallTier
 */

/** @param {number} score @returns {Tier} */
const categoryTier = (score) => CATEGORY_TIERS.find(([, gt]) => score > gt)?.[0] ?? 'NO_ACTIVITY'

/** @param {string} key @param {MetricValue | undefined} mv @returns {ScoredMetric} */
function scoreOne(key, mv = { value: null, samples: 0 }) {
  const rule = RULES[key]
  const tier = classify(rule, mv.value)
  const points = tier === 'NO_ACTIVITY' ? 0 : rule.tiers.find((t) => t.tier === tier)?.points ?? 0
  const max = Math.max(...rule.tiers.map((t) => t.points))
  const i = REAL.indexOf(/** @type {any} */ (tier))
  const up = i > 0 ? REAL[i - 1] : null
  const upPoints = up ? rule.tiers.find((t) => t.tier === up)?.points ?? 0 : 0
  const next = up ? `${up === 'ELITE' ? 'Elite' : up === 'HIGH' ? 'High' : 'Medium'} at ${entry(rule, up)}${max ? ` (+${upPoints - points} pts)` : ''}` : ''
  return { key, label: rule.label, means: rule.means, unit: rule.unit, value: mv.value, samples: mv.samples, ...(mv.raw !== undefined ? { raw: mv.raw } : {}), tier, points, max, next }
}

/** To one decimal like Python's round(): a tie goes to the even digit (66.25 → 66.2). @param {number} x */
const roundHalfEven = (x) => {
  const t = x * 10
  const r = Math.round(t)
  return (Math.abs(t % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r) / 10
}

/** @param {Record<string, MetricValue>} values @returns {Scorecard} */
export function scoreAll(values) {
  /** @type {Record<string, ScoredMetric>} */
  const metrics = {}
  const categories = CATEGORIES.map((c) => {
    const score = c.metrics.reduce((sum, key) => sum + (metrics[key] = scoreOne(key, values[key])).points, 0)
    return { key: c.key, label: c.label, score, tier: categoryTier(score) }
  })
  for (const key of CONTEXT) metrics[key] = scoreOne(key, values[key])
  const overall = roundHalfEven(categories.reduce((a, c) => a + c.score, 0) / categories.length)
  return { metrics, categories, overall, overallTier: categoryTier(overall) }
}

/** A metric value for people: hours short, per-week to one decimal. @param {ScoredMetric} m */
export function formatValue(m) {
  if (m.value === null) return '—'
  if (m.unit === 'h') return formatHours(m.value)
  if (m.unit === '%') return `${Math.round(m.value)}%`
  if (m.unit === '/wk') return `${Number(m.value.toFixed(1)).toLocaleString('en-US')}/wk`
  const n = Number(m.value.toFixed(1)).toLocaleString('en-US')
  return m.unit ? `${n} ${m.unit}` : n
}

/**
 * A stored scorecard (a sprint or a whole year): everything the tab needs.
 * @typedef {object} SprintCard
 * @property {Omit<SprintWindow, 'from' | 'until'> & {from: string, until: string}} sprint
 * @property {string} computedAt
 * @property {Scorecard | null} card  null when nothing counted yet
 * @property {{ref: string, url: string, title: string, createdAt?: string, size: number, merged: boolean, codingH: number, commitsAfter: number, firstResponseH: number | null, comments: number, cycleH: number | null, reviewed: boolean}[]} prs  your PRs opened this sprint
 * @property {number} reviewedCount
 * @property {string} [error]  the last refresh couldn't update it; this is the one before
 */

/**
 * Score a sprint from the four searches' PRs.
 *
 * @param {{login: string, window: SprintWindow, created: SprintRawPR[], merged: SprintRawPR[], reviewed: SprintRawPR[], open?: SprintRawPR[], now?: number}} input
 * @returns {SprintCard}
 */
export function buildSprint({ login, window: w, created, merged, reviewed, open = [], now = Date.now() }) {
  const keep = (/** @type {SprintRawPR[]} */ list) => list.filter((p) => p?.repository && inScope(p.repository.nameWithOwner, p.baseRefName)).map(readPR)
  const c = keep(created)
  const m = keep(merged)
  const values = computeMetrics({ login, created: c, merged: m, reviewed: keep(reviewed), open: w.current ? keep(open) : [], window: w })
  const counted = Object.values(values).some((v) => v.samples > 0)
  const opened = c.filter((p) => Date.parse(p.createdAt) >= w.from && Date.parse(p.createdAt) < w.until)
  return {
    sprint: { ...w, from: new Date(w.from).toISOString(), until: new Date(w.until).toISOString() },
    computedAt: new Date(now).toISOString(),
    card: counted ? scoreAll(values) : null,
    prs: opened
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((p) => ({
        ref: p.ref,
        url: p.url,
        title: p.title,
        createdAt: p.createdAt,
        size: p.size,
        merged: p.merged,
        codingH: Math.max(MIN_HOURS, hours(p.firstCommitAt, p.createdAt)),
        commitsAfter: p.commitsAfter,
        firstResponseH: p.firstResponseAt ? Math.max(0, hours(p.createdAt, p.firstResponseAt)) : null,
        comments: p.comments,
        cycleH: p.mergedAt ? hours(p.firstCommitAt, p.mergedAt) : null,
        reviewed: p.reviewed,
      })),
    reviewedCount: values.prs_reviewed.samples,
  }
}

/**
 * A whole year from one set of searches, plus each finished sprint in it: a
 * sprint's PRs are a subset of the year's, so they score the same as if
 * searched on their own. The running sprint is left to the refresh.
 *
 * @param {{login: string, window: SprintWindow, created: SprintRawPR[], merged: SprintRawPR[], reviewed: SprintRawPR[], open?: SprintRawPR[], now?: number}} input
 * @returns {{year: SprintCard, sprints: Record<string, SprintCard>}}
 */
export function buildYear(input) {
  const now = input.now ?? Date.now()
  /** @type {Record<string, SprintCard>} */
  const sprints = {}
  for (const { key } of sprintsOfYear(input.window.year, now)) {
    const w = windowFor(key, now)
    if (w && !w.current) sprints[key] = buildSprint({ ...input, window: w, open: [], now })
  }
  return { year: buildSprint({ ...input, now }), sprints }
}
