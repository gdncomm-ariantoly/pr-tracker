/**
 * The few chrome.* calls the worker and the page both hand to lib/refresh.js.
 * Kept out of lib/ so lib stays testable without a browser.
 */

import { NATIVE_HOST } from './lib/sessions.js'

/** Has the user granted this optional host (Jenkins, Anthropic)? @param {string} origin */
export const hostAllowed = (origin) => chrome.permissions.contains({ origins: [`${origin}/*`] })

/** @returns {Promise<boolean>} */
export const nativeAllowed = () => chrome.permissions.contains({ permissions: ['nativeMessaging'] })

/**
 * Claude Code on this Mac, through the helper: `claude -p` with no tools, on
 * the user's own Claude subscription (see native/host.mjs).
 */
export const claudeCode = {
  // Helper v4+ refuses personal plans itself; an older one doesn't, so it isn't used.
  allowed: async () => {
    const info = await helperInfo().catch(() => null)
    return !!info?.ok && (info.version ?? 0) >= SUMMARY_HELPER && !!info.account?.ok
  },
  ask: (/** @type {object} */ request) => chrome.runtime.sendNativeMessage(NATIVE_HOST, request),
}

/**
 * The macOS Keychain, through the helper: where the GitHub and Jenkins tokens
 * live when Settings says so. Throws when the helper is missing or refuses.
 */
export const secrets = {
  /** @param {'github' | 'jenkins'} name @returns {Promise<string>} */
  async get(name) {
    return (await keychainCall({ type: 'secret-get', name })).value ?? ''
  },
  /** @param {'github' | 'jenkins'} name @param {string} value */
  async set(name, value) {
    await keychainCall({ type: 'secret-set', name, value })
  },
  /** @param {'github' | 'jenkins'} name */
  async delete(name) {
    await keychainCall({ type: 'secret-delete', name })
  },
}

/** @param {object} request */
async function keychainCall(request) {
  if (!(await nativeAllowed()) || !chrome.runtime.sendNativeMessage) throw new Error('the Claude Code helper is not connected')
  const answer = await chrome.runtime.sendNativeMessage(NATIVE_HOST, request)
  if (!answer?.ok) throw new Error(answer?.error ?? 'the helper gave no answer')
  return answer
}

/** The first helper version that checks the Claude account before sending anything. */
export const SUMMARY_HELPER = 4

/** The helper's ping: its version and whether it found the claude CLI. null when not connected. */
export async function helperInfo() {
  if (!(await nativeAllowed()) || !chrome.runtime.sendNativeMessage) return null
  return /** @type {{ok: boolean, version?: number, claude?: boolean, keychain?: boolean, account?: {ok: true, label: string} | {ok: false, reason: string}}} */ (await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'ping' }))
}

/**
 * Ask the local Claude Code helper (native/host.mjs) about these PRs.
 * null: not connected (permission not granted). Throws when the helper isn't
 * installed or answers with an error.
 *
 * @param {string[]} keys
 * @returns {Promise<Record<string, import('./lib/sessions.js').LocalSession[]> | null>}
 */
export async function localSessions(keys) {
  if (!(await nativeAllowed()) || !chrome.runtime.sendNativeMessage) return null
  const answer = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'sessions', prs: keys })
  if (!answer?.ok) throw new Error(answer?.error ?? 'The Claude Code helper gave no answer')
  return answer.sessions ?? {}
}
