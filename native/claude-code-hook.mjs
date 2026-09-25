#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: when a PR review or comment is about to be
 * posted, add a hidden marker with this session's id to its body, so PR
 * Tracker (yours, or a teammate's) can tell which Claude Code session wrote it:
 *
 *   <!-- claude-code-session: 57609ddd-15b6-4739-a098-97387dc48b05 -->
 *
 * Handles `gh pr review|comment ... --body "..."` (plain quotes or the
 * heredoc form Claude Code writes) and GitHub MCP tools with a `body` field.
 * Anything else passes through untouched. Only rewrites the input — it never
 * approves or blocks, so the normal permission prompt still applies.
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** @param {string} id */
export const marker = (id) => `<!-- claude-code-session: ${id} -->`

/**
 * @param {string} command
 * @param {string} id
 * @returns {string | null}  the new command, or null when there's nothing to mark
 */
export function markCommand(command, id) {
  if (!/\bgh\s+pr\s+(?:review|comment)\b/.test(command) || command.includes('claude-code-session:')) return null
  const tag = marker(id)
  // --body "$(cat <<'EOF' … EOF … )": add a line before the heredoc terminator.
  const heredoc = /(--body[= ]"\$\(cat <<-?'?(\w+)'?\n)([\s\S]*?)\n(\2)\n/.exec(command)
  if (heredoc) {
    const at = heredoc.index + heredoc[1].length + heredoc[3].length
    return `${command.slice(0, at)}\n\n${tag}${command.slice(at)}`
  }
  // --body "…" / -b '…' : add before the closing quote (the tag has no quotes or $).
  const quoted = /(--body|-b)([= ])(["'])((?:\\.|(?!\3)[^\\])*)\3/.exec(command)
  if (quoted) {
    const end = quoted.index + quoted[0].length - 1
    return `${command.slice(0, end)}\n\n${tag}${command.slice(end)}`
  }
  return null
}

/** @param {any} input  the hook's stdin JSON */
export function hookOutput(input) {
  const id = typeof input?.session_id === 'string' ? input.session_id : ''
  const tool = String(input?.tool_name ?? '')
  const args = input?.tool_input
  if (!id || !args || typeof args !== 'object') return null
  if (tool === 'Bash' && typeof args.command === 'string') {
    const command = markCommand(args.command, id)
    return command ? { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...args, command } } } : null
  }
  // GitHub MCP tools (create_pull_request_review, add_issue_comment, …) carry the text in `body`.
  if (/github/i.test(tool) && /review|comment/i.test(tool) && typeof args.body === 'string' && !args.body.includes('claude-code-session:')) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...args, body: `${args.body}\n\n${marker(id)}` } } }
  }
  return null
}

/** Run as a program (not imported by a test)? Compares real paths: /var vs /private/var, symlinks. */
function isMain() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? '')
  } catch {
    return false
  }
}

if (isMain()) {
  let raw = ''
  process.stdin.on('data', (c) => (raw += c))
  process.stdin.on('end', () => {
    try {
      const out = hookOutput(JSON.parse(raw))
      if (out) process.stdout.write(JSON.stringify(out))
    } catch {
      // never break the tool call over a marker
    }
    process.exit(0)
  })
}
