import { groupPRs, STALE_DAYS } from '../lib/group.js'
import { applyOverrides, toggleOverride } from '../lib/overrides.js'
import { refresh } from '../lib/refresh.js'
import { loadOverrides, loadSettings, loadSnapshot, parseList, saveOverrides, saveSettings } from '../lib/store.js'

/** @typedef {import('../lib/github.js').Snapshot} Snapshot */
/** @typedef {import('../lib/github.js').ReviewPR} ReviewPR */
/** @typedef {import('../lib/analyze.js').Finding} Finding */

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id))
const input = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (document.getElementById(id))

/** @type {Record<import('../lib/analyze.js').Status, string>} */
const STATUS_LABEL = {
  resolved: 'Resolved',
  outdated: 'Code changed',
  'fixed-reply': 'Fixed (reply)',
  replied: 'Replied',
  'commit-after': 'Commit after',
  open: 'Not addressed',
  'no-action': 'No action needed',
  optional: 'Optional',
}

const DECISION_LABEL = /** @type {Record<string, string>} */ ({
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  REVIEW_REQUIRED: 'Review required',
})

const state = {
  /** @type {'toReview' | 'mine'} */ tab: 'toReview',
  onlyPending: false,
  staleOpen: false,
  /** @type {Snapshot | null} */ snapshot: null,
  /** @type {Set<string>} */ open: new Set(),
  /** @type {import('../lib/overrides.js').Overrides} */ overrides: {},
}

try {
  const saved = JSON.parse(localStorage.getItem('ui') ?? '{}')
  if (saved.tab === 'mine' || saved.tab === 'toReview') state.tab = saved.tab
  state.onlyPending = saved.onlyPending === true
  state.staleOpen = saved.staleOpen === true
} catch {
  // per-viewer convenience only
}

function remember() {
  try {
    localStorage.setItem('ui', JSON.stringify({ tab: state.tab, onlyPending: state.onlyPending, staleOpen: state.staleOpen }))
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------- rendering

/** @param {string} iso */
function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** @param {ParentNode} root @param {string} selector @param {string} text */
function setText(root, selector, text) {
  const el = root.querySelector(selector)
  if (el) el.textContent = text
}

/** @param {number} n */
function countBadge(n) {
  const el = document.createElement('span')
  el.className = 'n'
  el.textContent = String(n)
  return el
}

/** @param {string} text @param {string} [cls] */
function chip(text, cls = '') {
  const el = document.createElement('span')
  el.className = `chip ${cls}`
  el.textContent = text
  return el
}

/** @param {string} body */
function excerpt(body) {
  const text = body.replace(/<!--[\s\S]*?-->/g, '').trim()
  return text.length > 600 ? `${text.slice(0, 599)}…` : text
}

/**
 * @param {Finding} f
 * @param {string} viewer
 */
function renderFinding(f, viewer) {
  const tpl = /** @type {HTMLTemplateElement} */ ($('finding-tpl'))
  const li = /** @type {HTMLElement} */ (tpl.content.firstElementChild?.cloneNode(true))
  li.dataset.status = f.status
  li.dataset.id = f.id
  li.classList.toggle('fixed', f.fixed)
  li.classList.toggle('no-action', !!f.noAction)
  const status = /** @type {HTMLElement} */ (li.querySelector('.status'))
  status.textContent = STATUS_LABEL[f.status]
  status.className = `status s-${f.status}`
  setText(li, '.who', f.author === viewer ? `${f.author} (you)` : f.author)
  const where =
    f.kind === 'inline'
      ? `${f.path}${f.line ? `:${f.line}` : ''}${f.replies ? ` · ${f.replies} repl${f.replies === 1 ? 'y' : 'ies'}` : ''}`
      : f.kind === 'review'
        ? `review${f.reviewState && f.reviewState !== 'COMMENTED' ? ` · ${f.reviewState.toLowerCase().replace('_', ' ')}` : ''}`
        : 'conversation'
  setText(li, '.where', where)
  const when = /** @type {HTMLAnchorElement} */ (li.querySelector('.when'))
  when.textContent = ago(f.createdAt)
  when.href = f.url
  when.title = new Date(f.createdAt).toLocaleString()
  setText(li, '.body', excerpt(f.body) || '(no text)')
  setText(li, '.evidence', f.evidence)

  // Manual override: only for comments still counted as unfixed, or to undo one.
  const mark = /** @type {HTMLButtonElement} */ (li.querySelector('.mark'))
  if (f.overridden) {
    mark.textContent = 'Undo'
    mark.title = 'Count this comment as unfixed again'
  } else if (!f.fixed && !f.noAction) {
    mark.textContent = 'No action needed'
    mark.title = 'This comment does not need a code change'
  } else {
    mark.hidden = true
  }
  mark.addEventListener('click', async (event) => {
    event.preventDefault()
    state.overrides = toggleOverride(state.overrides, f.id, !f.overridden)
    paint()
    await saveOverrides(state.overrides)
  })
  return li
}

/**
 * @param {ReviewPR} pr
 * @param {string} viewer
 * @param {boolean} showRepo  false inside a service group, where the heading already names it
 */
function renderPR(pr, viewer, showRepo) {
  const tpl = /** @type {HTMLTemplateElement} */ ($('pr-tpl'))
  const el = /** @type {HTMLElement} */ (tpl.content.firstElementChild?.cloneNode(true))
  el.dataset.id = pr.id
  const details = /** @type {HTMLDetailsElement} */ (el.querySelector('details'))
  details.open = state.open.has(pr.id)
  details.addEventListener('toggle', () => {
    if (details.open) state.open.add(pr.id)
    else state.open.delete(pr.id)
  })

  const title = /** @type {HTMLAnchorElement} */ (el.querySelector('.title'))
  title.textContent = `#${pr.number} ${pr.title}`
  title.href = pr.url
  const meta = [showRepo ? pr.repo : '', state.tab === 'toReview' ? `by ${pr.author}` : '', `updated ${ago(pr.updatedAt)}`]
  setText(el, '.repo', meta.filter(Boolean).join(' · '))

  const chips = /** @type {HTMLElement} */ (el.querySelector('.chips'))
  if (pr.isDraft) chips.append(chip('Draft', 'c-draft'))
  if (state.tab === 'toReview') chips.append(pr.requested ? chip('Review requested', 'c-req') : chip('Reviewed by you', 'c-muted'))
  if (pr.reviewDecision && DECISION_LABEL[pr.reviewDecision]) {
    chips.append(chip(DECISION_LABEL[pr.reviewDecision], `c-${pr.reviewDecision.toLowerCase()}`))
  }

  const tally = /** @type {HTMLElement} */ (el.querySelector('.tally'))
  if (!pr.hasHumanComments) {
    tally.append(chip('No human comments', 'c-muted'))
    details.classList.add('no-findings')
  } else {
    tally.append(chip(`${pr.counts.total} comment${pr.counts.total === 1 ? '' : 's'}`, 'c-human'))
    if (pr.counts.fixed) tally.append(chip(`${pr.counts.fixed} fixed`, 'c-fixed'))
    if (pr.counts.pending) tally.append(chip(`${pr.counts.pending} unfixed`, 'c-pending'))
    if (pr.counts.noAction) tally.append(chip(`${pr.counts.noAction} no action`, 'c-muted'))
    const list = /** @type {HTMLElement} */ (el.querySelector('.findings'))
    // Unfixed first — those are what need doing — then no-action, then fixed.
    const rank = (/** @type {Finding} */ f) => (f.fixed ? 2 : f.noAction ? 1 : 0)
    const ordered = [...pr.findings].sort((a, b) => rank(a) - rank(b))
    for (const f of ordered) list.append(renderFinding(f, viewer))
  }
  return el
}

function paint() {
  const snap = state.snapshot && applyOverrides(state.snapshot, state.overrides)
  const list = $('list')
  const empty = $('empty')
  list.replaceChildren()

  for (const tab of /** @type {const} */ (['toReview', 'mine'])) {
    const btn = $(`tab-${tab}`)
    btn.setAttribute('aria-selected', String(state.tab === tab))
    $(`n-${tab}`).textContent = String(snap?.[tab].length ?? 0)
  }
  input('only-pending').checked = state.onlyPending

  const warn = $('warning')
  warn.hidden = !snap?.warnings?.length
  warn.textContent = snap?.warnings?.join(' ') ?? ''

  $('viewer').textContent = snap?.viewer ? `@${snap.viewer}` : ''
  $('fetched').textContent = snap ? `updated ${ago(snap.fetchedAt)}` : ''

  if (!snap) {
    empty.hidden = false
    empty.textContent = 'No data yet. Add a token in Settings, then Refresh.'
    return
  }
  const prs = /** @type {ReviewPR[]} */ (snap[state.tab]).filter((p) => !state.onlyPending || p.counts.pending > 0)
  const { services, stale } = groupPRs(prs)
  for (const group of services) {
    const section = document.createElement('section')
    section.className = 'group'
    section.dataset.group = group.name
    const head = document.createElement('h2')
    head.className = 'group-head'
    head.textContent = group.name
    head.append(countBadge(group.prs.length))
    section.append(head, ...group.prs.map((pr) => renderPR(pr, snap.viewer, false)))
    list.append(section)
  }
  if (stale.length) {
    const box = document.createElement('details')
    box.className = 'group stale'
    box.dataset.group = 'stale'
    box.open = state.staleOpen
    box.addEventListener('toggle', () => {
      state.staleOpen = box.open
      remember()
    })
    const head = document.createElement('summary')
    head.className = 'group-head'
    head.textContent = 'Stale'
    head.append(countBadge(stale.length))
    const note = document.createElement('span')
    note.className = 'group-note'
    note.textContent = `no activity for ${STALE_DAYS}+ days`
    head.append(note)
    box.append(head, ...stale.map((pr) => renderPR(pr, snap.viewer, true)))
    list.append(box)
  }
  empty.hidden = prs.length > 0
  empty.textContent = state.onlyPending ? 'Nothing unfixed here.' : 'No open PRs here.'
  if (snap.truncated[state.tab]) {
    const more = document.createElement('p')
    more.className = 'muted empty'
    more.textContent = 'Showing the 30 most recently updated — there are more on GitHub.'
    list.append(more)
  }
}

/** @param {string | null | undefined} message */
function showError(message) {
  const el = $('error')
  el.hidden = !message
  el.textContent = message ?? ''
}

// ---------------------------------------------------------------- actions

async function doRefresh() {
  const btn = /** @type {HTMLButtonElement} */ ($('refresh'))
  btn.disabled = true
  btn.textContent = 'Refreshing…'
  try {
    state.snapshot = await refresh()
    showError(null)
    paint()
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error))
  } finally {
    btn.disabled = false
    btn.textContent = 'Refresh'
  }
}

$('refresh').addEventListener('click', () => void doRefresh())

$('toggle-settings').addEventListener('click', () => {
  const form = $('settings')
  form.hidden = !form.hidden
  $('toggle-settings').setAttribute('aria-expanded', String(!form.hidden))
})

$('settings').addEventListener('submit', async (event) => {
  event.preventDefault()
  const current = await loadSettings()
  const typed = input('token').value.trim()
  await saveSettings({
    token: typed || current.token,
    extraBots: parseList(/** @type {HTMLTextAreaElement} */ ($('bots')).value),
    refreshMinutes: Number(/** @type {HTMLSelectElement} */ ($('minutes')).value),
    notify: input('notify').checked,
  })
  input('token').value = ''
  input('token').placeholder = typed || current.token ? 'Token saved — paste a new one to replace it' : 'github_pat_…'
  $('settings').hidden = true
  $('toggle-settings').setAttribute('aria-expanded', 'false')
  await doRefresh()
})

for (const btn of document.querySelectorAll('[data-tab]')) {
  btn.addEventListener('click', () => {
    state.tab = /** @type {'toReview' | 'mine'} */ (/** @type {HTMLElement} */ (btn).dataset.tab)
    remember()
    paint()
  })
}

input('only-pending').addEventListener('change', () => {
  state.onlyPending = input('only-pending').checked
  remember()
  paint()
})

// The worker's alarm writes new snapshots; repaint whenever one lands.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes.snapshot?.newValue) {
    state.snapshot = /** @type {Snapshot} */ (changes.snapshot.newValue)
    paint()
  }
  if (changes.overrides) {
    const next = changes.overrides.newValue
    state.overrides = next && typeof next === 'object' ? /** @type {any} */ (next) : {}
    paint()
  }
  if ('lastError' in changes) {
    const message = changes.lastError.newValue
    showError(typeof message === 'string' ? message : null)
  }
})

async function init() {
  const [settings, snapshot, overrides, { lastError }] = await Promise.all([
    loadSettings(),
    loadSnapshot(),
    loadOverrides(),
    chrome.storage.local.get('lastError'),
  ])
  state.snapshot = snapshot
  state.overrides = overrides
  const bots = /** @type {HTMLTextAreaElement} */ ($('bots'))
  bots.value = settings.extraBots.join(', ')
  const minutes = /** @type {HTMLSelectElement} */ ($('minutes'))
  minutes.value = String(settings.refreshMinutes)
  input('notify').checked = settings.notify
  if (settings.token) input('token').placeholder = 'Token saved — paste a new one to replace it'
  showError(typeof lastError === 'string' ? lastError : null)
  paint()
  if (!settings.token) {
    $('settings').hidden = false
    $('toggle-settings').setAttribute('aria-expanded', 'true')
  } else if (!snapshot || Date.now() - Date.parse(snapshot.fetchedAt) > 60_000) {
    void doRefresh()
  }
}

void init()
