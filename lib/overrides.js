/**
 * The user's own "no action needed" marks, layered over the analysis. Kept
 * apart from the snapshot so a refresh never loses them.
 */

import { countFindings } from './analyze.js'

/** @typedef {Record<string, true>} Overrides  finding id → marked no action */

/**
 * @template {import('./github.js').Snapshot} S
 * @param {S} snapshot
 * @param {Overrides} overrides
 * @returns {S}
 */
export function applyOverrides(snapshot, overrides) {
  if (!Object.keys(overrides).length) return snapshot
  /** @param {import('./analyze.js').PRSummary} pr */
  const apply = (pr) => {
    if (!pr.findings.some((f) => overrides[f.id])) return pr
    const findings = pr.findings.map((f) =>
      overrides[f.id] && !f.fixed
        ? { ...f, status: /** @type {const} */ ('no-action'), noAction: true, overridden: true, evidence: 'You marked this as no action needed.' }
        : f,
    )
    return { ...pr, findings, counts: countFindings(findings) }
  }
  return { ...snapshot, mine: snapshot.mine.map(apply), toReview: snapshot.toReview.map(apply) }
}

/**
 * @param {Overrides} overrides
 * @param {string} id
 * @param {boolean} on
 * @returns {Overrides}
 */
export function toggleOverride(overrides, id, on) {
  const next = { ...overrides }
  if (on) next[id] = true
  else delete next[id]
  return next
}
