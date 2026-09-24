/**
 * Service worker: opens the dashboard tab, refreshes on an alarm, keeps the
 * badge showing how many PRs are waiting for my review. Not persistent — every
 * listener is registered synchronously at top level, all state is in storage.
 */

import { badgeFor, refresh } from './lib/refresh.js'
import { loadSettings, loadSnapshot } from './lib/store.js'

const ALARM = 'refresh'

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
  if (changes.snapshot) void paintBadge()
  if (changes.settings) void schedule()
})

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
