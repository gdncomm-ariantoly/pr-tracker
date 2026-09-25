import { analyzePR } from './analyze.js'
import { fetchDashboard, fetchPR } from './github.js'
import { applyJudgement, describePR, judgePRLocal, signature } from './claude.js'
import { fetchJenkinsBuild, fetchJenkinsFolders, mapLimit } from './jenkins.js'
import { prKey } from './sessions.js'
import { KEYCHAIN_REF, JENKINS_FOLDERS_URL, JENKINS_TEMPLATE, jenkinsJobUrl, jenkinsOrigin, loadClaudeCache, loadJenkinsFolders, saveJenkinsFolders, loadSettings, loadSnapshot, saveClaudeCache, skipsJenkins, saveError, saveSnapshot } from './store.js'

/**
 * @typedef {object} RefreshDeps
 * @property {import('./store.js').AreaLike} [area]
 * @property {typeof fetch} [fetchImpl]  GitHub
 * @property {number[]} [retryDelays]  waits before retrying a GitHub timeout (tests pass [])
 * @property {typeof fetch} [jenkinsFetch]  Jenkins (defaults to fetchImpl)
 * @property {(origin: string) => Promise<boolean>} [jenkinsAllowed]  has the user granted access to this Jenkins?
 * @property {(keys: string[]) => Promise<Record<string, import('./sessions.js').LocalSession[]> | null>} [localSessions]  the Claude Code helper; null when not connected
 * @property {{allowed: () => Promise<boolean>, ask: import('./claude.js').AskClaudeCode}} [claudeCode]  Claude Code on this Mac, through the helper
 * @property {{get: (name: 'github' | 'jenkins') => Promise<string>}} [secrets]  the macOS Keychain, through the helper
 */

/**
 * Settings with the real tokens in place: a token kept in the Keychain is
 * stored as KEYCHAIN_REF and read from the helper only for this refresh.
 *
 * @param {import('./store.js').Settings} settings
 * @param {RefreshDeps} deps
 */
export async function withSecrets(settings, deps) {
  const read = async (/** @type {'github' | 'jenkins'} */ name, /** @type {string} */ value) => {
    if (value !== KEYCHAIN_REF) return value
    if (!deps.secrets) throw new Error(`Your ${name === 'github' ? 'GitHub' : 'Jenkins'} token is in the macOS Keychain, but the Claude Code helper isn't available here.`)
    try {
      return await deps.secrets.get(name)
    } catch (error) {
      throw new Error(`Couldn't read your ${name === 'github' ? 'GitHub' : 'Jenkins'} token from the macOS Keychain: ${error instanceof Error ? error.message : String(error)}. Is the Claude Code helper connected (Settings)?`)
    }
  }
  return { ...settings, token: await read('github', settings.token), jenkinsToken: await read('jenkins', settings.jenkinsToken) }
}

/** Is the Claude Code helper connected? Claude is used only through it. @param {RefreshDeps} deps */
async function claudeReachable(deps) {
  return !!deps.claudeCode && (await deps.claudeCode.allowed())
}

/** @param {import('./analyze.js').PRSummary} pr @param {import('./claude.js').ClaudeAuth} auth @param {RefreshDeps} deps */
function judgeWith(pr, auth, deps) {
  if (!deps.claudeCode) return Promise.resolve(/** @type {import('./claude.js').ClaudeResult} */ ({ kind: 'error', message: 'The Claude Code helper is not connected' }))
  return judgePRLocal(pr, auth.model, deps.claudeCode.ask)
}

/**
 * Fetch, persist, and return the snapshot — or persist the error. Shared by the
 * page's Refresh button and the worker's alarm, so both go through one path.
 *
 * @param {RefreshDeps} [deps]
 */
export async function refresh(deps = {}) {
  try {
    const settings = await withSecrets(await loadSettings(deps.area), deps)
    const snapshot = await fetchDashboard({ token: settings.token, extraBots: settings.extraBots, watchedRepos: settings.watchedRepos, fetchImpl: deps.fetchImpl, retryDelays: deps.retryDelays })
    // Test automation (cucumber-*): Jenkins isn't wanted there, even when
    // GitHub reports a build — no chip, no link, no build notifications.
    for (const pr of [...snapshot.mine, ...snapshot.toReview]) if (skipsJenkins(pr)) pr.build = null
    const auth = settings.jenkinsUser && settings.jenkinsToken ? { user: settings.jenkinsUser, token: settings.jenkinsToken } : null
    await addJenkinsBuilds(snapshot, JENKINS_TEMPLATE, deps, auth)
    await addLocalSessions(snapshot, deps)
    await addClaudeJudgements(snapshot, { model: settings.claudeModel }, deps)
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
  const all = [...snapshot.mine, ...snapshot.toReview]
  const folders = await jenkinsFolders(all, fetchImpl, auth, deps)
  if (folders === 'bad-token') {
    snapshot.jenkinsChecked = true
    snapshot.jenkinsBadToken = true
    return
  }
  /** @type {Map<string, import('./github.js').ReviewPR[]>} one PR can sit in both lists */
  const byId = new Map()
  for (const pr of all) {
    if (pr.build || skipsJenkins(pr)) continue
    byId.set(pr.id, [...(byId.get(pr.id) ?? []), pr])
  }
  const targets = [...byId.values()]
  const results = await mapLimit(targets, 6, async (copies) => {
    // A repo in several teams' folders: the first folder with a build wins.
    /** @type {import('./jenkins.js').JenkinsResult} */
    let result = { kind: 'none' }
    for (const folder of folders?.[repoName(copies[0])] ?? []) {
      const url = jenkinsJobUrl(template, copies[0], folder)
      if (!url) break
      result = await fetchJenkinsBuild(url, fetchImpl, auth)
      if (result.kind === 'build') break
      if (result.kind === 'bad-token') break
    }
    return result
  })
  results.forEach((result, i) => {
    for (const pr of targets[i]) {
      if (result.kind === 'build') pr.build = result.build
    }
  })
  snapshot.jenkinsChecked = true
  snapshot.jenkinsBadToken = results.some((r) => r.kind === 'bad-token')
}

const repoName = (/** @type {{repo: string}} */ pr) => (pr.repo.split('/').pop() ?? '').toLowerCase()
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

/**
 * Repo → team folders, from the cache when it's fresh: a day old at most, or
 * an hour when some PR's repo isn't in it (a new repo gets its folder soon).
 *
 * @param {{repo: string}[]} prs
 * @param {typeof fetch} fetchImpl
 * @param {import('./jenkins.js').JenkinsAuth} auth
 * @param {RefreshDeps} deps
 * @returns {Promise<Record<string, string[]> | null | 'bad-token'>}
 */
async function jenkinsFolders(prs, fetchImpl, auth, deps) {
  const cached = await loadJenkinsFolders(deps.area)
  const age = cached ? Date.now() - Date.parse(cached.at) : Infinity
  const missing = cached ? prs.some((p) => !skipsJenkins(p) && !cached.folders[repoName(p)] && !/^(?:prod|nonprod)-/i.test(repoName(p))) : true
  if (cached && age < DAY && !(missing && age > HOUR)) return cached.folders
  const listed = await fetchJenkinsFolders(JENKINS_FOLDERS_URL, fetchImpl, auth)
  if (listed.kind === 'bad-token') return 'bad-token'
  if (listed.kind === 'error') return cached?.folders ?? null
  await saveJenkinsFolders({ at: new Date().toISOString(), folders: listed.folders }, deps.area)
  return listed.folders
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

/**
 * Put stored Claude answers back on the PRs. Claude is asked only from a
 * card's Summarize button, never by a refresh: an answer whose PR changed
 * since stays, marked outdated. Mutates the snapshot; sends nothing.
 *
 * @param {import('./github.js').Snapshot} snapshot
 * @param {import('./claude.js').ClaudeAuth} auth
 * @param {RefreshDeps} deps
 */
export async function addClaudeJudgements(snapshot, auth, deps) {
  const cache = await loadClaudeCache(deps.area)
  /** @type {import('./store.js').ClaudeCache} */
  const nextCache = {}
  for (const pr of [...snapshot.mine, ...snapshot.toReview]) {
    const hit = cache[pr.id]
    if (!pr.hasHumanComments || !hit || nextCache[pr.id]) continue
    nextCache[pr.id] = hit.sig === signature(describePR(pr), auth.model) ? { ...hit, stale: false } : { ...hit, stale: true }
  }
  // Answers for PRs no longer listed are dropped.
  await saveClaudeCache(nextCache, deps.area)
  const judge = (/** @type {any} */ pr) => {
    const hit = nextCache[pr.id]
    if (!hit) return pr
    const judged = applyJudgement(pr, hit.judgement)
    return hit.stale ? { ...judged, aiStale: true } : judged
  }
  snapshot.mine = snapshot.mine.map(judge)
  snapshot.toReview = snapshot.toReview.map(judge)
  snapshot.claude = { state: 'ok', judged: Object.keys(nextCache).length }
}

/** Chains read-modify-write updates of stored state within this page or worker. */
let writes = Promise.resolve()

/**
 * Change the stored snapshot starting from its latest version, one change at
 * a time: two cards' Summarize or ↻ finishing together must not overwrite
 * each other's result with a stale copy.
 *
 * @param {import('./store.js').AreaLike | undefined} area
 * @param {(snapshot: import('./github.js').Snapshot) => Promise<import('./github.js').Snapshot> | import('./github.js').Snapshot} change
 */
function updateSnapshot(area, change) {
  const run = writes.then(async () => {
    const latest = await loadSnapshot(area)
    if (latest) await saveSnapshot(await change(latest), area)
  })
  writes = run.catch(() => {})
  return run
}

/**
 * The card's Summarize button: the only way Claude is asked. Judges one PR
 * now and updates the stored snapshot.
 *
 * @param {string} prId
 * @param {RefreshDeps} deps
 * @returns {Promise<{kind: import('./claude.js').ClaudeResult['kind'] | 'no-helper' | 'gone', message?: string}>}
 */
export async function judgeOnePR(prId, deps) {
  const settings = await loadSettings(deps.area)
  const auth = { model: settings.claudeModel }
  if (!(await claudeReachable(deps))) return { kind: 'no-helper' }
  const snapshot = await loadSnapshot(deps.area)
  const pr = snapshot && [...snapshot.mine, ...snapshot.toReview].find((p) => p.id === prId)
  if (!snapshot || !pr) return { kind: 'gone' }
  const result = await judgeWith(pr, auth, deps)
  if (result.kind === 'error') return { kind: 'error', message: result.message }
  // A fresh answer is not outdated, whatever the old one was.
  const judge = (/** @type {any} */ p) => (p.id === prId ? { ...applyJudgement(p, result.judgement), aiStale: undefined } : p)
  await updateSnapshot(deps.area, async (latest) => {
    const cache = await loadClaudeCache(deps.area)
    // Claude's own verdicts don't enter describePR, so this matches the next refresh's signature.
    cache[prId] = { sig: signature(describePR(pr), auth.model), at: new Date().toISOString(), judgement: result.judgement }
    await saveClaudeCache(cache, deps.area)
    return { ...latest, mine: latest.mine.map(judge), toReview: latest.toReview.map(judge) }
  })
  return { kind: 'ok' }
}

/**
 * Still waiting on my review? A request to me by name counts; a team request
 * counts only if the PR was already listed as requested (GitHub doesn't say
 * which teams I'm in).
 *
 * @param {any} node  the fresh PR from GitHub
 * @param {string} viewer
 * @param {boolean} wasRequested
 */
export function stillRequested(node, viewer, wasRequested) {
  const who = (node.reviewRequests?.nodes ?? []).map((/** @type {any} */ n) => n?.requestedReviewer)
  if (who.some((/** @type {any} */ r) => r?.__typename === 'User' && r.login === viewer)) return true
  return wasRequested && who.some((/** @type {any} */ r) => !r || r.__typename === 'Team')
}

/**
 * A card's own Refresh: fetch that one PR again and put it back in place,
 * with its Jenkins build, Claude Code sessions and any Claude answer. A PR
 * that was merged or closed meanwhile leaves the list, with a note.
 *
 * @param {string} prId
 * @param {RefreshDeps} [deps]
 * @returns {Promise<{kind: 'ok' | 'merged' | 'closed' | 'gone' | 'error', message?: string}>}
 */
export async function refreshOnePR(prId, deps = {}) {
  let settings
  try {
    settings = await withSecrets(await loadSettings(deps.area), deps)
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
  const snapshot = await loadSnapshot(deps.area)
  const old = snapshot && [...snapshot.mine, ...snapshot.toReview].find((p) => p.id === prId)
  if (!snapshot || !old) return { kind: 'gone' }
  let got
  try {
    got = await fetchPR({ token: settings.token, id: prId, fetchImpl: deps.fetchImpl, retryDelays: deps.retryDelays })
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
  const drop = (/** @type {{id: string}[]} */ list) => list.filter((p) => p.id !== prId)
  if (!got.node || got.node.state !== 'OPEN') {
    const kind = got.node?.state === 'MERGED' ? 'merged' : got.node?.state === 'CLOSED' ? 'closed' : 'gone'
    const note = `${old.repo}#${old.number} was ${kind === 'gone' ? 'not found (deleted, or hidden from your token)' : kind}; removed from the list.`
    await updateSnapshot(deps.area, (latest) => ({ ...latest, mine: /** @type {any} */ (drop(latest.mine)), toReview: /** @type {any} */ (drop(latest.toReview)), warnings: [...(latest.warnings ?? []), note] }))
    return { kind }
  }

  let fresh = analyzePR(got.node, { extraBots: settings.extraBots })
  if (skipsJenkins(fresh)) fresh.build = null
  /** @type {import('./github.js').Snapshot} */
  const one = { ...snapshot, mine: [fresh], toReview: [], warnings: [] }
  const jenkins = settings.jenkinsUser && settings.jenkinsToken ? { user: settings.jenkinsUser, token: settings.jenkinsToken } : null
  await addJenkinsBuilds(one, JENKINS_TEMPLATE, deps, jenkins)
  await addLocalSessions(one, deps)
  fresh = one.mine[0]
  if (fresh.hasHumanComments) fresh = await withClaudeAnswer(fresh, { model: settings.claudeModel }, deps)

  const viewer = got.viewer || snapshot.viewer
  const node = got.node
  await updateSnapshot(deps.area, (latest) => ({
    ...latest,
    mine: latest.mine.map((p) => (p.id === prId ? fresh : p)),
    toReview: latest.toReview.map((p) => {
      if (p.id !== prId) return p
      const requested = stillRequested(node, viewer, !!p.requested)
      return { ...fresh, requested, ...(p.watched && !requested ? { watched: true } : {}) }
    }),
  }))
  return { kind: 'ok' }
}

/**
 * The stored Claude answer for this PR, flagged outdated if the PR changed.
 *
 * @param {import('./analyze.js').PRSummary} pr
 * @param {import('./claude.js').ClaudeAuth} auth
 * @param {RefreshDeps} deps
 */
async function withClaudeAnswer(pr, auth, deps) {
  const hit = (await loadClaudeCache(deps.area))[pr.id]
  if (!hit) return pr
  const judged = applyJudgement(pr, hit.judgement)
  return hit.sig === signature(describePR(pr), auth.model) ? judged : { ...judged, aiStale: true }
}

/** Badge text: review-requested PRs still waiting. */
export function badgeFor(/** @type {import('./github.js').Snapshot | null} */ snapshot) {
  const n = snapshot?.toReview.filter((p) => p.requested).length ?? 0
  return n === 0 ? '' : n > 99 ? '99+' : String(n)
}
