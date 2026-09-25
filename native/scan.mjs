/**
 * Finds local Claude Code sessions that touched a PR, by reading the session
 * transcripts under ~/.claude/projects/<project>/<session-id>.jsonl.
 *
 * Best-effort by design: the transcript format is internal to Claude Code and
 * changes between versions, so nothing here assumes more than "one JSON-ish
 * line per entry, somewhere carrying cwd / timestamp / a title". A session is
 * found by what it says, not by fields:
 *
 *   github.com/<owner>/<repo>/pull/<n>        a PR link anywhere
 *   gh pr <verb> <n> ... --repo <owner>/<repo>  (or --repo first)
 *   <!-- claude-code-session: <id> -->        the marker our hook adds
 *
 * "review" when the same line also asks for or posts a review (gh pr review /
 * comment, /code-review, "review this PR"); otherwise "mention".
 *
 * Only metadata leaves this module: session id, project dir, title, times.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/** @typedef {{sessionId: string, cwd: string, title: string, lastAt: string, kind: 'review' | 'mention'}} SessionHit */
/** @typedef {{mtimeMs: number, size: number, prs: Record<string, 'review' | 'mention'>, cwd: string, title: string, lastAt: string}} FileIndex */

const URL_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g
const GH_NUM_FIRST = /\bgh pr (\w+)\s+(\d+)\b[^\n]{0,200}?--repo[= ]([\w.-]+\/[\w.-]+)/g
const GH_REPO_FIRST = /\bgh pr (\w+)\s+--repo[= ]([\w.-]+\/[\w.-]+)\s+(\d+)\b/g
const REVIEWISH = /\bgh pr (?:review|comment)\b|\/code-review\b|\breview(?:ing)? (?:this|the|my)? ?(?:pr|pull request)\b|claude-code-session:/i
const TITLE_RE = /"customTitle":"((?:[^"\\]|\\.){1,200})"/
const SUMMARY_RE = /"type":"summary","summary":"((?:[^"\\]|\\.){1,200})"/
const CWD_RE = /"cwd":"((?:[^"\\]|\\.){1,500})"/
const TIME_RE = /"timestamp":"(\d{4}-\d\d-\d\dT[^"]{1,40})"/

/** @param {string} s JSON string contents */
const unescape = (s) => {
  try {
    return JSON.parse(`"${s}"`)
  } catch {
    return s
  }
}

/** "owner/repo#n", lower-cased repo so links and commands agree. */
export const prKey = (/** @type {string} */ repo, /** @type {string | number} */ n) => `${repo.toLowerCase()}#${n}`

/**
 * Index one transcript's text.
 *
 * @param {string} text
 * @returns {Omit<FileIndex, 'mtimeMs' | 'size'>}
 */
export function indexTranscript(text) {
  /** @type {Record<string, 'review' | 'mention'>} */
  const prs = {}
  let cwd = ''
  let title = ''
  let firstPrompt = ''
  let lastAt = ''
  const note = (/** @type {string} */ key, /** @type {boolean} */ review) => {
    if (review) prs[key] = 'review'
    else prs[key] ??= 'mention'
  }
  for (const line of text.split('\n')) {
    if (!line) continue
    if (!cwd) cwd = unescape(CWD_RE.exec(line)?.[1] ?? '')
    const t = TIME_RE.exec(line)?.[1]
    if (t && t > lastAt) lastAt = t
    const custom = TITLE_RE.exec(line)?.[1] ?? SUMMARY_RE.exec(line)?.[1]
    if (custom) title = unescape(custom) // the latest title wins
    if (!firstPrompt && line.includes('"type":"user"')) {
      const m = /"content":"((?:[^"\\]|\\.){1,300})/.exec(line)
      if (m && !m[1].startsWith('<')) firstPrompt = unescape(m[1].replace(/\\$/, ''))
    }
    if (!line.includes('pull/') && !line.includes('gh pr ')) continue
    const review = REVIEWISH.test(line)
    for (const m of line.matchAll(URL_RE)) note(prKey(`${m[1]}/${m[2]}`, m[3]), review)
    for (const m of line.matchAll(GH_NUM_FIRST)) note(prKey(m[3], m[2]), m[1] === 'review' || m[1] === 'comment' || review)
    for (const m of line.matchAll(GH_REPO_FIRST)) note(prKey(m[2], m[3]), m[1] === 'review' || m[1] === 'comment' || review)
  }
  return { prs, cwd, title: (title || firstPrompt).replace(/\s+/g, ' ').trim().slice(0, 120), lastAt }
}

/**
 * Every transcript under `root`, re-reading only files whose size or mtime
 * changed since `cache`. Returns the new cache (pass it back next time).
 *
 * @param {string} root  ~/.claude/projects
 * @param {Record<string, FileIndex>} [cache]
 * @returns {Record<string, FileIndex>}
 */
export function indexAll(root, cache = {}) {
  /** @type {Record<string, FileIndex>} */
  const next = {}
  /** @type {string[]} */
  let projects = []
  try {
    projects = readdirSync(root)
  } catch {
    return next
  }
  for (const project of projects) {
    const dir = path.join(root, project)
    /** @type {string[]} */
    let files = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const file of files) {
      const full = path.join(dir, file)
      try {
        const st = statSync(full)
        const hit = cache[full]
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
          next[full] = hit
          continue
        }
        next[full] = { mtimeMs: st.mtimeMs, size: st.size, ...indexTranscript(readFileSync(full, 'utf8')) }
      } catch {
        // unreadable or vanished mid-scan: skip it
      }
    }
  }
  return next
}

/**
 * @param {Record<string, FileIndex>} index
 * @param {string[]} keys  prKey()s asked about
 * @returns {Record<string, SessionHit[]>}  reviews first, then newest
 */
export function sessionsFor(index, keys) {
  /** @type {Record<string, SessionHit[]>} */
  const out = {}
  const wanted = new Set(keys.map((k) => k.toLowerCase()))
  for (const [file, entry] of Object.entries(index)) {
    for (const [key, kind] of Object.entries(entry.prs)) {
      if (!wanted.has(key)) continue
      const list = out[key] ?? (out[key] = [])
      list.push({ sessionId: path.basename(file, '.jsonl'), cwd: entry.cwd, title: entry.title, lastAt: entry.lastAt, kind })
    }
  }
  for (const list of Object.values(out)) {
    list.sort((a, b) => (a.kind === b.kind ? b.lastAt.localeCompare(a.lastAt) : a.kind === 'review' ? -1 : 1))
    list.splice(10) // a PR discussed in 40 sessions doesn't need 40 rows
  }
  return out
}
