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
 *   truncated: {mine: boolean, toReview: boolean}, warnings?: string[]}} Snapshot
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
 * GitHub answers 200 with partial `data` *and* `errors` when it hides results —
 * most often an org's SAML SSO not authorised for the token, which silently
 * empties every list. Those errors must reach the user, not be dropped.
 *
 * @param {{message?: string, type?: string}[] | undefined} errors
 * @returns {string[]}
 */
export function describeErrors(errors) {
  if (!errors?.length) return []
  const messages = new Set(errors.map((e) => e.message ?? String(e.type ?? 'Unknown error')))
  return [...messages].map((m) =>
    /SAML/i.test(m)
      ? `${m} Open github.com/settings/tokens → Configure SSO → Authorize for the org, then Refresh.`
      : m,
  )
}

/**
 * @param {any} data  the `data` object of a DASHBOARD_QUERY response
 * @param {string[]} [extraBots]
 * @param {{message?: string, type?: string}[]} [errors]
 * @returns {Snapshot}
 */
export function toSnapshot(data, extraBots = [], errors = undefined) {
  /** @param {any} search @returns {any[]} */
  const prs = (search) => (search?.nodes ?? []).filter((/** @type {any} */ n) => n && n.id)
  const analyze = (/** @type {any} */ pr) => analyzePR(pr, { extraBots })

  const requestedIds = new Set(prs(data.requested).map((p) => p.id))
  /** @type {Map<string, ReviewPR>} */
  const toReview = new Map()
  for (const pr of [...prs(data.requested), ...prs(data.reviewed)]) {
    if (!toReview.has(pr.id)) toReview.set(pr.id, { ...analyze(pr), requested: requestedIds.has(pr.id) })
  }

  return {
    viewer: data.viewer?.login ?? '',
    fetchedAt: new Date().toISOString(),
    rateRemaining: data.rateLimit?.remaining ?? -1,
    mine: prs(data.mine).map(analyze),
    // Requested first: those are the ones actually waiting on me.
    toReview: [...toReview.values()].sort(
      (a, b) => Number(b.requested) - Number(a.requested) || b.updatedAt.localeCompare(a.updatedAt),
    ),
    warnings: describeErrors(errors),
    truncated: {
      mine: (data.mine?.issueCount ?? 0) > PAGE,
      toReview: (data.requested?.issueCount ?? 0) > PAGE || (data.reviewed?.issueCount ?? 0) > PAGE,
    },
  }
}
