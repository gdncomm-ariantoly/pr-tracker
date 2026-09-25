/**
 * The in-page history of updates (the right-hand panel). Pure: the worker adds
 * events as it detects them, the page marks them read.
 */

export const INBOX_LIMIT = 100

/** @typedef {import('./notify.js').UpdateEvent & {at: string, read: boolean}} InboxItem */

/**
 * Newest first, one entry per event key, capped.
 *
 * @param {InboxItem[]} inbox
 * @param {import('./notify.js').UpdateEvent[]} events
 * @param {string} [at]
 * @returns {InboxItem[]}
 */
export function addEvents(inbox, events, at = new Date().toISOString()) {
  if (!events.length) return inbox
  const fresh = events.map((e) => ({ ...e, at, read: false }))
  const keys = new Set(fresh.map((e) => e.key))
  return [...fresh, ...inbox.filter((i) => !keys.has(i.key))].slice(0, INBOX_LIMIT)
}

/**
 * @param {InboxItem[]} inbox
 * @param {string} [key]  one item; all when omitted
 * @returns {InboxItem[]}
 */
export function markRead(inbox, key) {
  return inbox.map((i) => (key === undefined || i.key === key ? { ...i, read: true } : i))
}

/**
 * @param {InboxItem[]} inbox
 * @param {string} key
 * @returns {InboxItem[]}
 */
export function removeItem(inbox, key) {
  return inbox.filter((i) => i.key !== key)
}

/** @param {InboxItem[]} inbox */
export function unreadCount(inbox) {
  return inbox.filter((i) => !i.read).length
}

/** @param {unknown} value @returns {InboxItem[]} */
export function normaliseInbox(value) {
  if (!Array.isArray(value)) return []
  return value.filter(
    (i) => i && typeof i === 'object' && typeof i.key === 'string' && typeof i.title === 'string' && typeof i.url === 'string' && /^https:\/\//.test(i.url),
  )
}
