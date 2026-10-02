/**
 * OrgSignals (Signals AI) metrics for one PR, as the growth-signals
 * `sprint-score` skill computes them from GitHub. OrgSignals scores a sprint
 * by the P75 of these per-PR values, so each card shows where this PR lands.
 *
 * Scope, bot rule and tiers are copied from that skill's
 * `references/scoring.json` (team settings shared by the lead, 2026-09-28).
 * When the lead changes the repo list or OrgSignals its thresholds, update
 * SCOPE / METRICS here.
 */

/** @typedef {'ELITE' | 'HIGH' | 'MEDIUM' | 'NEEDS_FOCUS' | 'NO_ACTIVITY'} Tier */

export const SCOPE = {
  org: 'gdncomm',
  /** The team's tracked repos (OrgSignals → GitHub → Repositories). */
  repos: [
    'cucumber-seo-backend', 'cucumber-seo-center-ui', 'cucumber-product-feed-facebook-api',
    'cucumber-api-aggregate-platform-traffic', 'cucumber-product-feed-google-api', 'cucumber-product-feed-backend',
    'cucumber-product-feed-api', 'cucumber-product-feed-center-ui', 'seo-backend-data-migration', 'site-crawler-service',
    'inspirasi-data-generator', 'aggregate-platform-traffic', 'product-feed-backend-data-migration',
    'product-feed-python-script', 'aggregate-platform-reindex', 'product-feed-facebook-data-migration',
    'customer-feed-job', 'share-hub', 'product-feed-facebook', 'traffic-gateway', 'product-feed-google-data-migration',
    'share-hub-data-migration', 'traffic-tracker-aggregator-data-migration', 'affiliate-wallet-withdrawal-job',
    'affiliate-wallet-data-migration', 'affiliate-platform-data-migration', 'affiliate-wallet', 'affiliate-platform',
    'affiliate-archival-job', 'module-share-affiliate', 'business-affiliate-ui', 'pyeongyang-ui-affiliate', 'uap-ui',
    'seller-affiliate-ui', 'crawler-service', 'common-crawler', 'seo-backend', 'seo-ui', 'module-domain-product-item',
    'product-feed-backend', 'product-feed-google', 'module-domain-product-item-data-migration', 'pyeongyang-ui-ads',
    'tracker-center-ui', 'product-feed-center-ui', 'traffic-tracker-aggregator', 'affiliate-wallet-topup-job',
    'k6-module-traffic', 'affiliate-dashboard', 'uap-backend-gateway', 'product-feed', 'product-feed-data-migration',
    'product-feed-job', 'module-share-uap', 'product-feed-center', 'seo-query-intent-classification',
  ],
  /** "Branches included in score". */
  baseBranches: ['release/*', 'master'],
}

const TRACKED = new Set(SCOPE.repos.map((r) => `${SCOPE.org}/${r}`))
/** Deployment repos: prod-… / nonprod-… (Rundeck, infra, deploy) and *-deployment-*. Never scored. */
const DEPLOYMENT = /^(?:prod|nonprod)-|-deployment-/i

/**
 * Whether OrgSignals scores a PR: a tracked team repo, merging into a tracked
 * branch. Deployment repos (nonprod / prod) are never scored.
 * @param {string} repo  owner/name
 * @param {string | undefined} base  the PR's base branch
 */
export function inScope(repo, base) {
  const name = repo.toLowerCase()
  if (!TRACKED.has(name) || DEPLOYMENT.test(name.split('/').pop() ?? '')) return false
  return !!base && SCOPE.baseBranches.some((pattern) => (pattern.endsWith('/*') ? base.startsWith(pattern.slice(0, -1)) : base === pattern))
}

/**
 * Upper bounds per tier (all these metrics are "lower is better"); above the
 * last one is NEEDS FOCUS. `zero`: what a value of exactly 0 scores.
 * @type {Record<string, {label: string, unit: string, bounds: [number, number, number], zero?: Tier, means: string}>}
 */
export const METRICS = {
  pr_size: { label: 'PR size', unit: 'lines', bounds: [250, 400, 600], zero: 'NO_ACTIVITY', means: 'lines added + deleted' },
  coding_time: { label: 'Coding time', unit: 'h', bounds: [2, 9, 28], means: 'first commit → PR opened' },
  commits_after_pr: { label: 'Commits after PR raised', unit: '', bounds: [1, 4, 5], means: 'commits pushed after the PR was opened' },
  time_to_first_comment: { label: 'Time to first comment', unit: 'h', bounds: [6, 18, 30], means: 'PR opened → first review or inline comment by someone else (conversation comments don\'t count)' },
  comment_count_per_pr: { label: 'Comment count per PR', unit: '', bounds: [5, 10, 15], zero: 'NO_ACTIVITY', means: 'reviews + inline comments + conversation comments by other people; 0 scores no activity' },
  cycle_time: { label: 'Cycle time', unit: 'h', bounds: [27, 97, 174], means: 'first commit → merged' },
}

const TIER_NAMES = /** @type {const} */ (['ELITE', 'HIGH', 'MEDIUM'])

/** @param {string} key @param {number} value @returns {Tier} */
export function tierOf(key, value) {
  const m = METRICS[key]
  if (value === 0 && m.zero) return m.zero
  const i = m.bounds.findIndex((b) => value <= b)
  return i === -1 ? 'NEEDS_FOCUS' : TIER_NAMES[i]
}

/** @typedef {{login: string, __typename?: string} | null | undefined} Actor */

/** OrgSignals' rule, not the page's bot list: bots, Jenkins and deleted accounts never count. @param {Actor} actor */
export function isSignalsBot(actor) {
  if (!actor?.login) return true
  if (actor.__typename === 'Bot') return true
  const login = actor.login.toLowerCase()
  return login.endsWith('[bot]') || login.includes('jenkins')
}

/**
 * What a PR's metrics are computed from, kept in the snapshot. Times stay as
 * timestamps so "no review yet" and cycle time keep counting on the page.
 * @typedef {object} SignalsFacts
 * @property {string} createdAt
 * @property {string} firstCommitAt  earliest authored commit, never after createdAt
 * @property {number | null} lines  additions + deletions
 * @property {number} commitsAfter
 * @property {boolean} [commitsAfterAtLeast]  more commits than fetched: a lower bound
 * @property {string | null} firstResponseAt
 * @property {number} comments
 * @property {boolean} reviewed  someone else submitted a review
 */

/**
 * @typedef {object} SignalsRaw
 * @property {string} createdAt
 * @property {{login: string, __typename?: string} | null} author
 * @property {{nameWithOwner: string}} repository
 * @property {string} [baseRefName]
 * @property {number} [additions]
 * @property {number} [deletions]
 * @property {{totalCount?: number, nodes: ({commit: {committedDate: string, authoredDate?: string}} | null)[]} | null} [commits]
 * @property {{nodes: ({commit: {authoredDate?: string}} | null)[]} | null} [firstCommit]
 * @property {{nodes: ({author: Actor, createdAt: string, submittedAt?: string | null} | null)[]} | null} [reviews]
 * @property {{nodes: ({comments: {nodes: ({author: Actor, createdAt: string} | null)[]} | null} | null)[]} | null} [reviewThreads]
 * @property {{nodes: ({author: Actor, createdAt: string} | null)[]} | null} [comments]
 */

/**
 * @template T
 * @param {{nodes: (T | null)[]} | null | undefined} list
 * @returns {T[]}
 */
const nodes = (list) => /** @type {T[]} */ ((list?.nodes ?? []).filter(Boolean))

/**
 * The facts for one PR, or undefined when OrgSignals doesn't score it.
 * @param {SignalsRaw} pr
 * @returns {SignalsFacts | undefined}
 */
export function prSignals(pr) {
  if (!inScope(pr.repository?.nameWithOwner ?? '', pr.baseRefName)) return undefined
  const author = pr.author?.login ?? ''
  /** @param {Actor} a */
  const other = (a) => !isSignalsBot(a) && a?.login !== author

  const commits = nodes(pr.commits).map((n) => n.commit).filter(Boolean)
  const authored = [...nodes(pr.firstCommit).map((n) => n.commit?.authoredDate), ...commits.map((c) => c.authoredDate)].filter((d) => typeof d === 'string')
  const firstCommitAt = [...authored, pr.createdAt].reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a))
  const after = commits.filter((c) => Date.parse(c.committedDate) > Date.parse(pr.createdAt)).length
  const total = pr.commits?.totalCount ?? commits.length

  const reviews = nodes(pr.reviews).filter((r) => other(r.author))
  const inline = nodes(pr.reviewThreads).flatMap((t) => nodes(t.comments)).filter((c) => other(c.author))
  const conversation = nodes(pr.comments).filter((c) => other(c.author))
  const responses = [...reviews.map((r) => r.submittedAt ?? r.createdAt), ...inline.map((c) => c.createdAt)].filter(Boolean)
  const firstResponseAt = responses.length ? responses.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)) : null

  return {
    createdAt: pr.createdAt,
    firstCommitAt,
    lines: typeof pr.additions === 'number' && typeof pr.deletions === 'number' ? pr.additions + pr.deletions : null,
    commitsAfter: after,
    ...(total > commits.length && after === commits.length ? { commitsAfterAtLeast: true } : {}),
    firstResponseAt,
    comments: reviews.length + inline.length + conversation.length,
    reviewed: reviews.length > 0,
  }
}

/** Short duration: minutes, hours, then days from 100 h (OrgSignals' own unit, hours, stays in the tooltip). @param {number} h */
export function formatHours(h) {
  const minutes = Math.round(h * 60)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  if (h < 100) return `${Number(h.toFixed(1))}h`
  return `${Math.round(h / 24)}d`
}

/** OrgSignals counts in hours: say how many when the short form is days. @param {number} h */
const hoursNote = (h) => (h < 100 ? '' : `${Math.round(h)}h`)
/** @param {...string} parts */
const notes = (...parts) => parts.filter(Boolean).join(' · ')

/** @param {string} a @param {string | number} b */
const hoursBetween = (a, b) => Math.max(0, ((typeof b === 'number' ? b : Date.parse(b)) - Date.parse(a)) / 3_600_000)

/**
 * @typedef {object} Reading
 * @property {string} key
 * @property {string} label  the metric's name
 * @property {string} text  short form ("Size 898")
 * @property {string} value  this PR's value, spelled out ("898 lines")
 * @property {Tier} tier
 * @property {string} note  what the value assumes ("if merged now"), or ''
 * @property {string} means  what the metric measures
 * @property {string} scale  the tier bounds
 * @property {string} title  all of it in one sentence
 */

export const TIER_LABEL = { ELITE: 'Elite', HIGH: 'High', MEDIUM: 'Medium', NEEDS_FOCUS: 'Needs focus', NO_ACTIVITY: 'No activity' }

/** @param {string} key @param {number} value @param {string} shown @param {string} [note] */
function explain(key, value, shown, note = '') {
  const m = METRICS[key]
  const tier = tierOf(key, value)
  const unit = m.unit === 'h' ? 'h' : m.unit ? ` ${m.unit}` : ''
  const [e, h, md] = m.bounds
  const scale = `Elite ≤ ${e}${unit}, High ≤ ${h}${unit}, Medium ≤ ${md}${unit}, above: Needs focus${m.zero ? '; 0 is No activity' : ''}`
  const means = `${m.means[0].toUpperCase()}${m.means.slice(1)}`
  return { label: m.label, value: shown, tier, note, means, scale, title: `${m.label}: ${shown}${note ? ` (${note})` : ''} — ${TIER_LABEL[tier]}. ${means}. ${scale}.` }
}

const RANK = { NEEDS_FOCUS: 0, NO_ACTIVITY: 1, MEDIUM: 2, HIGH: 3, ELITE: 4 }

/** The weakest tier among a PR's readings, for its button. @param {Reading[]} list @returns {Tier} */
export function worstTier(list) {
  return list.reduce((/** @type {Tier} */ worst, r) => (RANK[r.tier] < RANK[worst] ? r.tier : worst), 'ELITE')
}

/**
 * What to show for a PR right now: one reading per metric that has a value.
 * @param {SignalsFacts} f
 * @param {number} [now]
 * @returns {Reading[]}
 */
export function readings(f, now = Date.now()) {
  /** @type {Reading[]} */
  const out = []
  if (f.lines !== null) {
    const shown = `${f.lines.toLocaleString('en-US')} lines`
    out.push({ key: 'pr_size', text: `Size ${f.lines.toLocaleString('en-US')}`, ...explain('pr_size', f.lines, shown) })
  }
  const coding = Math.max(0.01, hoursBetween(f.firstCommitAt, f.createdAt))
  out.push({ key: 'coding_time', text: `Coding ${formatHours(coding)}`, ...explain('coding_time', coding, formatHours(coding), hoursNote(coding)) })

  const plus = f.commitsAfterAtLeast ? '+' : ''
  out.push({
    key: 'commits_after_pr',
    text: `${f.commitsAfter}${plus} after open`,
    ...explain('commits_after_pr', f.commitsAfter, `${f.commitsAfter}${plus} commit${f.commitsAfter === 1 ? '' : 's'}`),
  })

  if (f.firstResponseAt) {
    const h = Math.max(0.01, hoursBetween(f.createdAt, f.firstResponseAt))
    out.push({ key: 'time_to_first_comment', text: `1st review ${formatHours(h)}`, ...explain('time_to_first_comment', h, formatHours(h), hoursNote(h)) })
  } else {
    // Not a sample yet; the clock is running, and this is where it lands if someone looks now.
    const h = Math.max(0.01, hoursBetween(f.createdAt, now))
    out.push({ key: 'time_to_first_comment', text: `No review · ${formatHours(h)}`, ...explain('time_to_first_comment', h, formatHours(h), notes('no review yet', hoursNote(h), 'if someone reviews now')) })
  }

  out.push({ key: 'comment_count_per_pr', text: `${f.comments} comment${f.comments === 1 ? '' : 's'}`, ...explain('comment_count_per_pr', f.comments, String(f.comments)) })

  const cycle = Math.max(0.01, hoursBetween(f.firstCommitAt, now))
  out.push({ key: 'cycle_time', text: `Cycle ${formatHours(cycle)}`, ...explain('cycle_time', cycle, formatHours(cycle), notes('so far', hoursNote(cycle), 'if merged now')) })

  if (!f.reviewed) {
    out.push({
      key: 'unreviewed_prs_merged',
      label: 'Unreviewed PRs merged',
      text: 'Unreviewed',
      value: 'No review',
      tier: 'NEEDS_FOCUS',
      note: 'nobody else has reviewed yet · if merged now',
      means: 'Share of your merged PRs that nobody else reviewed',
      scale: 'Elite ≤ 5 % of merged PRs, High ≤ 15 %, Medium ≤ 25 %, above: Needs focus',
      title: 'Unreviewed PRs merged: nobody else has reviewed this PR yet. Merged like this it counts as unreviewed (Elite ≤ 5 % of merged PRs).',
    })
  }
  return out
}
