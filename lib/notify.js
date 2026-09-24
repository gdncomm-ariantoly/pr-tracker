/**
 * What changed between two snapshots that the user wants to hear about. Pure —
 * the worker turns the events into chrome.notifications.
 *
 *   My PRs         a new human comment, a reviewer following up in a thread,
 *                  the review decision becoming Approved / Changes requested,
 *                  the Jenkins build failing or recovering
 *   PRs I review   a new review request; one of *my* comments getting fixed
 *                  or answered by the author
 *
 * A macOS/Windows notification shows about one line of title, one line of
 * context and two or three lines of body, so each field has one job:
 *
 *   title    what happened, on which PR     "New comment · product-feed#152"
 *   context  who, and where                 "ricardo-franclinton · FacebookClientProperties.java:42"
 *   message  the words themselves           the comment or reply text
 */

/** @typedef {import('./github.js').Snapshot} Snapshot */
/** @typedef {import('./analyze.js').Finding} Finding */
/** @typedef {{key: string, url: string, title: string, context: string, message: string}} UpdateEvent */

const FIXED_VERB = /** @type {Record<string, string>} */ ({
  resolved: 'resolved it',
  outdated: 'changed the code',
  'fixed-reply': 'says it is fixed',
})

/** @param {string | undefined} text @param {number} [n] */
function clip(text, n = 160) {
  const one = (text ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^>.*$/gm, '') // quoted lines
    .replace(/[*_`#]/g, '') // markdown noise
    .replace(/\s+/g, ' ')
    .trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one || '(no text)'
}

/** @param {{repo: string, number: number}} pr */
const ref = (pr) => `${pr.repo.split('/').pop()}#${pr.number}`

/**
 * "gdncomm-ricardo-franclinton" → "ricardo-franclinton": org-prefixed logins
 * are the org's convention and eat half the line.
 *
 * @param {string | undefined} login
 * @param {string} repo
 */
export function shortLogin(login, repo) {
  const org = repo.split('/')[0]
  const name = login ?? 'someone'
  return org && name.toLowerCase().startsWith(`${org.toLowerCase()}-`) ? name.slice(org.length + 1) : name
}

/** @param {Finding} f */
function where(f) {
  if (f.kind !== 'inline' || !f.path) return f.kind === 'review' ? 'review' : 'conversation'
  return `${f.path.split('/').pop()}${f.line ? `:${f.line}` : ''}`
}

/**
 * @param {Snapshot | null | undefined} prev
 * @param {Snapshot | null | undefined} next
 * @returns {UpdateEvent[]}
 */
export function diffSnapshots(prev, next) {
  // First fetch, or a different account: everything would be "new". Say nothing.
  if (!prev || !next || prev.viewer !== next.viewer) return []
  const me = next.viewer
  /** @type {UpdateEvent[]} */
  const events = []

  const prevMine = new Map(prev.mine.map((p) => [p.id, p]))
  for (const pr of next.mine) {
    const old = prevMine.get(pr.id)
    if (!old) continue // newly opened PR — nothing on it is news yet
    const oldFindings = new Map(old.findings.map((f) => [f.id, f]))
    for (const f of pr.findings) {
      const was = oldFindings.get(f.id)
      if (!was) {
        events.push({
          key: `new:${f.id}`,
          url: f.url,
          title: `New comment · ${ref(pr)}`,
          context: `${shortLogin(f.author, pr.repo)} · ${where(f)}`,
          message: clip(f.body),
        })
      } else if (f.lastReviewerAt > was.lastReviewerAt) {
        events.push({
          key: `followup:${f.id}:${f.lastReviewerAt}`,
          url: f.url,
          title: `New reply · ${ref(pr)}`,
          context: `${shortLogin(f.lastReviewer ?? f.author, pr.repo)} · ${where(f)}`,
          message: clip(f.lastReviewerBody ?? f.body),
        })
      }
    }
    const was = old.build?.state
    const now = pr.build?.state
    if (pr.build && now !== was && (now === 'failure' || (now === 'success' && was === 'failure'))) {
      events.push({
        key: `build:${pr.id}:${pr.build.url ?? ''}:${now}`,
        url: pr.build.url ?? pr.url,
        title: `${now === 'failure' ? 'Build failed' : 'Build fixed'} · ${ref(pr)}`,
        context: `${pr.build.name}${pr.build.number ? ` #${pr.build.number}` : ''}`,
        message: clip(pr.title),
      })
    }
    if (pr.reviewDecision !== old.reviewDecision && (pr.reviewDecision === 'APPROVED' || pr.reviewDecision === 'CHANGES_REQUESTED')) {
      events.push({
        key: `decision:${pr.id}:${pr.reviewDecision}`,
        url: pr.url,
        title: `${pr.reviewDecision === 'APPROVED' ? 'Approved' : 'Changes requested'} · ${ref(pr)}`,
        context: 'Your PR',
        message: clip(pr.title),
      })
    }
  }

  const prevReview = new Map(prev.toReview.map((p) => [p.id, p]))
  for (const pr of next.toReview) {
    const old = prevReview.get(pr.id)
    if (pr.requested && !old?.requested) {
      events.push({
        key: `requested:${pr.id}:${pr.updatedAt}`,
        url: pr.url,
        title: `Review requested · ${ref(pr)}`,
        context: `from ${shortLogin(pr.author, pr.repo)}`,
        message: clip(pr.title),
      })
    }
    // A new PR in a repo that was already watched last time (not every open PR
    // the moment a repo is added to the list).
    if (!old && pr.watched && prev.watchedRepos?.includes(pr.repo.toLowerCase())) {
      events.push({
        key: `watched:${pr.id}`,
        url: pr.url,
        title: `New PR · ${ref(pr)}`,
        context: `from ${shortLogin(pr.author, pr.repo)} · watched repo`,
        message: clip(pr.title),
      })
    }
    if (!old) continue
    const oldFindings = new Map(old.findings.map((f) => [f.id, f]))
    for (const f of pr.findings) {
      if (f.author !== me) continue
      const was = oldFindings.get(f.id)
      if (!was || was.status === f.status) continue
      if (f.fixed && !was.fixed) {
        events.push({
          key: `fixed:${f.id}`,
          url: f.url,
          title: `Your comment fixed · ${ref(pr)}`,
          context: `${shortLogin(pr.author, pr.repo)} ${FIXED_VERB[f.status] ?? 'fixed it'} · ${where(f)}`,
          message: clip(f.replyBody ?? f.body),
        })
      } else if (f.status === 'replied' && !was.fixed && was.status !== 'replied') {
        events.push({
          key: `replied:${f.id}`,
          url: f.url,
          title: `Reply to your comment · ${ref(pr)}`,
          context: `${shortLogin(pr.author, pr.repo)} · ${where(f)}`,
          message: clip(f.replyBody ?? f.evidence),
        })
      }
    }
  }
  return events
}
