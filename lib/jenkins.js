/**
 * Build status straight from Jenkins, for PRs whose build GitHub won't show
 * the token. Two ways in:
 *
 *   API token   user + token as HTTP Basic. Works without a browser session
 *               (background refreshes, SSO that expires). 401 → bad token.
 *   session     no token: the request carries the user's own Jenkins cookie
 *               (the extension holds a host permission). 403 → not signed in.
 *
 * `fetch` is injected; nothing here touches chrome.*.
 */

/** @typedef {import('./analyze.js').Build} Build */
/** @typedef {{kind: 'build', build: Build} | {kind: 'login'} | {kind: 'bad-token'} | {kind: 'none'} | {kind: 'error', message: string}} JenkinsResult */
/** @typedef {{user: string, token: string}} JenkinsAuth */

const TREE = 'number,result,building,inProgress,url,timestamp,duration'

/** @param {unknown} json @param {string} jobUrl @returns {Build | null} */
export function parseLastBuild(json, jobUrl) {
  if (!json || typeof json !== 'object') return null
  const b = /** @type {Record<string, unknown>} */ (json)
  const number = typeof b.number === 'number' ? b.number : null
  const building = b.building === true || b.inProgress === true
  /** @type {import('./analyze.js').BuildState} */
  let state
  if (building) state = 'running'
  else if (b.result === 'SUCCESS') state = 'success'
  else if (b.result === 'FAILURE' || b.result === 'UNSTABLE') state = 'failure'
  else if (b.result === 'ABORTED') state = 'cancelled'
  else if (b.result === 'NOT_BUILT') state = 'skipped'
  else state = 'pending'
  const started = typeof b.timestamp === 'number' ? b.timestamp : null
  const duration = typeof b.duration === 'number' && b.duration > 0 ? b.duration : 0
  return {
    state,
    url: typeof b.url === 'string' && /^https:\/\//.test(b.url) ? b.url : jobUrl,
    name: b.result === 'UNSTABLE' ? 'Jenkins (unstable)' : 'Jenkins',
    number,
    at: started ? new Date(started + duration).toISOString() : null,
  }
}

/** @param {JenkinsAuth} auth */
export function basicAuth(auth) {
  const bytes = new TextEncoder().encode(`${auth.user}:${auth.token}`)
  return `Basic ${btoa(String.fromCharCode(...bytes))}`
}

/**
 * @param {string} jobUrl  the PR's job page, ending in "/"
 * @param {typeof fetch} [fetchImpl]
 * @param {JenkinsAuth | null} [auth]
 * @returns {Promise<JenkinsResult>}
 */
export async function fetchJenkinsBuild(jobUrl, fetchImpl = fetch, auth = null) {
  const base = jobUrl.endsWith('/') ? jobUrl : `${jobUrl}/`
  /** @type {Record<string, string>} */
  const headers = { Accept: 'application/json' }
  if (auth) headers.Authorization = basicAuth(auth)
  let response
  try {
    response = await fetchImpl(`${base}lastBuild/api/json?tree=${TREE}`, {
      // With a token, leave the session out so the answer reflects the token alone.
      credentials: auth ? 'omit' : 'include',
      headers,
      redirect: 'manual',
    })
  } catch (error) {
    return { kind: 'error', message: String(error) }
  }
  if (auth && response.status === 401) return { kind: 'bad-token' }
  // Jenkins answers anonymous users 403 (and SSO setups may redirect to login).
  if (response.status === 401 || response.status === 403 || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    return auth ? { kind: 'error', message: `Jenkins refused the token (${response.status || 'redirect'})` } : { kind: 'login' }
  }
  if (response.status === 404) return { kind: 'none' } // no such job, or never built
  if (!response.ok) return { kind: 'error', message: `Jenkins ${response.status}` }
  const json = await response.json().catch(() => null)
  const build = parseLastBuild(json, base)
  return build ? { kind: 'build', build } : { kind: 'error', message: 'Unexpected Jenkins response' }
}

/**
 * Run `task` over `items` with at most `limit` in flight — a dashboard of 30
 * PRs should not open 30 connections to Jenkins at once.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} task
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, task) {
  /** @type {R[]} */
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await task(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
