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
    comments(first: 50) { nodes { id author { login __typename } body createdAt url } }
    reviews(first: 50) { nodes { id author { login __typename } state body createdAt url } }
    reviewThreads(first: 50) {
      nodes {
        id isResolved isOutdated path line resolvedBy { login }
        comments(first: 20) { nodes { id author { login __typename } body createdAt url } }
      }
    }
  }`

export const DASHBOARD_QUERY = `
  query Dashboard($mine: String!, $requested: String!, $reviewed: String!) {
    viewer { login }
    rateLimit { remaining resetAt }
    mine: search(query: $mine, type: ISSUE, first: ${PAGE}) { issueCount nodes { ...PR } }
    requested: search(query: $requested, type: ISSUE, first: ${PAGE}) { issueCount nodes { ...PR } }
    reviewed: search(query: $reviewed, type: ISSUE, first: ${PAGE}) { issueCount nodes { ...PR } }
  }
  ${PR_FIELDS}`

export const SEARCHES = {
  mine: 'is:open is:pr author:@me archived:false sort:updated-desc',
  requested: 'is:open is:pr review-requested:@me archived:false sort:updated-desc',
  reviewed: 'is:open is:pr reviewed-by:@me -author:@me archived:false sort:updated-desc',
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
 * @typedef {import('./analyze.js').PRSummary & {requested?: boolean}} ReviewPR
 * @typedef {{viewer: string, fetchedAt: string, rateRemaining: number,
 *   mine: import('./analyze.js').PRSummary[], toReview: ReviewPR[],
 *   truncated: {mine: boolean, toReview: boolean}, warnings?: string[],
 *   jenkinsChecked?: boolean, jenkinsLogin?: boolean}} Snapshot
 */

/**
 * @param {{token: string, extraBots?: string[], fetchImpl?: typeof fetch}} options
 * @returns {Promise<Snapshot>}
 */
export async function fetchDashboard({ token, extraBots = [], fetchImpl = fetch }) {
  if (!token) throw new GitHubError('No GitHub token set. Open Settings and paste one.', 'auth')
  let response
  try {
    response = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: DASHBOARD_QUERY, variables: SEARCHES }),
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
  return toSnapshot(json.data, extraBots, json.errors)
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
    if (/SAML/i.test(message)) {
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
      toReview: (data.requested?.issueCount ?? 0) > PAGE || (data.reviewed?.issueCount ?? 0) > PAGE,
    },
  }
}
