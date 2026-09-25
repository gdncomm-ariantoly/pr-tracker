import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { applyJudgement, describePR, judgePRLocal, parseJudgement, signature } from '../lib/claude.js'
import { addClaudeJudgements, judgeOnePR } from '../lib/refresh.js'
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
/** A stand-in for the Claude Code helper: counts runs, answers with `judgement`. @param {any} judgement */
const helper = (judgement, allowed = true) => {
  const runs = /** @type {any[]} */ ([])
  return { runs, allowed: async () => allowed, ask: async (/** @type {any} */ r) => (runs.push(r), typeof judgement === 'function' ? judgement(r) : { ok: true, output: judgement }) }
}

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

describe('judgePRLocal', () => {
  it('sends the prompt, system, schema and model to the helper', async () => {
    const h = helper({ summary: 's', verdicts: [] })
    assert.equal((await judgePRLocal(pr({}), 'claude-opus-5-5', h.ask)).kind, 'ok')
    assert.equal(h.runs[0].type, 'judge')
    assert.equal(h.runs[0].model, 'claude-opus-5-5')
    assert.match(h.runs[0].prompt, /Comment id=F1/)
    assert.equal(h.runs[0].schema.type, 'object')
  })

  it('maps failures: helper error, junk output, no helper', async () => {
    assert.deepEqual(await judgePRLocal(pr({}), 'm', helper(() => ({ ok: false, error: 'Not logged in' })).ask), { kind: 'error', message: 'Claude Code: Not logged in' })
    assert.equal((await judgePRLocal(pr({}), 'm', helper({ nope: 1 }).ask)).kind, 'error')
    const down = await judgePRLocal(pr({}), 'm', async () => { throw new Error('Specified native messaging host not found.') })
    assert.match(/** @type {any} */ (down).message, /helper didn't answer: Specified native messaging host not found/)
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
  const auth = { model: 'claude-sonnet-5' }
  const memory = () => {
    /** @type {Record<string, unknown>} */ const data = {}
    return { data, get: async (/** @type {string} */ k) => ({ [k]: data[k] }), set: async (/** @type {Record<string, unknown>} */ o) => void Object.assign(data, o) }
  }

  it('asks once, then reuses the answer until something changes', async () => {
    const h = helper({ summary: 'Nothing blocking.', verdicts: [{ id: 'F1', verdict: 'fixed', reason: 'r' }] })
    const area = memory()
    const deps = { area, claudeCode: h }
    const both = pr({})
    const snap = /** @type {any} */ ({ mine: [both, pr({ id: 'quiet', hasHumanComments: false, findings: [] })], toReview: [{ ...both }], warnings: [] })
    await addClaudeJudgements(snap, auth, deps)
    assert.equal(h.runs.length, 1, 'once for a PR in both lists; none for a PR without comments')
    assert.equal(snap.mine[0].findings[0].status, 'ai-fixed')
    assert.equal(snap.toReview[0].aiSummary, 'Nothing blocking.')

    await addClaudeJudgements(/** @type {any} */ ({ mine: [pr({})], toReview: [] }), auth, deps)
    assert.equal(h.runs.length, 1, 'unchanged PR: cached')
    await addClaudeJudgements(/** @type {any} */ ({ mine: [pr({ commits: [] })], toReview: [] }), auth, deps)
    assert.equal(h.runs.length, 2, 'changed PR: asked again')
  })

  it('does nothing without the helper; a failed run keeps the rules and says why', async () => {
    const none = /** @type {any} */ ({ mine: [pr({})], toReview: [] })
    await addClaudeJudgements(none, auth, { area: memory(), claudeCode: helper({}, false) })
    assert.deepEqual(none.claude, { state: 'no-helper' })
    assert.equal(none.mine[0].findings[0].status, 'open')

    const bad = /** @type {any} */ ({ mine: [pr({})], toReview: [], warnings: [] })
    await addClaudeJudgements(bad, auth, { area: memory(), claudeCode: helper(() => ({ ok: false, error: 'Not logged in' })) })
    assert.equal(bad.mine[0].findings[0].status, 'open', "the rules' guess stays")
    assert.match(bad.warnings[0], /Claude couldn't judge 1 PR.*Not logged in/)
  })

  it('manual mode: never calls, reuses answers, flags them outdated when the PR changed', async () => {
    const h = helper({ summary: 'S', verdicts: [{ id: 'F1', verdict: 'fixed', reason: 'r' }] })
    const area = memory()
    const deps = { area, claudeCode: h }
    const fresh = /** @type {any} */ ({ mine: [pr({})], toReview: [] })
    await addClaudeJudgements(fresh, auth, deps, false)
    assert.equal(h.runs.length, 0)
    assert.equal(fresh.mine[0].aiSummary, undefined)

    // The card's Summarize button asks for that one PR.
    await area.set({ snapshot: fresh, settings: { claudeModel: 'claude-sonnet-5' } })
    assert.deepEqual(await judgeOnePR('P1', deps), { kind: 'ok' })
    assert.equal(h.runs.length, 1)
    const saved = /** @type {any} */ (area.data.snapshot)
    assert.equal(saved.mine[0].aiSummary, 'S')
    assert.equal(saved.mine[0].findings[0].status, 'ai-fixed')

    const same = /** @type {any} */ ({ mine: [pr({})], toReview: [] })
    await addClaudeJudgements(same, auth, deps, false)
    assert.equal(same.mine[0].aiSummary, 'S', 'the answer is reused on the next refresh')
    assert.equal(same.mine[0].aiStale, undefined)
    const changed = /** @type {any} */ ({ mine: [pr({ commits: [] })], toReview: [] })
    await addClaudeJudgements(changed, auth, deps, false)
    assert.equal(h.runs.length, 1)
    assert.equal(changed.mine[0].aiStale, true, 'kept, but marked outdated')
  })

  it('Summarize says what is wrong: no helper, or Claude Code failing', async () => {
    const area = memory()
    await area.set({ snapshot: { mine: [pr({})], toReview: [] }, settings: {} })
    assert.deepEqual(await judgeOnePR('P1', { area, claudeCode: helper({}, false) }), { kind: 'no-helper' })
    assert.deepEqual(await judgeOnePR('P1', { area }), { kind: 'no-helper' })
    assert.deepEqual(await judgeOnePR('P1', { area, claudeCode: helper(() => ({ ok: false, error: 'Not logged in' })) }), { kind: 'error', message: 'Claude Code: Not logged in' })
  })
})
