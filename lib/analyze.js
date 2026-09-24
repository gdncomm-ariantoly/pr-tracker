/**
 * Pure analysis of a GitHub pull request as returned by the GraphQL query in
 * github.js. No `chrome.*`, no `fetch` — everything here runs under node --test.
 *
 * For every comment written by a human who is not the PR author, decide whether
 * it has been addressed, using the evidence GitHub gives us:
 *
 *   resolved     the review thread was marked resolved
 *   outdated     the lines the thread points at changed after the comment
 *   fixed-reply  the author replied claiming a fix ("done", "fixed in abc123", …)
 *   replied      the author replied without claiming a fix (explained / pushed back)
 *   commit-after a non-merge commit landed after the comment, nothing else
 *   open         no evidence at all
 *
 * and two statuses for comments that never asked for a change:
 *
 *   no-action    an approval or a clean review ("Verdict: Approve", "No blocking
 *                issues", "flagging as solid for a human reviewer") — it needs a
 *                human approval, not a code change
 *   optional     explicitly non-blocking ("Nit (non-blocking)", "Approve with
 *                suggestions")
 */

/** @typedef {{login: string, __typename?: string} | null} Actor */
/** @typedef {{id: string, author: Actor, body: string, bodyHTML?: string, createdAt: string, url: string}} RawComment */
/** @typedef {RawComment & {state: string}} RawReview */
/** @typedef {{id: string, isResolved: boolean, isOutdated: boolean, path: string, line: number | null, resolvedBy: {login: string} | null, comments: {nodes: RawComment[]}}} RawThread */
/** @typedef {{commit: {oid: string, committedDate: string, messageHeadline: string}}} RawCommit */
/**
 * @typedef {object} RawPR
 * @property {string} id
 * @property {number} number
 * @property {string} title
 * @property {string} url
 * @property {boolean} isDraft
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | null} reviewDecision
 * @property {Actor} author
 * @property {{nameWithOwner: string}} repository
 * @property {{nodes: RawCommit[]}} commits
 * @property {{nodes: RawComment[]}} comments
 * @property {{nodes: RawReview[]}} reviews
 * @property {{nodes: RawThread[]}} reviewThreads
 * @property {{nodes: ({commit: {statusCheckRollup: {contexts: {nodes: (RawCheck | null)[]}} | null} | null} | null)[]} | null} [head]
 */

/**
 * @typedef {{__typename: 'CheckRun', name: string, status: string, conclusion: string | null, detailsUrl: string | null, startedAt?: string | null, completedAt?: string | null}
 *   | {__typename: 'StatusContext', context: string, state: string, targetUrl: string | null, createdAt?: string}} RawCheck
 */

/** @typedef {'failure' | 'running' | 'pending' | 'cancelled' | 'success' | 'skipped'} BuildState */
/** @typedef {{state: BuildState, url: string | null, name: string, number: number | null, at: string | null}} Build */

/** @typedef {'resolved' | 'outdated' | 'fixed-reply' | 'replied' | 'commit-after' | 'open' | 'no-action' | 'optional'} Status */

/**
 * @typedef {object} Finding
 * @property {string} id
 * @property {'inline' | 'review' | 'comment'} kind
 * @property {string} author
 * @property {string} body
 * @property {string} [bodyHTML]  GitHub's own rendering (sanitize before use)
 * @property {string} createdAt
 * @property {string} url
 * @property {{author: string, bodyHTML?: string, body: string, createdAt: string, url: string}[]} [conversation]  the rest of the thread
 * @property {string} [path]
 * @property {number | null} [line]
 * @property {string} [reviewState]
 * @property {number} replies  human replies after the first comment (threads only)
 * @property {string} lastReviewerAt  latest comment by a reviewer in this thread (= createdAt for top-level)
 * @property {string} [lastReviewer]  who wrote it
 * @property {string} [lastReviewerBody]  what they wrote (threads: the latest reviewer comment)
 * @property {string} [replyBody]  the PR author's reply used as evidence, if any
 * @property {Status} status
 * @property {boolean} fixed
 * @property {boolean} [noAction]  never asked for a change (no-action / optional)
 * @property {boolean} [overridden]  the user marked it no action needed
 * @property {string} evidence  one human-readable sentence explaining the status
 */

/**
 * @typedef {object} PRSummary
 * @property {string} id
 * @property {string} repo
 * @property {number} number
 * @property {string} title
 * @property {string} url
 * @property {string} author
 * @property {boolean} isDraft
 * @property {string} updatedAt
 * @property {string | null} reviewDecision
 * @property {boolean} hasHumanComments
 * @property {Finding[]} findings
 * @property {{total: number, fixed: number, pending: number, noAction: number}} counts
 * @property {Build | null} [build]  Jenkins, as reported to GitHub on the head commit (or read from Jenkins)
 */

const FIXED_STATUSES = new Set(['resolved', 'outdated', 'fixed-reply'])
export const NO_ACTION_STATUSES = new Set(['no-action', 'optional'])

// An explicit verdict wins over everything else in the text.
const VERDICT_CHANGES = /verdict\W{0,12}(?:request(?:ed)?[ -]changes|changes[ -]requested|needs? (?:work|changes))/i
const VERDICT_SUGGEST = /\b(?:approve|lgtm)\W{0,4}(?:with|but)\W{0,4}(?:suggestions?|nits?|minor|comments?|optional)/i
const VERDICT_APPROVE = /verdict\W{0,12}approve\b/i
// Anything asking for a change keeps the comment actionable.
const BLOCKER =
  /before merg|once [^.\n]{0,100}\b(?:addressed|fixed|resolved|deferred|changed)|\bmust\b[^.\n]{0,20}\b(?:fix|chang|address|add|remov|handl)|please (?:fix|change|address|update|add|remove|handle|rename)|needs? to be (?:fixed|changed|addressed)|(?<!non-)\bblocking\b(?!\s+(?:issues?|findings?|concerns?|problems?))|\bcritical\b|changes requested|request changes/i
const NON_BLOCKING = /^\W{0,4}(?:nit|nitpick|optional|minor)\b|\bnon-blocking\b|\(optional\)/i
const CLEAN =
  /\bno (?:blocking |correctness |critical |major )?(?:issues|findings|concerns|problems)(?: found)?\b|\blgtm\b|looks good to (?:me|merge)|nothing (?:blocking|to fix)|solid for a human reviewer|good to (?:go|merge)|ship it/i

/**
 * Did this comment ask for a change at all? `null` means it did (or we can't
 * tell) and the normal fixed/unfixed evidence applies.
 *
 * @param {string} body
 * @param {string} [reviewState]
 * @returns {{status: 'no-action' | 'optional', why: string} | null}
 */
export function classifyIntent(body, reviewState) {
  if (reviewState === 'APPROVED') return { status: 'no-action', why: 'Approved.' }
  if (reviewState === 'CHANGES_REQUESTED') return null
  const text = stripQuotes(body ?? '')
  const quote = (/** @type {RegExp} */ re) => {
    const m = re.exec(text)
    if (!m) return ''
    const start = Math.max(text.lastIndexOf('. ', m.index) + 1, text.lastIndexOf('\n', m.index) + 1, 0)
    // End at the sentence (or line) the match sits in, not mid-way into the next.
    const rest = text.slice(m.index + m[0].length)
    const stop = rest.search(/[.!?](?:\s|$)|\n/)
    const end = m.index + m[0].length + (stop === -1 ? Math.min(rest.length, 40) : stop + 1)
    return `“${clip(text.slice(start, end).replace(/[*_`]/g, ''), 80)}”`
  }
  if (VERDICT_CHANGES.test(text)) return null
  if (VERDICT_SUGGEST.test(text)) return { status: 'optional', why: `Approved with suggestions: ${quote(VERDICT_SUGGEST)}` }
  if (VERDICT_APPROVE.test(text)) return { status: 'no-action', why: `Reviewer approves: ${quote(VERDICT_APPROVE)}` }
  if (BLOCKER.test(text)) return null
  if (NON_BLOCKING.test(text)) return { status: 'optional', why: `Marked non-blocking: ${quote(NON_BLOCKING)}` }
  if (CLEAN.test(text)) return { status: 'no-action', why: `Nothing to fix: ${quote(CLEAN)}` }
  return null
}

const DEFAULT_BOT_PATTERNS = [/\[bot\]$/i, /-bot$/i, /^bot-/i]

/**
 * @param {Actor} actor
 * @param {string[]} [extraBots] lowercase logins treated as bots
 */
export function isBot(actor, extraBots = []) {
  if (!actor) return false
  if (actor.__typename === 'Bot' || actor.__typename === 'Mannequin') return true
  const login = actor.login.toLowerCase()
  if (extraBots.includes(login)) return true
  return DEFAULT_BOT_PATTERNS.some((re) => re.test(login))
}

const FIX_WORDS =
  /\b(done|fixed|fix(?:ed)? (?:in|on|at|by)|addressed|updated|resolved|changed|applied|removed|renamed|refactored|reverted|moved|added|adjusted|handled|sudah|udah|sdh|diperbaiki|diubah|diganti|dihapus)\b/i
const NEGATION =
  /\b(won'?t|will not|not (?:going|gonna|needed|necessary|fixed|done)|no need|intended|by design|keep (?:it|as)|follow[- ]?up|next pr|later|tidak|nggak|gak|enggak|ga perlu|belum)\b/i
const SHA = /\b[0-9a-f]{7,40}\b/

/**
 * Does a reply claim the comment was fixed?
 * @param {string} body
 */
export function claimsFix(body) {
  const text = stripQuotes(body)
  if (SHA.test(text) && FIX_WORDS.test(text)) return true
  // A long reply's opening line is its verdict ("addressed both points:"); the
  // detail below it is full of incidental "won't"s that are not about the fix.
  const opening = text.split('\n').find((line) => line.trim()) ?? ''
  if (NEGATION.test(opening)) return false
  if (FIX_WORDS.test(opening)) return true
  if (NEGATION.test(text)) return false
  return FIX_WORDS.test(text)
}

/** Drop quoted lines (`> …`) so a reply quoting "please fix" is not read as a fix. */
function stripQuotes(/** @type {string} */ body) {
  return body
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
}

/**
 * GraphQL connections can come back null, and their `nodes` can hold nulls —
 * GitHub does both when it hides something from the token (SSO, a deleted
 * account, a commit it cannot resolve). Never index a node without this.
 *
 * @template T
 * @param {{nodes?: (T | null)[] | null} | null | undefined} connection
 * @returns {T[]}
 */
function nodes(connection) {
  return /** @type {T[]} */ ((connection?.nodes ?? []).filter((n) => n != null))
}

// Worst first: a PR with one failed and one passing Jenkins job is failing.
const BUILD_RANK = /** @type {BuildState[]} */ (['failure', 'running', 'pending', 'cancelled', 'success', 'skipped'])

/** @param {RawCheck} c @returns {BuildState} */
function buildState(c) {
  if (c.__typename === 'CheckRun') {
    if (c.status === 'IN_PROGRESS') return 'running'
    if (c.status !== 'COMPLETED') return 'pending'
    switch (c.conclusion) {
      case 'SUCCESS': return 'success'
      case 'CANCELLED': return 'cancelled'
      case 'NEUTRAL':
      case 'SKIPPED': return 'skipped'
      default: return 'failure' // FAILURE, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE, STALE
    }
  }
  if (c.state === 'SUCCESS') return 'success'
  if (c.state === 'PENDING' || c.state === 'EXPECTED') return 'running'
  return 'failure' // FAILURE, ERROR
}

/**
 * The Jenkins build for the PR's head commit. Jenkins reports to GitHub (as a
 * check run named "Jenkins CI", or a commit status), so no Jenkins login is
 * needed: anything whose name or link mentions Jenkins counts.
 *
 * @param {RawPR} pr
 * @returns {Build | null}
 */
export function jenkinsBuild(pr) {
  const checks = nodes(nodes(pr.head)[0]?.commit?.statusCheckRollup?.contexts)
  const builds = checks
    .map((c) => {
      const name = c.__typename === 'CheckRun' ? c.name : c.context
      const url = (c.__typename === 'CheckRun' ? c.detailsUrl : c.targetUrl) ?? null
      if (!/jenkins/i.test(`${name} ${url ?? ''}`)) return null
      const number = url ? Number(/\/(\d+)\/?(?:display\/redirect)?$/.exec(url)?.[1] ?? NaN) : NaN
      const at = c.__typename === 'CheckRun' ? (c.completedAt ?? c.startedAt ?? null) : (c.createdAt ?? null)
      return /** @type {Build} */ ({ state: buildState(c), url, name, number: Number.isFinite(number) ? number : null, at })
    })
    .filter((b) => b !== null)
  if (!builds.length) return null
  return builds.sort((a, b) => BUILD_RANK.indexOf(a.state) - BUILD_RANK.indexOf(b.state))[0]
}

/** @param {string} headline */
function isMergeCommit(headline) {
  return /^Merge (branch|remote-tracking branch|pull request|.* into )/i.test(headline)
}

/** @param {string} text @param {number} [n] */
function clip(text, n = 80) {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/**
 * @param {RawPR} pr
 * @param {{extraBots?: string[]}} [options]
 * @returns {PRSummary}
 */
export function analyzePR(pr, options = {}) {
  const extraBots = (options.extraBots ?? []).map((s) => s.toLowerCase())
  const prAuthor = pr.author?.login ?? ''
  const isHuman = (/** @type {Actor} */ a) => !!a && !isBot(a, extraBots)
  const isReviewer = (/** @type {Actor} */ a) => isHuman(a) && a?.login !== prAuthor
  const isPrAuthor = (/** @type {Actor} */ a) => !!a && a.login === prAuthor

  const commits = nodes(pr.commits)
    .map((n) => n.commit)
    .filter((c) => c && c.committedDate && !isMergeCommit(c.messageHeadline ?? ''))
  /** @param {string} after */
  const firstCommitAfter = (after) => commits.find((c) => c.committedDate > after)

  // Author's top-level comments act as replies to earlier top-level feedback.
  const authorGeneral = [
    ...nodes(pr.comments).filter((c) => isPrAuthor(c.author)),
    ...nodes(pr.reviews).filter((r) => isPrAuthor(r.author) && (r.body ?? '').trim()),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  /** @type {Finding[]} */
  const findings = []

  // --- inline review threads -------------------------------------------------
  for (const thread of nodes(pr.reviewThreads)) {
    const comments = nodes(thread.comments)
    const reviewerComments = comments.filter((c) => isReviewer(c.author))
    if (reviewerComments.length === 0) continue
    const first = reviewerComments[0]
    const lastReviewer = reviewerComments[reviewerComments.length - 1]
    const authorReplies = comments.filter((c) => isPrAuthor(c.author) && c.createdAt > lastReviewer.createdAt)
    const lastReply = authorReplies[authorReplies.length - 1]
    const commit = firstCommitAfter(lastReviewer.createdAt)

    const intent = classifyIntent(first.body)

    /** @type {Status} */ let status
    let evidence
    if (thread.isResolved) {
      status = 'resolved'
      evidence = thread.resolvedBy ? `Thread resolved by ${thread.resolvedBy.login}.` : 'Thread resolved.'
    } else if (lastReply && claimsFix(lastReply.body)) {
      status = 'fixed-reply'
      evidence = `${prAuthor} replied: “${clip(lastReply.body)}”`
    } else if (intent && reviewerComments.length === 1) {
      status = intent.status
      evidence = intent.why
    } else if (thread.isOutdated) {
      status = 'outdated'
      evidence = 'The commented lines changed after this comment (outdated).'
    } else if (lastReply) {
      status = 'replied'
      evidence = `${prAuthor} replied without claiming a fix: “${clip(lastReply.body)}”`
    } else if (commit) {
      status = 'commit-after'
      evidence = `Commit ${commit.oid.slice(0, 7)} “${clip(commit.messageHeadline, 50)}” landed after, but the thread is unresolved.`
    } else {
      status = 'open'
      evidence = 'No reply, no resolve, no commit since.'
    }

    findings.push({
      id: first.id,
      kind: 'inline',
      author: first.author?.login ?? 'ghost',
      body: first.body,
      bodyHTML: first.bodyHTML,
      conversation: comments
        .filter((c) => c !== first && c.createdAt >= first.createdAt && c.author && !isBot(c.author, extraBots))
        .map((c) => ({ author: c.author?.login ?? 'ghost', body: c.body, bodyHTML: c.bodyHTML, createdAt: c.createdAt, url: c.url })),
      createdAt: first.createdAt,
      url: first.url,
      path: thread.path,
      line: thread.line,
      replies: comments.length - 1,
      lastReviewerAt: lastReviewer.createdAt,
      lastReviewer: lastReviewer.author?.login ?? 'ghost',
      lastReviewerBody: lastReviewer.body,
      replyBody: lastReply?.body,
      status,
      fixed: FIXED_STATUSES.has(status),
      noAction: NO_ACTION_STATUSES.has(status),
      evidence,
    })
  }

  // --- top-level: review bodies and conversation comments ---------------------
  /** @type {{c: RawComment, kind: 'review' | 'comment', state?: string}[]} */
  const general = [
    ...nodes(pr.reviews)
      .filter((r) => isReviewer(r.author) && ((r.body ?? '').trim() || r.state === 'CHANGES_REQUESTED'))
      .map((r) => ({ c: /** @type {RawComment} */ (r), kind: /** @type {const} */ ('review'), state: r.state })),
    ...nodes(pr.comments)
      .filter((c) => isReviewer(c.author))
      .map((c) => ({ c, kind: /** @type {const} */ ('comment') })),
  ]

  for (const { c, kind, state } of general) {
    const who = c.author?.login ?? 'ghost'
    const replies = authorGeneral.filter((r) => r.createdAt > c.createdAt && addresses(r.body, who))
    const reply = replies.find((r) => claimsFix(r.body)) ?? replies[0]
    const commit = firstCommitAfter(c.createdAt)

    /** @type {Status} */ let status
    let evidence
    const intent = classifyIntent(c.body, state)
    if (state === 'DISMISSED') {
      status = 'resolved'
      evidence = 'Review was dismissed.'
    } else if (reply && claimsFix(reply.body)) {
      status = 'fixed-reply'
      evidence = `${prAuthor} replied: “${clip(reply.body)}”`
    } else if (intent) {
      status = intent.status
      evidence = intent.why
    } else if (reply) {
      status = 'replied'
      evidence = `${prAuthor} replied without claiming a fix: “${clip(reply.body)}”`
    } else if (commit) {
      status = 'commit-after'
      evidence = `Commit ${commit.oid.slice(0, 7)} “${clip(commit.messageHeadline, 50)}” landed after this comment.`
    } else {
      status = 'open'
      evidence = 'No reply and no commit since.'
    }

    findings.push({
      id: c.id,
      kind,
      author: who,
      body: c.body,
      bodyHTML: c.bodyHTML,
      createdAt: c.createdAt,
      url: c.url,
      reviewState: state,
      replies: 0,
      lastReviewerAt: c.createdAt,
      lastReviewer: who,
      lastReviewerBody: c.body,
      replyBody: reply?.body,
      status,
      fixed: FIXED_STATUSES.has(status),
      noAction: NO_ACTION_STATUSES.has(status),
      evidence,
    })
  }

  findings.sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  return {
    id: pr.id,
    repo: pr.repository?.nameWithOwner ?? 'unknown/unknown',
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: prAuthor,
    isDraft: pr.isDraft,
    updatedAt: pr.updatedAt,
    reviewDecision: pr.reviewDecision,
    hasHumanComments: findings.length > 0,
    findings,
    counts: countFindings(findings),
    build: jenkinsBuild(pr),
  }
}

/**
 * A top-level author comment addresses reviewer `who` unless it mentions (with an at-sign)
 * other people and not them.
 * @param {string} body
 * @param {string} who
 */
function addresses(body, who) {
  const mentions = [...stripQuotes(body).matchAll(/@([A-Za-z0-9-]+)/g)].map((m) => m[1].toLowerCase())
  return mentions.length === 0 || mentions.includes(who.toLowerCase())
}

/** @param {Finding[]} findings */
export function countFindings(findings) {
  const fixed = findings.filter((f) => f.fixed).length
  const noAction = findings.filter((f) => f.noAction).length
  return { total: findings.length, fixed, noAction, pending: findings.length - fixed - noAction }
}
