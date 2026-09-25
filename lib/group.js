/**
 * Arrange a tab's PRs for display: one group per service (the repository name
 * without the org), and a Stale group at the bottom for PRs nobody has touched
 * in a week.
 *
 * Order everywhere is "what needs me first". PRs I'm on (review requested,
 * or already reviewed by me) come before PRs shown only because their repo is
 * watched; then PRs carrying my own comments (unfixed ones first), since
 * those are the ones waiting on a follow-up from me; then:
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

/** @typedef {{repo: string, updatedAt: string, counts?: {total: number, pending: number}, watched?: boolean, findings?: {author: string, fixed: boolean, noAction?: boolean}[]}} Sortable */

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

/** 0 = I have an unfixed comment here, 1 = I commented, 2 = I didn't. */
export function mineTier(/** @type {Sortable} */ pr, /** @type {string} */ viewer = '') {
  const own = viewer ? (pr.findings ?? []).filter((f) => f.author === viewer) : []
  if (own.some((f) => !f.fixed && !f.noAction)) return 0
  return own.length ? 1 : 2
}

/** @param {string} [viewer] */
export function byPriority(viewer = '') {
  return (/** @type {Sortable} */ a, /** @type {Sortable} */ b) =>
    Number(!!a.watched) - Number(!!b.watched) || mineTier(a, viewer) - mineTier(b, viewer) || tier(a) - tier(b) || b.updatedAt.localeCompare(a.updatedAt)
}

/**
 * @template {Sortable} P
 * @param {P[]} prs
 * @param {number} [now]
 * @param {string} [viewer]  my login: PRs with my comments rank first
 * @returns {{services: {name: string, prs: P[]}[], stale: P[]}}
 */
export function groupPRs(prs, now = Date.now(), viewer = '') {
  const order = byPriority(viewer)
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
  const groups = [...services.entries()].map(([name, list]) => ({ name, prs: list.sort(order) }))
  // Services before deployment repos; then a group's first PR is its most
  // urgent, so groups sort by it; name breaks ties.
  const deploy = (/** @type {{prs: P[]}} */ g) => (isDeployRepo(g.prs[0].repo) ? 1 : 0)
  groups.sort((a, b) => deploy(a) - deploy(b) || order(a.prs[0], b.prs[0]) || a.name.localeCompare(b.name))
  return { services: groups, stale: stale.sort(order) }
}
