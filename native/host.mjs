#!/usr/bin/env node
/**
 * Chrome native-messaging host for PR Tracker. Two jobs:
 *   - "which local Claude Code sessions touched these PRs?" Read-only; never
 *     returns transcript content, only session metadata (see scan.mjs).
 *   - "judge this PR's comments": runs Claude Code headless (`claude -p`) on
 *     the user's own subscription, with every tool switched off, no settings,
 *     no MCP servers and no saved session — text in, JSON out.
 *
 * Protocol (Chrome's): each message is a 4-byte little-endian length, then
 * that many bytes of UTF-8 JSON, on stdin / stdout.
 *
 *   → {type: 'sessions', prs: ['gdncomm/product-feed#104', …]}
 *   ← {ok: true, sessions: {'gdncomm/product-feed#104': [{sessionId, cwd, title, lastAt, kind}]}}
 *   → {type: 'judge', model, system, schema, prompt}  ← {ok: true, output: {summary, verdicts}}
 *   → {type: 'ping'}  ← {ok: true, version: 2, claude: <found the claude CLI?>}
 */

import { spawn } from 'node:child_process'
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { indexAll, sessionsFor } from './scan.mjs'

const ROOT = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects') : path.join(homedir(), '.claude', 'projects')
const CACHE = path.join(homedir(), '.cache', 'pr-tracker', 'claude-sessions.json')
/** PR Tracker's own repo: its sessions mention PRs as test data, not as work on them. */
const SELF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const VERSION = 2
/** A judge run longer than this is killed. */
const JUDGE_TIMEOUT_MS = 4 * 60 * 1000

/**
 * The claude CLI: install.sh pins it (Chrome starts helpers with a bare PATH),
 * else the usual install locations.
 * @returns {string | null}
 */
export function findClaude(env = process.env) {
  const candidates = [env.PR_TRACKER_CLAUDE, path.join(homedir(), '.local/bin/claude'), path.join(homedir(), '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  for (const c of candidates) {
    if (!c) continue
    try {
      accessSync(c, constants.X_OK)
      return c
    } catch {
      // next
    }
  }
  return null
}

/** The `claude -p` arguments for one judgement: no tools, settings, MCP or saved session. */
export function judgeArgs(/** @type {{model: string, system: string, schema: object}} */ r) {
  return ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(r.schema), '--model', r.model, '--system-prompt', r.system, '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence']
}

/**
 * @param {any} request
 * @param {string | null} [bin]
 * @returns {Promise<{ok: true, output: unknown} | {ok: false, error: string}>}
 */
export async function judge(request, bin = findClaude()) {
  const { model, system, schema, prompt } = request ?? {}
  if (typeof model !== 'string' || !/^claude-[a-z0-9-]{1,40}$/.test(model)) return { ok: false, error: 'bad model' }
  if (typeof system !== 'string' || typeof prompt !== 'string' || !schema || typeof schema !== 'object') return { ok: false, error: 'bad request' }
  if (prompt.length > 1_000_000) return { ok: false, error: 'PR too large to judge' }
  if (!bin) return { ok: false, error: "the claude command wasn't found — re-run native/install.sh from a terminal where `claude` works" }
  const out = await new Promise((resolve) => {
    // A scratch directory: no project CLAUDE.md or settings get picked up.
    const child = spawn(bin, judgeArgs({ model, system, schema }), { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), JUDGE_TIMEOUT_MS)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
    child.stdin.end(prompt)
  })
  const { code, signal, stdout, stderr } = /** @type {{code: number, signal?: string, stdout: string, stderr: string}} */ (out)
  if (signal) return { ok: false, error: 'Claude Code took too long' }
  /** @type {any} */ let json = null
  try {
    json = JSON.parse(stdout)
  } catch {
    // fall through with the exit code / stderr
  }
  if (!json) return { ok: false, error: (stderr || stdout).trim().split('\n').slice(-1)[0] || `claude exited ${code}` }
  if (json.is_error || json.subtype !== 'success') return { ok: false, error: String(json.result || json.subtype || 'failed') }
  if (json.structured_output) return { ok: true, output: json.structured_output }
  try {
    return { ok: true, output: JSON.parse(json.result) }
  } catch {
    return { ok: false, error: 'Claude Code answered without the expected JSON' }
  }
}

/** @param {unknown} message */
function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  process.stdout.write(Buffer.concat([head, body]))
}

/** @param {any} request */
export function handle(request, root = ROOT, cacheFile = CACHE) {
  if (request?.type === 'ping') return { ok: true, version: VERSION, claude: !!findClaude() }
  if (request?.type === 'judge') return judge(request)
  if (request?.type !== 'sessions' || !Array.isArray(request.prs)) return { ok: false, error: 'unknown request' }
  /** @type {Record<string, import('./scan.mjs').FileIndex>} */
  let cache = {}
  try {
    cache = JSON.parse(readFileSync(cacheFile, 'utf8'))
  } catch {
    // first run, or a corrupt cache: rebuild
  }
  const index = indexAll(root, cache)
  try {
    mkdirSync(path.dirname(cacheFile), { recursive: true })
    writeFileSync(cacheFile, JSON.stringify(index))
  } catch {
    // a read-only home still answers, just slower next time
  }
  const prs = request.prs.filter((/** @type {unknown} */ k) => typeof k === 'string').slice(0, 500)
  const own = Object.fromEntries(Object.entries(index).filter(([, e]) => e.cwd !== SELF && !e.cwd.startsWith(`${SELF}/`)))
  return { ok: true, sessions: sessionsFor(own, prs) }
}

// Read framed messages until Chrome closes stdin.
/** Run as a program (not imported by a test)? Compares real paths: /var vs /private/var, symlinks. */
function isMain() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? '')
  } catch {
    return false
  }
}

if (isMain()) {
  let buffer = Buffer.alloc(0)
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0)
      if (buffer.length < 4 + size) break
      const raw = buffer.subarray(4, 4 + size).toString('utf8')
      buffer = buffer.subarray(4 + size)
      Promise.resolve()
        .then(() => /** @type {Promise<unknown> | unknown} */ (handle(JSON.parse(raw))))
        .then(send, (error) => send({ ok: false, error: String(error) }))
    }
  })
}
