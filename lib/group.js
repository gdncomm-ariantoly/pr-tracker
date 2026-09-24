/**
 * Arrange a tab's PRs for display: one group per service (the repository name
 * without the org), and a Stale group at the bottom for PRs nobody has touched
 * in a week.
 *
 * Order everywhere is "what needs me first":
 *   1. PRs with unfixed comments
 *   2. PRs with comments (all fixed or no action needed)
 *   3. PRs without human comments
 * and within each tier, most recently updated first. Groups follow the same
 * rule by their most urgent PR, except that deployment repos (prod-*,
 * nonprod-*) always come after the services themselves.
 */

import { NO_CI_REPO } from './store.js'

export const STALE_DAYS = 7
const DAY = 24 * 60 * 60 * 1000

/** @typedef {{repo: string, updatedAt: string, counts?: {total: number, pending: number}}} Sortable */

/** @param {string} repo  "owner/name" */
export function serviceName(repo) {
  return repo.split('/').pop() || repo
}

/** A deployment repo (prod-*, nonprod-*): config, not code, so it ranks lower. */
export function isDeployRepo(/** @type {string} */ repo) {
  return NO_CI_REPO.test(serviceName(repo))
}

/** 0 = unfixed comments, 1 = comments, 2 = none. */
export function tier(/** @type {Sortable} */ pr) {
  if ((pr.counts?.pending ?? 0) > 0) return 0
  if ((pr.counts?.total ?? 0) > 0) return 1
  return 2
}

/** @param {Sortable} a @param {Sortable} b */
export function byPriority(a, b) {
  return tier(a) - tier(b) || b.updatedAt.localeCompare(a.updatedAt)
}

/**
 * @template {Sortable} P
 * @param {P[]} prs
 * @param {number} [now]
 * @returns {{services: {name: string, prs: P[]}[], stale: P[]}}
 */
export function groupPRs(prs, now = Date.now()) {
  const cutoff = now - STALE_DAYS * DAY
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
  const groups = [...services.entries()].map(([name, list]) => ({ name, prs: list.sort(byPriority) }))
  // Services before deployment repos; then a group's first PR is its most
  // urgent, so groups sort by it; name breaks ties.
  const deploy = (/** @type {{prs: P[]}} */ g) => (isDeployRepo(g.prs[0].repo) ? 1 : 0)
  groups.sort((a, b) => deploy(a) - deploy(b) || byPriority(a.prs[0], b.prs[0]) || a.name.localeCompare(b.name))
  return { services: groups, stale: stale.sort(byPriority) }
}
