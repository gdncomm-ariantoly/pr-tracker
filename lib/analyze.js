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
 */

/** @typedef {{login: string, __typename?: string} | null} Actor */
/** @typedef {{id: string, author: Actor, body: string, createdAt: string, url: string}} RawComment */
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
 */

/** @typedef {'resolved' | 'outdated' | 'fixed-reply' | 'replied' | 'commit-after' | 'open'} Status */

/**
 * @typedef {object} Finding
 * @property {string} id
 * @property {'inline' | 'review' | 'comment'} kind
 * @property {string} author
 * @property {string} body
 * @property {string} createdAt
 * @property {string} url
 * @property {string} [path]
 * @property {number | null} [line]
 * @property {string} [reviewState]
 * @property {number} replies  human replies after the first comment (threads only)
 * @property {string} lastReviewerAt  latest comment by a reviewer in this thread (= createdAt for top-level)
 * @property {string} [lastReviewer]  who wrote it
 * @property {Status} status
 * @property {boolean} fixed
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
 * @property {{total: number, fixed: number, pending: number}} counts
 */

const FIXED_STATUSES = new Set(['resolved', 'outdated', 'fixed-reply'])

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

    /** @type {Status} */ let status
    let evidence
    if (thread.isResolved) {
      status = 'resolved'
      evidence = thread.resolvedBy ? `Thread resolved by ${thread.resolvedBy.login}.` : 'Thread resolved.'
    } else if (lastReply && claimsFix(lastReply.body)) {
      status = 'fixed-reply'
      evidence = `${prAuthor} replied: “${clip(lastReply.body)}”`
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
      createdAt: first.createdAt,
      url: first.url,
      path: thread.path,
      line: thread.line,
      replies: comments.length - 1,
      lastReviewerAt: lastReviewer.createdAt,
      lastReviewer: lastReviewer.author?.login ?? 'ghost',
      status,
      fixed: FIXED_STATUSES.has(status),
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
    if (state === 'DISMISSED') {
      status = 'resolved'
      evidence = 'Review was dismissed.'
    } else if (reply && claimsFix(reply.body)) {
      status = 'fixed-reply'
      evidence = `${prAuthor} replied: “${clip(reply.body)}”`
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
      createdAt: c.createdAt,
      url: c.url,
      reviewState: state,
      replies: 0,
      lastReviewerAt: c.createdAt,
      lastReviewer: who,
      status,
      fixed: FIXED_STATUSES.has(status),
      evidence,
    })
  }

  findings.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const fixed = findings.filter((f) => f.fixed).length

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
    counts: { total: findings.length, fixed, pending: findings.length - fixed },
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
