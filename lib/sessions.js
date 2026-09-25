/**
 * Links between PRs and the Claude Code sessions that worked on them.
 *
 * Two sources, merged per PR:
 *   - the hidden marker our Claude Code hook adds to posted reviews/comments
 *     (`<!-- claude-code-session: <id> -->`) — works for anyone's comments;
 *   - the local helper (native/host.mjs), which scans this machine's session
 *     transcripts and also knows each session's project folder, so it can
 *     give a full resume command.
 *
 * Pure: the helper call is injected.
 */

export const NATIVE_HOST = 'com.gdncomm.pr_tracker'
const MARKER = /<!--\s*claude-code-session:\s*([0-9a-f-]{8,64})\s*-->/i
const FOOTER = /Generated with \[?Claude Code\]?|Co-Authored-By: Claude\b/i

/** @typedef {{sessionId: string, cwd: string, title: string, lastAt: string, kind: 'review' | 'mention'}} LocalSession */

/**
 * @param {string | undefined} body  raw markdown (bodyHTML drops HTML comments)
 * @returns {{sessionId?: string, viaClaudeCode: boolean}}
 */
export function claudeCodeMark(body) {
  const id = MARKER.exec(body ?? '')?.[1]
  return { sessionId: id?.toLowerCase(), viaClaudeCode: !!id || FOOTER.test(body ?? '') }
}

/** "owner/repo#n", lower-cased, as the helper keys it. */
export const prKey = (/** @type {{repo: string, number: number}} */ pr) => `${pr.repo.toLowerCase()}#${pr.number}`

/**
 * The command that reopens a session. With the project folder known it's
 * complete; without it, `--resume` has to be run from that project.
 *
 * @param {string} sessionId
 * @param {string} [cwd]
 */
export function resumeCommand(sessionId, cwd) {
  const quoted = cwd ? `'${cwd.replace(/'/g, `'\\''`)}'` : ''
  return cwd ? `cd ${quoted} && claude --resume ${sessionId}` : `claude --resume ${sessionId}`
}
