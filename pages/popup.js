/**
 * The toolbar pop-up: a compact To review / My PRs list from the stored
 * snapshot, each row opening the PR on GitHub. The full page and a refresh
 * go through the service worker, which keeps working after the pop-up closes.
 */

import { groupPRs } from '../lib/group.js'
import { applyOverrides } from '../lib/overrides.js'
import { loadOverrides, loadSettings, loadSnapshot } from '../lib/store.js'

/** @typedef {import('../lib/github.js').Snapshot} Snapshot */
/** @typedef {import('../lib/github.js').ReviewPR} ReviewPR */

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id))

const state = {
  /** @type {'toReview' | 'mine'} */ tab: 'toReview',
  /** @type {Snapshot | null} */ snapshot: null,
  /** @type {import('../lib/overrides.js').Overrides} */ overrides: {},
  refreshing: false,
}

try {
  const saved = JSON.parse(localStorage.getItem('popup') ?? '{}')
  if (saved.tab === 'mine' || saved.tab === 'toReview') state.tab = saved.tab
} catch {
  // per-viewer convenience only
}

/** @param {string} iso */
function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** @param {string} text @param {string} [className] */
function chip(text, className = '') {
  const el = document.createElement('span')
  el.className = `chip ${className}`.trim()
  el.textContent = text
  return el
}

const BUILD = /** @type {Record<string, [string, string]>} */ ({
  success: ['passed', 'c-ok'],
  failure: ['failed', 'c-bad'],
  running: ['running', 'c-warn'],
  pending: ['queued', 'c-warn'],
  cancelled: ['cancelled', ''],
  skipped: ['skipped', ''],
})

/** One compact row: title, then repo and what needs attention. @param {ReviewPR} pr */
function row(pr) {
  const li = document.createElement('li')
  const a = document.createElement('a')
  a.className = 'row'
  a.href = pr.url
  a.target = '_blank'
  a.rel = 'noopener'
  a.dataset.id = pr.id
  a.title = `${pr.repo}#${pr.number} ${pr.title}`
  const t = document.createElement('span')
  t.className = 't'
  t.textContent = `#${pr.number} ${pr.title}`
  const m = document.createElement('span')
  m.className = 'm'
  m.append(`${pr.repo.replace(/^gdncomm\//, '')}${state.tab === 'toReview' ? ` · ${pr.author}` : ''} · ${ago(pr.updatedAt)}`)
  if (pr.isDraft) m.append(chip('Draft'))
  if (state.tab === 'toReview') {
    if (pr.requested) m.append(chip('Review requested', 'c-req'))
    else if (pr.watched) m.append(chip('Watched', 'c-watch'))
  } else if (pr.reviewDecision === 'APPROVED') m.append(chip('Approved', 'c-ok'))
  else if (pr.reviewDecision === 'CHANGES_REQUESTED') m.append(chip('Changes requested', 'c-bad'))
  if (pr.counts.pending) m.append(chip(`${pr.counts.pending} unfixed`, 'c-bad'))
  else if (pr.counts.total) m.append(chip(`${pr.counts.total} comment${pr.counts.total === 1 ? '' : 's'}`))
  if (pr.build) {
    const [label, cls] = BUILD[pr.build.state] ?? [pr.build.state, '']
    m.append(chip(label, `build ${cls}`))
  }
  a.append(t, m)
  li.append(a)
  return li
}

function paint() {
  const snap = state.snapshot && applyOverrides(state.snapshot, state.overrides)
  for (const tab of /** @type {const} */ (['toReview', 'mine'])) {
    $(`tab-${tab}`).setAttribute('aria-selected', String(state.tab === tab))
    $(`n-${tab}`).textContent = String(snap?.[tab].length ?? 0)
  }
  $('fetched').textContent = state.refreshing ? 'refreshing…' : snap ? `updated ${ago(snap.fetchedAt)}` : ''
  const refresh = /** @type {HTMLButtonElement} */ ($('refresh'))
  refresh.disabled = state.refreshing
  const list = $('list')
  const empty = $('empty')
  const more = $('more')
  list.replaceChildren()
  more.hidden = true
  if (!snap) {
    empty.hidden = false
    empty.textContent = 'No data yet. Open the full page to add your GitHub token.'
    return
  }
  // Same order as the full page, without the service headings; stale PRs stay there.
  const { services, stale } = groupPRs(/** @type {ReviewPR[]} */ (snap[state.tab]), Date.now(), snap.viewer)
  const prs = services.flatMap((g) => g.prs)
  list.append(...prs.map(row))
  empty.hidden = prs.length > 0
  empty.textContent = stale.length ? 'Nothing recent here.' : 'No open PRs here.'
  if (stale.length) {
    more.hidden = false
    more.replaceChildren(`${stale.length} stale PR${stale.length === 1 ? '' : 's'} not shown · `)
    const link = document.createElement('a')
    link.textContent = 'see them on the full page'
    link.addEventListener('click', () => void openFull())
    more.append(link)
  }
}

async function openFull() {
  await chrome.runtime.sendMessage({ type: 'open-app' })
  window.close()
}

for (const btn of document.querySelectorAll('[data-tab]')) {
  btn.addEventListener('click', () => {
    state.tab = /** @type {'toReview' | 'mine'} */ (/** @type {HTMLElement} */ (btn).dataset.tab)
    try {
      localStorage.setItem('popup', JSON.stringify({ tab: state.tab }))
    } catch {
      // ignore
    }
    paint()
  })
}

$('open-full').addEventListener('click', () => void openFull())

$('refresh').addEventListener('click', async () => {
  state.refreshing = true
  paint()
  // The worker runs it, so closing the pop-up doesn't cut it off; the new snapshot repaints through storage.
  const answer = await chrome.runtime.sendMessage({ type: 'refresh' }).catch((/** @type {unknown} */ error) => ({ error: String(error) }))
  state.refreshing = false
  showError(answer?.error ?? null)
  paint()
})

/** @param {string | null} message */
function showError(message) {
  const el = $('error')
  el.hidden = !message
  el.textContent = message ?? ''
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes.snapshot?.newValue) state.snapshot = /** @type {Snapshot} */ (changes.snapshot.newValue)
  if (changes.overrides) state.overrides = changes.overrides.newValue && typeof changes.overrides.newValue === 'object' ? /** @type {any} */ (changes.overrides.newValue) : {}
  if (changes.snapshot || changes.overrides) paint()
})

async function init() {
  // First run: nothing to list until a token is set, and Settings lives on the full page.
  if (!(await loadSettings()).token) return openFull()
  const [snapshot, overrides, { lastError }] = await Promise.all([loadSnapshot(), loadOverrides(), chrome.storage.local.get('lastError')])
  state.snapshot = snapshot
  state.overrides = overrides
  showError(typeof lastError === 'string' ? lastError : null)
  paint()
}

void init()
