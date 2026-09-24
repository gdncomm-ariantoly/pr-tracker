/**
 * What changed between two snapshots that the user wants to hear about. Pure —
 * the worker turns the events into chrome.notifications.
 *
 *   My PRs         a new human comment, a reviewer following up in a thread,
 *                  the review decision becoming Approved / Changes requested
 *   PRs I review   a new review request; one of *my* comments getting fixed
 *                  or answered by the author
 */

/** @typedef {import('./github.js').Snapshot} Snapshot */
/** @typedef {import('./analyze.js').Finding} Finding */
/** @typedef {{key: string, url: string, title: string, message: string}} UpdateEvent */

const FIXED_LABEL = /** @type {Record<string, string>} */ ({
  resolved: 'resolved',
  outdated: 'changed the code for',
  'fixed-reply': 'fixed',
})

/** @param {string} text @param {number} [n] */
function clip(text, n = 90) {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** @param {{repo: string, number: number}} pr */
const ref = (pr) => `${pr.repo.split('/').pop()}#${pr.number}`

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
          title: `${f.author} commented on ${ref(pr)}`,
          message: `${f.path ? `${f.path}: ` : ''}${clip(f.body)}`,
        })
      } else if (f.lastReviewerAt > was.lastReviewerAt) {
        events.push({
          key: `followup:${f.id}:${f.lastReviewerAt}`,
          url: f.url,
          title: `${f.lastReviewer ?? f.author} replied on ${ref(pr)}`,
          message: `${f.path ? `${f.path}: ` : ''}${clip(f.body, 60)}`,
        })
      }
    }
    if (pr.reviewDecision !== old.reviewDecision && (pr.reviewDecision === 'APPROVED' || pr.reviewDecision === 'CHANGES_REQUESTED')) {
      events.push({
        key: `decision:${pr.id}:${pr.reviewDecision}`,
        url: pr.url,
        title: `${ref(pr)} ${pr.reviewDecision === 'APPROVED' ? 'approved' : 'needs changes'}`,
        message: pr.title,
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
        title: `Review requested: ${ref(pr)}`,
        message: `${pr.author}: ${pr.title}`,
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
          title: `${pr.author} ${FIXED_LABEL[f.status] ?? 'fixed'} your comment on ${ref(pr)}`,
          message: clip(f.body),
        })
      } else if (f.status === 'replied' && !was.fixed && was.status !== 'replied') {
        events.push({
          key: `replied:${f.id}`,
          url: f.url,
          title: `${pr.author} answered your comment on ${ref(pr)}`,
          message: clip(f.evidence),
        })
      }
    }
  }
  return events
}
