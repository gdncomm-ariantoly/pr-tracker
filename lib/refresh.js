import { fetchDashboard } from './github.js'
import { applyJudgement, CLAUDE_ORIGIN, describePR, judgePR, signature } from './claude.js'
import { fetchJenkinsBuild, mapLimit } from './jenkins.js'
import { prKey } from './sessions.js'
import { JENKINS_TEMPLATE, jenkinsJobUrl, jenkinsOrigin, loadClaudeCache, loadSettings, loadSnapshot, saveClaudeCache, skipsJenkins, saveError, saveSnapshot } from './store.js'

/**
 * @typedef {object} RefreshDeps
 * @property {import('./store.js').AreaLike} [area]
 * @property {typeof fetch} [fetchImpl]  GitHub
 * @property {number[]} [retryDelays]  waits before retrying a GitHub timeout (tests pass [])
 * @property {typeof fetch} [jenkinsFetch]  Jenkins (defaults to fetchImpl)
 * @property {(origin: string) => Promise<boolean>} [jenkinsAllowed]  has the user granted access to this Jenkins?
 * @property {typeof fetch} [claudeFetch]  Anthropic API (defaults to fetchImpl)
 * @property {(origin: string) => Promise<boolean>} [claudeAllowed]  has the user granted access to api.anthropic.com?
 * @property {(keys: string[]) => Promise<Record<string, import('./sessions.js').LocalSession[]> | null>} [localSessions]  the Claude Code helper; null when not connected
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
    const snapshot = await fetchDashboard({ token: settings.token, extraBots: settings.extraBots, watchedRepos: settings.watchedRepos, fetchImpl: deps.fetchImpl, retryDelays: deps.retryDelays })
    // Test automation (cucumber-*): Jenkins isn't wanted there, even when
    // GitHub reports a build — no chip, no link, no build notifications.
    for (const pr of [...snapshot.mine, ...snapshot.toReview]) if (skipsJenkins(pr)) pr.build = null
    const auth = settings.jenkinsUser && settings.jenkinsToken ? { user: settings.jenkinsUser, token: settings.jenkinsToken } : null
    await addJenkinsBuilds(snapshot, JENKINS_TEMPLATE, deps, auth)
    await addLocalSessions(snapshot, deps)
    if (settings.claudeKey) await addClaudeJudgements(snapshot, { apiKey: settings.claudeKey, model: settings.claudeModel }, deps, settings.claudeAuto)
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

/**
 * Ask the local helper which Claude Code sessions touched each PR. Mutates the
 * snapshot; a missing or failing helper just means no sessions.
 *
 * @param {import('./github.js').Snapshot} snapshot
 * @param {RefreshDeps} deps
 */
export async function addLocalSessions(snapshot, deps) {
  if (!deps.localSessions) return
  const prs = [...snapshot.mine, ...snapshot.toReview]
  let found
  try {
    found = await deps.localSessions([...new Set(prs.map(prKey))])
  } catch (error) {
    snapshot.claudeCode = { state: 'error', message: error instanceof Error ? error.message : String(error) }
    return
  }
  if (!found) return
  for (const pr of prs) {
    const hits = found[prKey(pr)]
    if (hits?.length) pr.ccSessions = hits
  }
  snapshot.claudeCode = { state: 'ok' }
}

/** New Claude calls per refresh; the rest wait for the next one. */
export const CLAUDE_CALLS_PER_REFRESH = 12

/**
 * Let Claude judge every PR with human comments — reusing the last answer when
 * nothing it would see has changed. Mutates the snapshot.
 *
 * @param {import('./github.js').Snapshot} snapshot
 * @param {import('./claude.js').ClaudeAuth} auth
 * @param {RefreshDeps} deps
 * @param {boolean} [auto]  ask Claude about changed PRs; false: only reuse answers (the card's Summarize asks)
 */
export async function addClaudeJudgements(snapshot, auth, deps, auto = true) {
  if (!deps.claudeAllowed || !(await deps.claudeAllowed(CLAUDE_ORIGIN))) {
    snapshot.claude = { state: 'no-access' }
    return
  }
  const fetchImpl = deps.claudeFetch ?? deps.fetchImpl ?? fetch
  const cache = await loadClaudeCache(deps.area)
  /** @type {import('./store.js').ClaudeCache} */
  const nextCache = {}
  /** @type {Map<string, {pr: import('./analyze.js').PRSummary, sig: string}>} one PR can sit in both lists */
  const todo = new Map()
  let pending = 0
  for (const pr of [...snapshot.mine, ...snapshot.toReview]) {
    if (!pr.hasHumanComments || todo.has(pr.id) || nextCache[pr.id]) continue
    const sig = signature(describePR(pr), auth.model)
    const hit = cache[pr.id]
    if (hit?.sig === sig) nextCache[pr.id] = hit
    else if (!auto) {
      if (hit) nextCache[pr.id] = { ...hit, stale: true } // keep the old answer, flagged
    } else if (todo.size < CLAUDE_CALLS_PER_REFRESH) todo.set(pr.id, { pr, sig })
    else pending += 1
  }
  const jobs = [...todo.values()]
  const results = await mapLimit(jobs, 3, (job) => judgePR(job.pr, auth, fetchImpl))
  /** @type {string[]} */
  const errors = []
  let refused = 0
  let badKey = false
  results.forEach((r, i) => {
    if (r.kind === 'ok') nextCache[jobs[i].pr.id] = { sig: jobs[i].sig, at: new Date().toISOString(), judgement: r.judgement }
    else if (r.kind === 'bad-key') badKey = true
    else if (r.kind === 'refused') refused += 1
    else errors.push(r.message)
  })
  // Keep a stale answer for a PR that failed this time rather than lose it.
  for (const job of jobs) if (!nextCache[job.pr.id] && cache[job.pr.id]) nextCache[job.pr.id] = cache[job.pr.id]
  await saveClaudeCache(nextCache, deps.area)

  const judge = (/** @type {any} */ pr) => {
    const hit = nextCache[pr.id]
    if (!hit) return pr
    const judged = applyJudgement(pr, hit.judgement)
    return hit.stale ? { ...judged, aiStale: true } : judged
  }
  snapshot.mine = snapshot.mine.map(judge)
  snapshot.toReview = snapshot.toReview.map(judge)
  snapshot.claude = { state: badKey ? 'bad-key' : 'ok', judged: Object.keys(nextCache).length, pending }
  if (errors.length) snapshot.warnings = [...(snapshot.warnings ?? []), `Claude couldn't judge ${errors.length} PR${errors.length === 1 ? '' : 's'}; the rules' guess is shown instead. ${errors[0]}`]
  if (refused) snapshot.warnings = [...(snapshot.warnings ?? []), `Claude declined to judge ${refused} PR${refused === 1 ? '' : 's'}; the rules' guess is shown instead.`]
}

/**
 * The card's Summarize button: ask Claude about one PR now, whatever the
 * automatic setting, and update the stored snapshot.
 *
 * @param {string} prId
 * @param {RefreshDeps} deps
 * @returns {Promise<import('./claude.js').ClaudeResult['kind'] | 'no-key' | 'no-access' | 'gone'>}
 */
export async function judgeOnePR(prId, deps) {
  const settings = await loadSettings(deps.area)
  if (!settings.claudeKey) return 'no-key'
  if (!deps.claudeAllowed || !(await deps.claudeAllowed(CLAUDE_ORIGIN))) return 'no-access'
  const snapshot = await loadSnapshot(deps.area)
  const pr = snapshot && [...snapshot.mine, ...snapshot.toReview].find((p) => p.id === prId)
  if (!snapshot || !pr) return 'gone'
  const auth = { apiKey: settings.claudeKey, model: settings.claudeModel }
  const result = await judgePR(pr, auth, deps.claudeFetch ?? deps.fetchImpl ?? fetch)
  if (result.kind !== 'ok') return result.kind
  const cache = await loadClaudeCache(deps.area)
  // Claude's own verdicts don't enter describePR, so this matches the next refresh's signature.
  cache[prId] = { sig: signature(describePR(pr), auth.model), at: new Date().toISOString(), judgement: result.judgement }
  await saveClaudeCache(cache, deps.area)
  const judge = (/** @type {any} */ p) => (p.id === prId ? applyJudgement(p, result.judgement) : p)
  await saveSnapshot({ ...snapshot, mine: snapshot.mine.map(judge), toReview: snapshot.toReview.map(judge) }, deps.area)
  return 'ok'
}

/** Badge text: review-requested PRs still waiting. */
export function badgeFor(/** @type {import('./github.js').Snapshot | null} */ snapshot) {
  const n = snapshot?.toReview.filter((p) => p.requested).length ?? 0
  return n === 0 ? '' : n > 99 ? '99+' : String(n)
}
