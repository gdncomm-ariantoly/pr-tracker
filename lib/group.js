/**
 * Arrange a tab's PRs for display: one group per service (the repository name
 * without the org), and a Stale group at the bottom for PRs nobody has touched
 * in a week.
 */

export const STALE_DAYS = 7
const DAY = 24 * 60 * 60 * 1000

/** @param {string} repo  "owner/name" */
export function serviceName(repo) {
  return repo.split('/').pop() || repo
}

/**
 * @template {{repo: string, updatedAt: string}} P
 * @param {P[]} prs
 * @param {number} [now]
 * @returns {{services: {name: string, prs: P[]}[], stale: P[]}}
 */
export function groupPRs(prs, now = Date.now()) {
  const cutoff = now - STALE_DAYS * DAY
  const byNewest = (/** @type {P} */ a, /** @type {P} */ b) => b.updatedAt.localeCompare(a.updatedAt)
  /** @type {Map<string, P[]>} */
  const services = new Map()
  /** @type {P[]} */
  const stale = []
  for (const pr of prs) {
    const updated = Date.parse(pr.updatedAt)
    if (Number.isFinite(updated) && updated < cutoff) {
      stale.push(pr)
      continue
    }
    const name = serviceName(pr.repo)
    const list = services.get(name) ?? []
    list.push(pr)
    services.set(name, list)
  }
  return {
    services: [...services.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, list]) => ({ name, prs: list.sort(byNewest) })),
    stale: stale.sort(byNewest),
  }
}
