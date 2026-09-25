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
