import { fetchDashboard } from './github.js'
import { fetchJenkinsBuild, mapLimit } from './jenkins.js'
import { JENKINS_TEMPLATE, jenkinsJobUrl, jenkinsOrigin, loadSettings, skipsJenkins, saveError, saveSnapshot } from './store.js'

/**
 * @typedef {object} RefreshDeps
 * @property {import('./store.js').AreaLike} [area]
 * @property {typeof fetch} [fetchImpl]  GitHub
 * @property {typeof fetch} [jenkinsFetch]  Jenkins (defaults to fetchImpl)
 * @property {(origin: string) => Promise<boolean>} [jenkinsAllowed]  has the user granted access to this Jenkins?
 */

/**
 * Fetch, persist, and return the snapshot — or persist the error. Shared by the
 * page's Refresh button and the worker's alarm, so both go through one path.
 *
 * @param {RefreshDeps} [deps]
 */
export async function refresh(deps = {}) {
  const settings = await loadSettings(deps.area)
  try {
    const snapshot = await fetchDashboard({ token: settings.token, extraBots: settings.extraBots, watchedRepos: settings.watchedRepos, fetchImpl: deps.fetchImpl })
    // Test automation (cucumber-*): Jenkins isn't wanted there, even when
    // GitHub reports a build — no chip, no link, no build notifications.
    for (const pr of [...snapshot.mine, ...snapshot.toReview]) if (skipsJenkins(pr)) pr.build = null
    const auth = settings.jenkinsUser && settings.jenkinsToken ? { user: settings.jenkinsUser, token: settings.jenkinsToken } : null
    await addJenkinsBuilds(snapshot, JENKINS_TEMPLATE, deps, auth)
    await saveSnapshot(snapshot, deps.area)
    return snapshot
  } catch (error) {
    await saveError(error instanceof Error ? error.message : String(error), deps.area)
    throw error
  }
}

/**
 * For every PR GitHub gave no build for, ask Jenkins itself — only with a
 * Jenkins API token, and once Chrome has granted access to that Jenkins.
 * Mutates the snapshot.
 *
 * @param {import('./github.js').Snapshot} snapshot
 * @param {string} template
 * @param {RefreshDeps} deps
 * @param {import('./jenkins.js').JenkinsAuth | null} [auth]  Jenkins API token; nothing is asked without one
 */
export async function addJenkinsBuilds(snapshot, template, deps, auth = null) {
  const origin = jenkinsOrigin(template)
  if (!auth || !origin || !deps.jenkinsAllowed || !(await deps.jenkinsAllowed(origin))) return
  const fetchImpl = deps.jenkinsFetch ?? deps.fetchImpl ?? fetch
  /** @type {Map<string, import('./github.js').ReviewPR[]>} one PR can sit in both lists */
  const byId = new Map()
  for (const pr of [...snapshot.mine, ...snapshot.toReview]) {
    if (pr.build || skipsJenkins(pr)) continue
    byId.set(pr.id, [...(byId.get(pr.id) ?? []), pr])
  }
  const targets = [...byId.values()]
  const results = await mapLimit(targets, 6, (copies) => {
    const url = jenkinsJobUrl(template, copies[0])
    return url ? fetchJenkinsBuild(url, fetchImpl, auth) : Promise.resolve(/** @type {const} */ ({ kind: 'none' }))
  })
  results.forEach((result, i) => {
    for (const pr of targets[i]) {
      if (result.kind === 'build') pr.build = result.build
    }
  })
  snapshot.jenkinsChecked = true
  snapshot.jenkinsBadToken = results.some((r) => r.kind === 'bad-token')
}

/** Badge text: review-requested PRs still waiting. */
export function badgeFor(/** @type {import('./github.js').Snapshot | null} */ snapshot) {
  const n = snapshot?.toReview.filter((p) => p.requested).length ?? 0
  return n === 0 ? '' : n > 99 ? '99+' : String(n)
}
