import { fetchDashboard } from './github.js'
import { loadSettings, saveError, saveSnapshot } from './store.js'

/**
 * Fetch, persist, and return the snapshot — or persist the error. Shared by the
 * page's Refresh button and the worker's alarm, so both go through one path.
 *
 * @param {{area?: import('./store.js').AreaLike, fetchImpl?: typeof fetch}} [deps]
 */
export async function refresh(deps = {}) {
  const settings = await loadSettings(deps.area)
  try {
    const snapshot = await fetchDashboard({ token: settings.token, extraBots: settings.extraBots, fetchImpl: deps.fetchImpl })
    await saveSnapshot(snapshot, deps.area)
    return snapshot
  } catch (error) {
    await saveError(error instanceof Error ? error.message : String(error), deps.area)
    throw error
  }
}

/** Badge text: review-requested PRs still waiting. */
export function badgeFor(/** @type {import('./github.js').Snapshot | null} */ snapshot) {
  const n = snapshot?.toReview.filter((p) => p.requested).length ?? 0
  return n === 0 ? '' : n > 99 ? '99+' : String(n)
}
