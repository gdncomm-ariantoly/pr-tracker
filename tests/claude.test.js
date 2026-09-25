import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { applyJudgement, describePR, judgePR, parseJudgement, requestBody, signature } from '../lib/claude.js'
import { addClaudeJudgements } from '../lib/refresh.js'
import { applyOverrides } from '../lib/overrides.js'

/** @param {Partial<import('../lib/analyze.js').Finding>} over @returns {import('../lib/analyze.js').Finding} */
const finding = (over) => ({
  id: 'F1', kind: 'inline', author: 'bob', body: 'rename this', createdAt: '2026-01-01T01:00:00Z', url: 'https://github.com/o/r/pull/1#f1',
  path: 'A.java', line: 1, replies: 0, status: 'open', fixed: false, noAction: false, evidence: 'No reply.', lastReviewerAt: '2026-01-01T01:00:00Z', lastReviewer: 'bob',
  ...over,
})
/** @param {Partial<import('../lib/analyze.js').PRSummary>} over @returns {import('../lib/analyze.js').PRSummary} */
const pr = (over) => ({
  id: 'P1', repo: 'o/api', number: 1, title: 'Add cache', url: 'https://github.com/o/api/pull/1', author: 'me', isDraft: false,
  updatedAt: '2026-01-02T00:00:00Z', reviewDecision: null, hasHumanComments: true, findings: [finding({})],
  counts: { total: 1, fixed: 0, noAction: 0, pending: 1 }, commits: [{ oid: 'abc1234', at: '2026-01-01T02:00:00Z', headline: 'Rename to cacheKey' }], ...over,
})
/** @param {unknown} body @param {number} [status] */
const reply = (body, status = 200) => /** @type {typeof fetch} */ (async () => new Response(JSON.stringify(body), { status }))
/** @param {object} judgement */
const answer = (judgement) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(judgement) }] })

describe('describePR', () => {
  it('shows Claude the comments, replies and commits, and cuts huge bodies visibly', () => {
    const text = describePR(pr({ findings: [finding({ body: 'x'.repeat(7000), conversation: [{ author: 'me', body: 'done', createdAt: '2026-01-01T03:00:00Z', url: 'u' }] })] }))
    assert.match(text, /Comment id=F1 by bob on A\.java:1/)
    assert.match(text, /reply by me \(PR author\)/)
    assert.match(text, /abc1234 Rename to cacheKey/)
    assert.match(text, /\[… cut: 1000 more characters\]/)
  })

  it('signature changes with the content or the model', () => {
    const a = describePR(pr({}))
    assert.equal(signature(a, 'm'), signature(a, 'm'))
    assert.notEqual(signature(a, 'm'), signature(a, 'n'))
    assert.notEqual(signature(a, 'm'), signature(describePR(pr({ commits: [] })), 'm'))
  })
})

describe('requestBody', () => {
  it('asks for schema-shaped JSON; low effort and fallbacks only where the model supports them', () => {
    const opus = /** @type {any} */ (requestBody('claude-opus-5', 'p'))
    assert.equal(opus.output_config.format.type, 'json_schema')
    assert.equal(opus.output_config.effort, 'low')
    assert.equal(opus.fallbacks, 'default')
    const haiku = /** @type {any} */ (requestBody('claude-haiku-4-5', 'p'))
    assert.equal(haiku.output_config.effort, undefined)
    assert.equal(haiku.fallbacks, undefined)
  })
})

describe('judgePR', () => {
  const auth = { apiKey: 'k', model: 'claude-opus-5' }
  it('sends the key, the browser-access header and the fallback beta', async () => {
    /** @type {any} */ let seen
    const f = /** @type {typeof fetch} */ (async (_url, init) => ((seen = init), new Response(JSON.stringify(answer({ summary: 's', verdicts: [] })))))
    const r = await judgePR(pr({}), auth, f)
    assert.equal(r.kind, 'ok')
    assert.equal(seen.headers['x-api-key'], 'k')
    assert.equal(seen.headers['anthropic-dangerous-direct-browser-access'], 'true')
    assert.equal(seen.headers['anthropic-beta'], 'server-side-fallback-2026-07-01')
  })

  it('maps failures: bad key, refusal, API error, junk output', async () => {
    assert.deepEqual(await judgePR(pr({}), auth, reply({}, 401)), { kind: 'bad-key' })
    assert.deepEqual(await judgePR(pr({}), auth, reply({ stop_reason: 'refusal', content: [] })), { kind: 'refused' })
    const busy = await judgePR(pr({}), auth, reply({ error: { message: 'Overloaded' } }, 529))
    assert.equal(busy.kind, 'error')
    assert.match(/** @type {any} */ (busy).message, /529 \(overloaded\)/)
    assert.equal((await judgePR(pr({}), auth, reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'nope' }] }))).kind, 'error')
  })

  it('drops verdicts it cannot use', () => {
    const j = parseJudgement({ summary: ' s ', verdicts: [{ id: 'A', verdict: 'fixed', reason: 'r' }, { id: 'B', verdict: 'maybe' }, null] })
    assert.deepEqual(j, { summary: 's', verdicts: [{ id: 'A', verdict: 'fixed', reason: 'r' }] })
  })
})

describe('applyJudgement', () => {
  it("overrules the rules' guess but never GitHub's facts", () => {
    const p = pr({
      findings: [
        finding({ id: 'open' }),
        finding({ id: 'said-done', status: 'fixed-reply', fixed: true }),
        finding({ id: 'resolved', status: 'resolved', fixed: true }),
        finding({ id: 'praise', status: 'replied' }),
      ],
    })
    const out = applyJudgement(p, {
      summary: 'One rename left.',
      verdicts: [
        { id: 'open', verdict: 'fixed', reason: 'Commit abc1234 renames it.' },
        { id: 'said-done', verdict: 'unfixed', reason: 'The reply says done but nothing changed.' },
        { id: 'resolved', verdict: 'unfixed', reason: 'x' },
        { id: 'praise', verdict: 'no-action', reason: 'Just praise.' },
      ],
    })
    const by = Object.fromEntries(out.findings.map((f) => [f.id, f]))
    assert.equal(by.open.status, 'ai-fixed')
    assert.equal(by.open.evidence, 'Claude: Commit abc1234 renames it.')
    assert.equal(by['said-done'].status, 'ai-unfixed')
    assert.equal(by.resolved.status, 'resolved', 'a resolved thread stays resolved')
    assert.equal(by.praise.status, 'ai-no-action')
    assert.deepEqual(out.counts, { total: 4, fixed: 2, noAction: 1, pending: 1 })
    assert.equal(out.aiSummary, 'One rename left.')
  })

  it('still lets me mark a Claude-unfixed comment as No action needed', () => {
    const judged = applyJudgement(pr({}), { summary: 's', verdicts: [{ id: 'F1', verdict: 'unfixed', reason: 'r' }] })
    const snap = /** @type {any} */ ({ mine: [judged], toReview: [] })
    const marked = applyOverrides(snap, { F1: true }).mine[0]
    assert.equal(marked.findings[0].status, 'no-action')
    assert.equal(marked.counts.pending, 0)
  })
})

describe('addClaudeJudgements', () => {
  const auth = { apiKey: 'k', model: 'claude-opus-5' }
  const memory = () => {
    /** @type {Record<string, unknown>} */ const data = {}
    return { data, get: async (/** @type {string} */ k) => ({ [k]: data[k] }), set: async (/** @type {Record<string, unknown>} */ o) => void Object.assign(data, o) }
  }

  it('asks once, then reuses the answer until something changes', async () => {
    let calls = 0
    const f = /** @type {typeof fetch} */ (async () => (calls++, new Response(JSON.stringify(answer({ summary: 'Nothing blocking.', verdicts: [{ id: 'F1', verdict: 'fixed', reason: 'r' }] })))))
    const area = memory()
    const deps = { area, claudeFetch: f, claudeAllowed: async () => true }
    const both = pr({})
    const snap = /** @type {any} */ ({ mine: [both, pr({ id: 'quiet', hasHumanComments: false, findings: [] })], toReview: [{ ...both }], warnings: [] })
    await addClaudeJudgements(snap, auth, deps)
    assert.equal(calls, 1, 'once for a PR in both lists; none for a PR without comments')
    assert.equal(snap.mine[0].findings[0].status, 'ai-fixed')
    assert.equal(snap.toReview[0].aiSummary, 'Nothing blocking.')

    await addClaudeJudgements(/** @type {any} */ ({ mine: [pr({})], toReview: [] }), auth, deps)
    assert.equal(calls, 1, 'unchanged PR: cached')
    await addClaudeJudgements(/** @type {any} */ ({ mine: [pr({ commits: [] })], toReview: [] }), auth, deps)
    assert.equal(calls, 2, 'changed PR: asked again')
  })

  it('does nothing until Chrome grants access, and flags a bad key', async () => {
    const none = /** @type {any} */ ({ mine: [pr({})], toReview: [] })
    await addClaudeJudgements(none, auth, { area: memory(), claudeFetch: reply({}, 500), claudeAllowed: async () => false })
    assert.deepEqual(none.claude, { state: 'no-access' })
    assert.equal(none.mine[0].findings[0].status, 'open')

    const bad = /** @type {any} */ ({ mine: [pr({})], toReview: [] })
    await addClaudeJudgements(bad, auth, { area: memory(), claudeFetch: reply({}, 401), claudeAllowed: async () => true })
    assert.equal(bad.claude.state, 'bad-key')
    assert.equal(bad.mine[0].findings[0].status, 'open', "the rules' guess stays")
  })
})
