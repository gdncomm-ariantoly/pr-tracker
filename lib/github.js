/**
 * GitHub GraphQL client. `fetch` is injected so tests (and the verify harness)
 * can run it without the network.
 */

import { analyzePR } from './analyze.js'

export const API_URL = 'https://api.github.com/graphql'
const PAGE = 30

const PR_FIELDS = `
  fragment PR on PullRequest {
    id number title url isDraft createdAt updatedAt reviewDecision
    reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug name } ... on Mannequin { login } } } }
    latestOpinionatedReviews(first: 20, writersOnly: true) { nodes { state author { login __typename } } }
    author { login __typename }
    repository { nameWithOwner }
    commits(last: 50) { nodes { commit { oid committedDate messageHeadline } } }
    head: commits(last: 1) {
      nodes {
        commit {
          statusCheckRollup {
            contexts(first: 25) {
              nodes {
                __typename
                ... on CheckRun { name status conclusion detailsUrl startedAt completedAt }
                ... on StatusContext { context state targetUrl createdAt }
              }
            }
          }
        }
      }
    }
    comments(first: 50) { nodes { id author { login __typename avatarUrl(size: 48) } body bodyHTML createdAt url } }
    reviews(first: 50) { nodes { id author { login __typename avatarUrl(size: 48) } state body bodyHTML createdAt url } }
    reviewThreads(first: 50) {
      nodes {
        id isResolved isOutdated path line resolvedBy { login }
        comments(first: 20) { nodes { id author { login __typename avatarUrl(size: 48) } body bodyHTML createdAt url } }
      }
    }
  }`

export const DASHBOARD_QUERY = `
  query Dashboard($mine: String!, $requested: String!, $reviewed: String!, $watched: String!, $hasWatched: Boolean!) {
    viewer { login }
    rateLimit { remaining resetAt }
    mine: search(query: $mine, type: ISSUE, first: ${PAGE}) { issueCount nodes { ...PR } }
    requested: search(query: $requested, type: ISSUE, first: ${PAGE}) { issueCount nodes { ...PR } }
    reviewed: search(query: $reviewed, type: ISSUE, first: ${PAGE}) { issueCount nodes { ...PR } }
    watched: search(query: $watched, type: ISSUE, first: ${PAGE}) @include(if: $hasWatched) { issueCount nodes { ...PR } }
  }
  ${PR_FIELDS}`

/**
 * The query for one list, keeping the list's alias so responses (and
 * fixtures captured with DASHBOARD_QUERY) look the same.
 *
 * @param {string} alias
 */
export function listQuery(alias) {
  return `
  query List($${alias}: String!) {
    viewer { login }
    rateLimit { remaining resetAt }
    ${alias}: search(query: $${alias}, type: ISSUE, first: ${PAGE}) { issueCount nodes { ...PR } }
  }
  ${PR_FIELDS}`
}

/** One PR by node id, for a card's own Refresh. `state` says whether it's still open. */
export const PR_QUERY = `
  query One($id: ID!) {
    viewer { login }
    rateLimit { remaining resetAt }
    node(id: $id) { ... on PullRequest { state ...PR } }
  }
  ${PR_FIELDS}`

export const SEARCHES = {
  mine: 'is:open is:pr author:@me archived:false sort:updated-desc',
  requested: 'is:open is:pr review-requested:@me archived:false sort:updated-desc',
  reviewed: 'is:open is:pr reviewed-by:@me -author:@me archived:false sort:updated-desc',
}

/**
 * Open PRs in the watched repositories that I didn't write — shown even when
 * nobody added me as a reviewer. Drafts are left out: not ready for review.
 *
 * @param {string[]} repos  "owner/name"
 */
export function watchedSearch(repos) {
  return `is:open is:pr draft:false -author:@me archived:false sort:updated-desc ${repos.map((r) => `repo:${r}`).join(' ')}`
}

/** Prefix of the warning about hidden build status — the page drops it when it can link to Jenkins anyway. */
export const JENKINS_HIDDEN = 'Jenkins build status is hidden from your token.'

export class GitHubError extends Error {
  /** @param {string} message @param {'auth' | 'network' | 'api'} kind */
  constructor(message, kind) {
    super(message)
    this.kind = kind
  }
}

/**
 * @typedef {import('./analyze.js').PRSummary & {requested?: boolean, watched?: boolean}} ReviewPR
 * @typedef {{viewer: string, fetchedAt: string, rateRemaining: number,
 *   mine: import('./analyze.js').PRSummary[], toReview: ReviewPR[],
 *   truncated: {mine: boolean, toReview: boolean}, warnings?: string[],
 *   jenkinsChecked?: boolean, jenkinsBadToken?: boolean, watchedRepos?: string[],
 *   claude?: {state: 'ok' | 'no-helper', judged?: number, pending?: number},
 *   claudeCode?: {state: 'ok' | 'error', message?: string}}} Snapshot
 */

/**
 * @param {{token: string, extraBots?: string[], watchedRepos?: string[], fetchImpl?: typeof fetch, retryDelays?: number[]}} options
 * @returns {Promise<Snapshot>}
 */
export async function fetchDashboard({ token, extraBots = [], watchedRepos = [], fetchImpl = fetch, retryDelays = RETRY_DELAYS }) {
  if (!token) throw new GitHubError('No GitHub token set. Open Settings and paste one.', 'auth')
  /** @type {[string, string][]} */
  const lists = [
    ['mine', SEARCHES.mine],
    ['requested', SEARCHES.requested],
    ['reviewed', SEARCHES.reviewed],
    ...(watchedRepos.length ? /** @type {[string, string][]} */ ([['watched', watchedSearch(watchedRepos)]]) : []),
  ]
  // One request per list, in parallel: the lists together are too heavy for
  // one GraphQL request (GitHub answers 504 when a query runs too long).
  const results = await Promise.all(lists.map(([alias, q]) => fetchList(alias, q, token, fetchImpl, retryDelays).then((r) => ({ alias, ...r }), (error) => ({ alias, error }))))
  const auth = results.find((r) => 'error' in r && r.error instanceof GitHubError && r.error.kind === 'auth')
  if (auth && 'error' in auth) throw auth.error
  const failed = results.filter((r) => 'error' in r)
  if (failed.length === results.length) throw /** @type {any} */ (failed[0]).error

  /** @type {any} */
  const data = {}
  /** @type {any[]} */
  const errors = []
  for (const r of results) {
    if ('error' in r) continue
    data.viewer ??= r.data.viewer
    data.rateLimit = r.data.rateLimit ?? data.rateLimit
    data[r.alias] = r.data[r.alias]
    errors.push(...(r.errors ?? []))
  }
  const snapshot = toSnapshot(data, extraBots, errors)
  const names = { mine: 'My PRs', requested: 'review requests', reviewed: 'PRs you reviewed', watched: 'watched repos' }
  for (const r of failed) {
    const why = r.error instanceof Error ? r.error.message : String(r.error)
    snapshot.warnings = [...(snapshot.warnings ?? []), `Couldn't load ${names[/** @type {keyof typeof names} */ (r.alias)]} this time (${why}); the rest is shown. Refresh to retry.`]
  }
  return { ...snapshot, watchedRepos }
}

/** Waits before each retry of a request GitHub timed out on. */
export const RETRY_DELAYS = [1000, 3000]

/**
 * One search, retried on GitHub's transient failures (502/503/504, network).
 *
 * @param {string} alias  mine | requested | reviewed | watched
 * @param {string} q
 * @param {string} token
 * @param {typeof fetch} fetchImpl
 * @param {number[]} retryDelays
 * @returns {Promise<{data: any, errors?: any[]}>}
 */
async function fetchList(alias, q, token, fetchImpl, retryDelays) {
  return withRetry(() => post(listQuery(alias), { [alias]: q }, token, fetchImpl), retryDelays)
}

/**
 * Fetch one PR fresh. node is null when it's gone or hidden from the token.
 *
 * @param {{token: string, id: string, fetchImpl?: typeof fetch, retryDelays?: number[]}} options
 * @returns {Promise<{viewer: string, node: any, errors?: any[]}>}
 */
export async function fetchPR({ token, id, fetchImpl = fetch, retryDelays = RETRY_DELAYS }) {
  if (!token) throw new GitHubError('No GitHub token set. Open Settings and paste one.', 'auth')
  const { data, errors } = await withRetry(() => post(PR_QUERY, { id }, token, fetchImpl), retryDelays)
  return { viewer: data?.viewer?.login ?? '', node: data?.node?.id ? data.node : null, errors }
}

/**
 * Retry GitHub timeouts and network errors, waiting retryDelays between tries.
 * @template T
 * @param {() => Promise<T>} run
 * @param {number[]} retryDelays
 * @returns {Promise<T>}
 */
async function withRetry(run, retryDelays) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      const transient = error instanceof GitHubError && (error.kind === 'network' || /^GitHub API error 50[234]\b/.test(error.message))
      if (!transient || attempt >= retryDelays.length) throw error
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]))
    }
  }
}

/** @param {string} query @param {Record<string, unknown>} variables @param {string} token @param {typeof fetch} fetchImpl */
async function post(query, variables, token, fetchImpl) {
  let response
  try {
    response = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
  } catch (error) {
    throw new GitHubError(`Network error: ${String(error)}`, 'network')
  }
  if (response.status === 401) throw new GitHubError('GitHub rejected the token (401). Check it has not expired.', 'auth')
  const json = await response.json().catch(() => null)
  if (!response.ok || !json) {
    throw new GitHubError(`GitHub API error ${response.status}: ${json?.message ?? response.statusText}`, 'api')
  }
  if (json.errors?.length && !json.data) {
    throw new GitHubError(json.errors.map((/** @type {{message: string}} */ e) => e.message).join('; '), 'api')
  }
  return { data: json.data, errors: json.errors }
}

/**
 * GitHub answers 200 with partial `data` *and* `errors` when it hides results.
 * Those must reach the user, not be dropped — but as something they can act
 * on, so each error's `path` says *what* was hidden:
 *
 *   ["reviewed","nodes",3]            a whole PR, from a repo the token cannot see
 *   [...,"commits"]                   commit history — needs Contents: Read
 *   [...,"reviews" | "reviewThreads" | "comments"]  needs Pull requests: Read
 *
 * @param {{message?: string, type?: string, path?: (string | number)[]}[] | undefined} errors
 * @returns {string[]}
 */
export function describeErrors(errors) {
  if (!errors?.length) return []
  /** @type {string[]} */
  const out = []
  let hiddenPRs = 0
  let jenkinsHidden = false
  const missing = new Set()
  const other = new Set()

  for (const e of errors) {
    const message = e.message ?? String(e.type ?? 'Unknown error')
    const path = (e.path ?? []).map(String)
    if (path.includes('reviewRequests')) {
      // A requested team hidden from a fine-grained token: shown as "a team" on the card.
      continue
    } else if (/SAML/i.test(message)) {
      other.add(`${message} This is a classic token without SSO: use a fine-grained token with Resource owner gdncomm, or Configure SSO → Authorize on the classic token.`)
    } else if (/not accessible by (personal access|fine-grained|integration)/i.test(message)) {
      if (path.length === 3 && path[1] === 'nodes') hiddenPRs += 1
      else if (path.includes('statusCheckRollup') || path.includes('head')) jenkinsHidden = true
      else if (path.includes('commits')) missing.add('Contents: Read-only')
      else if (path.some((p) => p === 'reviews' || p === 'reviewThreads' || p === 'comments')) missing.add('Pull requests: Read-only')
      else other.add(`${message}${path.length ? ` (at ${path.join('.')})` : ''}. On github.com/settings/personal-access-tokens check: not pending approval, Resource owner gdncomm, All repositories, Pull requests + Contents + Commit statuses Read-only.`)
    } else {
      other.add(message)
    }
  }

  if (jenkinsHidden) {
    out.push(`${JENKINS_HIDDEN} Give the token Commit statuses: Read-only. If it already has it, GitHub is hiding Jenkins check runs from fine-grained tokens; the Jenkins link still works. Comments are unaffected.`)
  }
  if (missing.size) {
    out.push(`Your token is missing ${[...missing].join(' and ')}, so fixed/unfixed can only be judged partly. Add it on github.com/settings/personal-access-tokens (edit the token, no need to recreate), then Refresh.`)
  }
  if (hiddenPRs) {
    out.push(`${hiddenPRs} PR${hiddenPRs === 1 ? ' is' : 's are'} in repositories your token doesn't cover (outside gdncomm, or not in its repository list) and ${hiddenPRs === 1 ? 'was' : 'were'} skipped. Expected with a gdncomm-only token.`)
  }
  return [...out, ...other]
}

/**
 * @param {any} data  the `data` object of a DASHBOARD_QUERY response
 * @param {string[]} [extraBots]
 * @param {{message?: string, type?: string, path?: (string | number)[]}[]} [errors]
 * @returns {Snapshot}
 */
export function toSnapshot(data, extraBots = [], errors = undefined) {
  /** @param {any} search @returns {any[]} */
  const prs = (search) => (search?.nodes ?? []).filter((/** @type {any} */ n) => n && n.id)
  /** @type {string[]} */
  const failures = []
  // One odd PR must not blank the whole dashboard: show it without comment
  // analysis and say which one it was.
  const analyze = (/** @type {any} */ pr) => {
    try {
      return analyzePR(pr, { extraBots })
    } catch (error) {
      failures.push(`Could not read comments on ${pr.repository?.nameWithOwner ?? '?'}#${pr.number}: ${error instanceof Error ? error.message : String(error)}`)
      return analyzePR({ ...pr, commits: null, comments: null, reviews: null, reviewThreads: null }, { extraBots })
    }
  }

  const requestedIds = new Set(prs(data.requested).map((p) => p.id))
  /** @type {Map<string, ReviewPR>} */
  const toReview = new Map()
  for (const pr of [...prs(data.requested), ...prs(data.reviewed)]) {
    if (!toReview.has(pr.id)) toReview.set(pr.id, { ...analyze(pr), requested: requestedIds.has(pr.id) })
  }
  // Watched repos: only PRs I'm not already on; "watched" means "not asked".
  for (const pr of prs(data.watched)) {
    if (!toReview.has(pr.id)) toReview.set(pr.id, { ...analyze(pr), requested: false, watched: true })
  }

  const mine = prs(data.mine).map(analyze)
  return {
    viewer: data.viewer?.login ?? '',
    fetchedAt: new Date().toISOString(),
    rateRemaining: data.rateLimit?.remaining ?? -1,
    mine,
    // Requested first: those are the ones actually waiting on me.
    toReview: [...toReview.values()].sort(
      (a, b) => Number(b.requested) - Number(a.requested) || b.updatedAt.localeCompare(a.updatedAt),
    ),
    warnings: [...describeErrors(errors), ...failures],
    truncated: {
      mine: (data.mine?.issueCount ?? 0) > PAGE,
      toReview: (data.requested?.issueCount ?? 0) > PAGE || (data.reviewed?.issueCount ?? 0) > PAGE || (data.watched?.issueCount ?? 0) > PAGE,
    },
  }
}
