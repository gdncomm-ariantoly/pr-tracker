/**
 * Service worker: opens the dashboard tab, refreshes on an alarm, keeps the
 * badge showing how many PRs are waiting for my review. Not persistent — every
 * listener is registered synchronously at top level, all state is in storage.
 */

import { diffSnapshots } from './lib/notify.js'
import { badgeFor, refresh } from './lib/refresh.js'
import { loadSettings, loadSnapshot } from './lib/store.js'

const ALARM = 'refresh'
const APP = 'app' // notification-id prefix meaning "open the dashboard"
const MAX_SEPARATE = 4 // beyond this, one summary notification instead of a flood

chrome.action.onClicked.addListener(() => {
  void openApp()
})

chrome.runtime.onInstalled.addListener(() => {
  void schedule()
})
chrome.runtime.onStartup.addListener(() => {
  void schedule()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void refresh().catch(() => {})
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes.snapshot) {
    void paintBadge()
    // Every snapshot write — page Refresh or alarm — passes through here with
    // both versions, so this is the one place updates are detected.
    void notifyUpdates(changes.snapshot.oldValue, changes.snapshot.newValue)
  }
  if (changes.settings) void schedule()
})

chrome.notifications.onClicked.addListener((id) => {
  void chrome.notifications.clear(id)
  const url = id.slice(0, id.indexOf('|'))
  if (url === APP) void openApp()
  else if (url.startsWith('https://github.com/')) void chrome.tabs.create({ url })
})

/** @param {any} prev @param {any} next */
async function notifyUpdates(prev, next) {
  const events = diffSnapshots(prev, next)
  if (events.length === 0 || !(await loadSettings()).notify) return
  const base = { type: /** @type {const} */ ('basic'), iconUrl: 'icons/icon-128.png' }
  if (events.length > MAX_SEPARATE) {
    await chrome.notifications.create(`${APP}|summary:${Date.now()}`, {
      ...base,
      title: `${events.length} PR updates`,
      contextMessage: 'Click to open PR Tracker',
      message: events.slice(0, 3).map((e) => e.title).join('\n') + (events.length > 3 ? '\n…' : ''),
    })
    return
  }
  for (const e of events) {
    await chrome.notifications.create(`${e.url}|${e.key}`, { ...base, title: e.title, contextMessage: e.context, message: e.message })
  }
}

async function schedule() {
  const { refreshMinutes, token } = await loadSettings()
  await chrome.alarms.clear(ALARM)
  if (refreshMinutes > 0 && token) await chrome.alarms.create(ALARM, { periodInMinutes: refreshMinutes, delayInMinutes: 0.1 })
  await paintBadge()
}

async function paintBadge() {
  await chrome.action.setBadgeBackgroundColor({ color: '#bf3989' })
  await chrome.action.setBadgeText({ text: badgeFor(await loadSnapshot()) })
}

async function openApp() {
  const url = chrome.runtime.getURL('pages/app.html')
  const [existing] = await chrome.tabs.query({ url })
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true })
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true })
    return
  }
  await chrome.tabs.create({ url })
}
