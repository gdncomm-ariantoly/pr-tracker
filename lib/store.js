/**
 * Settings and the last fetched snapshot, in chrome.storage.local. The storage
 * area is an argument so tests pass a plain object.
 */

/** @typedef {{token: string, extraBots: string[], refreshMinutes: number, notify: boolean}} Settings */
/** @typedef {{get: (key: string) => Promise<Record<string, unknown>>, set: (items: Record<string, unknown>) => Promise<void>}} AreaLike */

/** @type {Settings} */
export const DEFAULTS = { token: '', extraBots: [], refreshMinutes: 15, notify: true }

/** @returns {AreaLike} */
function defaultArea() {
  return chrome.storage.local
}

/**
 * @param {unknown} value
 * @returns {Settings}
 */
export function normalise(value) {
  if (!value || typeof value !== 'object') return { ...DEFAULTS, extraBots: [] }
  const raw = /** @type {Record<string, unknown>} */ (value)
  const minutes = Number(raw.refreshMinutes)
  return {
    token: typeof raw.token === 'string' ? raw.token.trim() : '',
    extraBots: Array.isArray(raw.extraBots)
      ? raw.extraBots.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().toLowerCase())
      : [],
    refreshMinutes: Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440 ? minutes : DEFAULTS.refreshMinutes,
    notify: typeof raw.notify === 'boolean' ? raw.notify : DEFAULTS.notify,
  }
}

/** "a, b\nc" → ["a","b","c"] */
export function parseList(/** @type {string} */ text) {
  return text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
}

/** @param {AreaLike} [area] */
export async function loadSettings(area = defaultArea()) {
  return normalise((await area.get('settings')).settings)
}

/** @param {Settings} settings @param {AreaLike} [area] */
export async function saveSettings(settings, area = defaultArea()) {
  const clean = normalise(settings)
  await area.set({ settings: clean })
  return clean
}

/**
 * @param {AreaLike} [area]
 * @returns {Promise<import('./github.js').Snapshot | null>}
 */
export async function loadSnapshot(area = defaultArea()) {
  const { snapshot } = await area.get('snapshot')
  return snapshot && typeof snapshot === 'object' ? /** @type {any} */ (snapshot) : null
}

/** @param {import('./github.js').Snapshot} snapshot @param {AreaLike} [area] */
export async function saveSnapshot(snapshot, area = defaultArea()) {
  await area.set({ snapshot, lastError: null })
}

/** @param {string | null} message @param {AreaLike} [area] */
export async function saveError(message, area = defaultArea()) {
  await area.set({ lastError: message })
}
