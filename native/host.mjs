#!/usr/bin/env node
/**
 * Chrome native-messaging host for PR Tracker: answers "which local Claude
 * Code sessions touched these PRs?". Read-only; never returns transcript
 * content, only session metadata (see scan.mjs).
 *
 * Protocol (Chrome's): each message is a 4-byte little-endian length, then
 * that many bytes of UTF-8 JSON, on stdin / stdout.
 *
 *   → {type: 'sessions', prs: ['gdncomm/product-feed#104', …]}
 *   ← {ok: true, sessions: {'gdncomm/product-feed#104': [{sessionId, cwd, title, lastAt, kind}]}}
 *   → {type: 'ping'}  ← {ok: true, version: 1}
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { indexAll, sessionsFor } from './scan.mjs'

const ROOT = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects') : path.join(homedir(), '.claude', 'projects')
const CACHE = path.join(homedir(), '.cache', 'pr-tracker', 'claude-sessions.json')
/** PR Tracker's own repo: its sessions mention PRs as test data, not as work on them. */
const SELF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** @param {unknown} message */
function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  process.stdout.write(Buffer.concat([head, body]))
}

/** @param {any} request */
export function handle(request, root = ROOT, cacheFile = CACHE) {
  if (request?.type === 'ping') return { ok: true, version: 1 }
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
      try {
        send(handle(JSON.parse(raw)))
      } catch (error) {
        send({ ok: false, error: String(error) })
      }
    }
  })
}
