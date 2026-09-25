/**
 * Claude as the judge of "was this comment dealt with?" and a one-line PR
 * summary. One Messages API call per PR, only when its comments, replies or
 * commits changed since the last call (the signature), so a refresh with
 * nothing new costs nothing.
 *
 * Raw fetch rather than the SDK: the extension has no build step and cannot
 * import npm packages. `fetch` is injected; nothing here touches chrome.*.
 *
 * GitHub facts stay facts: a resolved thread or code that changed under a
 * comment keeps its status; Claude decides everything the rules only guessed.
 */

import { countFindings } from './analyze.js'

export const CLAUDE_URL = 'https://api.anthropic.com/v1/messages'
export const CLAUDE_ORIGIN = 'https://api.anthropic.com'

/**
 * Why a pasted key can't work, before Anthropic says 401. Claude Code and
 * Claude.ai sign-ins (sk-ant-oat…) are subscription logins, not API keys.
 * @param {string} key
 * @returns {string | null}
 */
export function keyProblem(key) {
  if (/^sk-ant-oat/.test(key)) return "That's a Claude Code / Claude.ai sign-in token (sk-ant-oat…), not an API key. Create an API key at console.anthropic.com → API keys; it starts with sk-ant-api."
  if (/^sk-ant-admin/.test(key)) return "That's an Anthropic Admin key; it can't call Claude. Use an API key from console.anthropic.com → API keys (sk-ant-api…)."
  if (!/^sk-ant-api/.test(key)) return "That doesn't look like an Anthropic API key. They start with sk-ant-api — create one at console.anthropic.com → API keys."
  return null
}
export const CLAUDE_MODELS = /** @type {const} */ (['claude-sonnet-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-haiku-4-5'])
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5'
/** Statuses GitHub itself decided — Claude doesn't overrule them. */
const GITHUB_DECIDED = new Set(['resolved', 'outdated'])
/** A comment body longer than this is cut, with a note saying so. */
const BODY_LIMIT = 6000

/** @typedef {import('./analyze.js').PRSummary} PRSummary */
/** @typedef {'fixed' | 'unfixed' | 'no-action'} Verdict */
/** @typedef {{summary: string, verdicts: {id: string, verdict: Verdict, reason: string}[]}} Judgement */
/** @typedef {{kind: 'ok', judgement: Judgement} | {kind: 'bad-key'} | {kind: 'refused'} | {kind: 'error', message: string}} ClaudeResult */
/** @typedef {{apiKey: string, model: string}} ClaudeAuth */

const SYSTEM = `You review the state of a GitHub pull request's review comments for its author and reviewers.

For every comment you are given, decide:
- "fixed": the requested change was made or the concern was resolved. Evidence: the PR author replied that it was done, a later commit plausibly addresses it, or the reviewer confirmed.
- "unfixed": it still asks for something that has not visibly been done, or the author pushed back without agreement.
- "no-action": it asks for nothing — an approval, praise, a summary, a question already answered, an explicitly optional or non-blocking nit, or an automated review whose verdict is approve.

Judge from the thread and the commit list only; do not assume. A commit counts only if its message or timing plausibly relates to the comment. Give a short reason (one sentence, under 25 words) naming the evidence.

Also write "summary": one or two short sentences on what still blocks this PR from merging, from the comments (or "Nothing blocking in the comments." when nothing does). No preamble.`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'verdicts'],
  properties: {
    summary: { type: 'string' },
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'verdict', 'reason'],
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['fixed', 'unfixed', 'no-action'] },
          reason: { type: 'string' },
        },
      },
    },
  },
}

/** @param {string} text */
function clip(text) {
  const t = (text ?? '').trim()
  return t.length > BODY_LIMIT ? `${t.slice(0, BODY_LIMIT)}\n[… cut: ${t.length - BODY_LIMIT} more characters]` : t
}

/**
 * What Claude is shown for one PR. Also the input to the signature, so it must
 * be deterministic.
 *
 * @param {PRSummary} pr
 */
export function describePR(pr) {
  const lines = [`PR: ${pr.repo}#${pr.number} "${pr.title}" by ${pr.author}`, '', 'Commits (oldest first):']
  for (const c of pr.commits ?? []) lines.push(`- ${c.at} ${c.oid} ${c.headline}`)
  if (!pr.commits?.length) lines.push('- (none visible)')
  for (const f of pr.findings) {
    const where = f.kind === 'inline' ? ` on ${f.path}${f.line ? `:${f.line}` : ''}` : f.kind === 'review' ? ` (review${f.reviewState ? `, ${f.reviewState}` : ''})` : ''
    lines.push('', `=== Comment id=${f.id} by ${f.author}${where} at ${f.createdAt}${GITHUB_DECIDED.has(f.status) ? ` [GitHub: ${f.status}]` : ''}`, clip(f.body))
    for (const c of f.conversation ?? []) lines.push(`--- reply by ${c.author}${c.author === pr.author ? ' (PR author)' : ''} at ${c.createdAt}`, clip(c.body))
  }
  return lines.join('\n')
}

/** FNV-1a over the prompt + model: cheap, stable, good enough to spot a change. */
export function signature(/** @type {string} */ text, /** @type {string} */ model) {
  let h = 0x811c9dc5
  const s = `${model}\n${text}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/**
 * @param {string} model
 * @param {string} prompt
 */
export function requestBody(model, prompt) {
  /** @type {Record<string, unknown>} */
  const body = {
    model,
    max_tokens: 8000,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
  }
  // Classification: low effort is plenty (Opus 5.5 would otherwise default to medium). Haiku 4.5 has no effort setting.
  if (model !== 'claude-haiku-4-5') /** @type {any} */ (body.output_config).effort = 'low'
  // Opus 5's safety classifiers can decline; let the API re-run on its recommended fallback.
  if (model === 'claude-opus-5') body.fallbacks = 'default'
  return body
}

/**
 * @param {PRSummary} pr
 * @param {ClaudeAuth} auth
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<ClaudeResult>}
 */
export async function judgePR(pr, auth, fetchImpl) {
  const headers = /** @type {Record<string, string>} */ ({
    'content-type': 'application/json',
    'x-api-key': auth.apiKey,
    'anthropic-version': '2023-06-01',
    // Required for calls straight from a browser page (CORS).
    'anthropic-dangerous-direct-browser-access': 'true',
  })
  if (auth.model === 'claude-opus-5') headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'
  let response
  try {
    response = await fetchImpl(CLAUDE_URL, { method: 'POST', headers, body: JSON.stringify(requestBody(auth.model, describePR(pr))) })
  } catch (error) {
    return { kind: 'error', message: `Network error: ${String(error)}` }
  }
  if (response.status === 401 || response.status === 403) return { kind: 'bad-key' }
  const json = await response.json().catch(() => null)
  if (!response.ok) {
    const message = json?.error?.message ?? response.statusText
    const hint = response.status === 429 ? ' (rate limited)' : response.status === 529 ? ' (overloaded)' : ''
    return { kind: 'error', message: `Claude API ${response.status}${hint}: ${message}` }
  }
  if (json?.stop_reason === 'refusal') return { kind: 'refused' }
  if (json?.stop_reason === 'max_tokens') return { kind: 'error', message: 'Claude ran out of output tokens' }
  const text = (json?.content ?? []).filter((/** @type {any} */ b) => b.type === 'text').map((/** @type {any} */ b) => b.text).join('')
  try {
    return { kind: 'ok', judgement: parseJudgement(JSON.parse(text)) }
  } catch {
    return { kind: 'error', message: 'Claude returned something that is not the expected JSON' }
  }
}

/** @param {any} raw @returns {Judgement} */
export function parseJudgement(raw) {
  if (!raw || typeof raw.summary !== 'string' || !Array.isArray(raw.verdicts)) throw new Error('bad judgement')
  return {
    summary: raw.summary.trim(),
    verdicts: raw.verdicts
      .filter((/** @type {any} */ v) => v && typeof v.id === 'string' && ['fixed', 'unfixed', 'no-action'].includes(v.verdict))
      .map((/** @type {any} */ v) => ({ id: v.id, verdict: v.verdict, reason: String(v.reason ?? '').trim() })),
  }
}

/**
 * Layer Claude's verdicts over the rules' guess. Returns a new PR.
 *
 * @template {PRSummary} P
 * @param {P} pr
 * @param {Judgement} judgement
 * @returns {P}
 */
export function applyJudgement(pr, judgement) {
  const byId = new Map(judgement.verdicts.map((v) => [v.id, v]))
  const findings = pr.findings.map((f) => {
    const v = byId.get(f.id)
    if (!v || GITHUB_DECIDED.has(f.status)) return f
    const evidence = `Claude: ${v.reason || v.verdict}`
    if (v.verdict === 'fixed') return { ...f, status: /** @type {const} */ ('ai-fixed'), fixed: true, noAction: false, evidence, judgedBy: /** @type {const} */ ('claude') }
    if (v.verdict === 'no-action') return { ...f, status: /** @type {const} */ ('ai-no-action'), fixed: false, noAction: true, evidence, judgedBy: /** @type {const} */ ('claude') }
    // Unfixed: keep the rules' more specific label when it already says unfixed.
    const status = f.fixed || f.noAction ? /** @type {const} */ ('ai-unfixed') : f.status
    return { ...f, status, fixed: false, noAction: false, evidence, judgedBy: /** @type {const} */ ('claude') }
  })
  return { ...pr, findings, counts: countFindings(findings), aiSummary: judgement.summary }
}
