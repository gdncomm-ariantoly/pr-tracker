import { groupPRs, STALE_DAYS } from '../lib/group.js'
import { renderComment } from './markdown.js'
import { markRead, normaliseInbox, removeItem, unreadCount } from '../lib/inbox.js'
import { applyOverrides, toggleOverride } from '../lib/overrides.js'
import { judgeOnePR, loadSprint, refresh, refreshOnePR } from '../lib/refresh.js'
import { shortLogin } from '../lib/notify.js'
import { formatHours, readings, TIER_LABEL, worstTier } from '../lib/signals.js'
import { CATEGORIES, CONTEXT, formatValue, sprintChoices, sprintsOfYear, wibDate } from '../lib/sprint.js'
import { JENKINS_HIDDEN } from '../lib/github.js'
import { resumeCommand } from '../lib/sessions.js'
import { claudeCode, helperInfo, localSessions, nativeAllowed, secrets, SUMMARY_HELPER } from '../platform.js'
import { ciSearchLink, deployJenkinsLink, JENKINS_TEMPLATE, KEYCHAIN_REF, jenkinsOrigin, loadInbox, saveInbox, loadOverrides, loadSettings, loadSnapshot, loadSprintCards, parseList, parseRepos, saveOverrides, saveSettings } from '../lib/store.js'

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
  'ai-fixed': 'Fixed',
  'ai-no-action': 'No action needed',
  'ai-unfixed': 'Not fixed',
}

const DECISION_LABEL = /** @type {Record<string, string>} */ ({
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  REVIEW_REQUIRED: 'Review required',
})

const state = {
  /** @type {'toReview' | 'mine' | 'signals'} */ tab: 'toReview',
  onlyPending: false,
  showWatched: true,
  staleOpen: false,
  /** @type {Snapshot | null} */ snapshot: null,
  /** @type {Set<string>} */ open: new Set(),
  /** @type {import('../lib/overrides.js').Overrides} */ overrides: {},
  jenkinsHidden: false,
  jenkinsGranted: false,
  jenkinsHasToken: false,
  claudeReady: false,
  showSignals: true,
  /** The OrgSignals tab's scorecard: 'current', or a picker key ("2026-SP19", "2026"). */
  sprintKey: 'current',
  /** @type {import('../lib/store.js').SprintCards} */ sprintCards: {},
  /** @type {Set<string>} */ sprintLoading: new Set(),
  /** @type {Record<string, string>} */ sprintErrors: {},
  /** How "Your PRs opened in …" is sorted. */
  /** @type {{col: string, dir: 'asc' | 'desc'}} */ sprintSort: { col: 'opened', dir: 'desc' },
  /** @type {import('../lib/inbox.js').InboxItem[]} */ inbox: [],
  /** Folded comments (fixed / no action needed) the user opened. */
  /** @type {Set<string>} */ unfolded: new Set(),
}

/** @param {string} origin */
const jenkinsAllowed = (origin) => chrome.permissions.contains({ origins: [`${origin}/*`] })

try {
  const saved = JSON.parse(localStorage.getItem('ui') ?? '{}')
  if (saved.tab === 'mine' || saved.tab === 'toReview' || saved.tab === 'signals') state.tab = saved.tab
  state.onlyPending = saved.onlyPending === true
  state.showWatched = saved.showWatched !== false
  state.staleOpen = saved.staleOpen === true
  if (typeof saved.sprintKey === 'string') state.sprintKey = saved.sprintKey
  if (saved.sprintSort && typeof saved.sprintSort.col === 'string' && (saved.sprintSort.dir === 'asc' || saved.sprintSort.dir === 'desc')) state.sprintSort = saved.sprintSort
} catch {
  // per-viewer convenience only
}

function remember() {
  try {
    localStorage.setItem('ui', JSON.stringify({ tab: state.tab, onlyPending: state.onlyPending, showWatched: state.showWatched, staleOpen: state.staleOpen, sprintKey: state.sprintKey, sprintSort: state.sprintSort }))
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

/**
 * Show "<prefix>5m ago" and keep it current: the ticker below rewrites every
 * element stamped this way, so the label ages while the page sits open.
 * @param {Element} el @param {string} iso @param {string} [prefix]
 */
function stamp(el, iso, prefix = '') {
  const e = /** @type {HTMLElement} */ (el)
  e.dataset.ago = iso
  e.dataset.agoPrefix = prefix
  e.textContent = prefix + ago(iso)
}

function retick() {
  for (const el of document.querySelectorAll('[data-ago]')) {
    const e = /** @type {HTMLElement} */ (el)
    const text = (e.dataset.agoPrefix ?? '') + ago(e.dataset.ago ?? '')
    if (e.textContent !== text) e.textContent = text
  }
  // "No review · 8h" and cycle time keep counting, so the buttons' colour and an open pop-up do too.
  for (const btn of document.querySelectorAll('.sig-open')) {
    const pr = signalsPR.get(btn)
    if (pr?.signals) tintSignals(/** @type {HTMLElement} */ (btn), pr.signals)
  }
  if (signalsDialog.open && shownSignals?.signals) paintSignalsDialog(shownSignals)
}

const TIER_CLASS = { ELITE: 't-elite', HIGH: 't-high', MEDIUM: 't-medium', NEEDS_FOCUS: 't-focus', NO_ACTIVITY: 't-none' }
const signalsDialog = /** @type {HTMLDialogElement} */ (document.getElementById('signals-dialog'))
/** @type {WeakMap<Element, ReviewPR>} */
const signalsPR = new WeakMap()
/** @type {ReviewPR | null} */
let shownSignals = null

/** The card's OrgSignals button, coloured by the PR's weakest tier. @param {ReviewPR & {signals: import('../lib/signals.js').SignalsFacts}} pr */
function signalsButton(pr) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = 'OrgSignals'
  signalsPR.set(btn, pr)
  tintSignals(btn, pr.signals)
  btn.addEventListener('click', (event) => {
    event.preventDefault() // inside <summary>: don't toggle the card
    event.stopPropagation()
    openSignals(pr)
  })
  return btn
}

/** @param {HTMLElement} btn @param {import('../lib/signals.js').SignalsFacts} facts */
function tintSignals(btn, facts) {
  const list = readings(facts)
  const worst = worstTier(list)
  btn.className = `chip sig-open ${TIER_CLASS[worst]}`
  btn.dataset.tier = worst
  const weak = list.filter((r) => r.tier === 'NEEDS_FOCUS').map((r) => r.label)
  btn.title = weak.length ? `OrgSignals — needs focus: ${weak.join(', ')}` : `OrgSignals — weakest tier: ${TIER_LABEL[worst]}`
}

/** @param {ReviewPR} pr */
function openSignals(pr) {
  shownSignals = pr
  paintSignalsDialog(pr)
  if (!signalsDialog.open) signalsDialog.showModal()
}

/** @param {ReviewPR} pr */
function paintSignalsDialog(pr) {
  const link = /** @type {HTMLAnchorElement} */ ($('signals-pr'))
  link.textContent = `${pr.repo}#${pr.number} ${pr.title}`
  link.href = pr.url
  const rows = $('signals-rows')
  rows.replaceChildren()
  for (const r of pr.signals ? readings(pr.signals) : []) {
    const li = document.createElement('li')
    li.className = 'sig-row'
    li.dataset.metric = r.key
    const name = document.createElement('span')
    name.className = 'sig-name'
    name.textContent = r.label
    const means = document.createElement('span')
    means.className = 'sig-means'
    means.textContent = r.means
    const val = document.createElement('span')
    val.className = 'sig-val'
    const value = document.createElement('strong')
    value.textContent = r.value
    const tier = document.createElement('span')
    tier.className = `chip ${TIER_CLASS[r.tier]}`
    tier.textContent = TIER_LABEL[r.tier]
    val.append(value, tier)
    if (r.note) {
      const note = document.createElement('span')
      note.className = 'note'
      note.textContent = r.note
      val.append(note)
    }
    const scale = document.createElement('span')
    scale.className = 'sig-scale'
    scale.textContent = r.scale
    li.append(name, val, means, scale)
    rows.append(li)
  }
}

$('signals-close').addEventListener('click', () => signalsDialog.close())
signalsDialog.addEventListener('close', () => (shownSignals = null))
{
  let pressedOutside = false
  signalsDialog.addEventListener('pointerdown', (event) => (pressedOutside = event.target === signalsDialog))
  signalsDialog.addEventListener('click', (event) => {
    if (pressedOutside && event.target === signalsDialog) signalsDialog.close()
  })
}
setInterval(retick, 30_000)
// Timers are throttled in a background tab: catch up as soon as it's back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') retick()
})

/** @param {ParentNode} root @param {string} selector @param {string} text */
function setText(root, selector, text) {
  const el = root.querySelector(selector)
  if (el) el.textContent = text
}

const BUILD_LABEL = /** @type {Record<import('../lib/analyze.js').BuildState, string>} */ ({
  success: 'passed',
  failure: 'failed',
  running: 'running',
  pending: 'queued',
  cancelled: 'cancelled',
  skipped: 'skipped',
})

/** @param {import('../lib/analyze.js').Build} build */
function buildChip(build) {
  const text = `Jenkins${build.number ? ` #${build.number}` : ''} ${BUILD_LABEL[build.state]}`
  const el = document.createElement(build.url ? 'a' : 'span')
  el.className = `chip build b-${build.state}`
  el.textContent = text
  el.title = `${build.name}${build.at ? ` · ${new Date(build.at).toLocaleString()}` : ''}`
  if (el instanceof HTMLAnchorElement && build.url) {
    el.href = build.url
    el.target = '_blank'
    el.rel = 'noopener'
    // A link inside <summary> would also expand/collapse the card.
    el.addEventListener('click', (event) => event.stopPropagation())
  }
  return el
}

/** Link to the PR's Jenkins job when GitHub doesn't report the build to this token. */
function jobChip(/** @type {string} */ url, text = 'Jenkins ↗', title = 'Build status not visible to your token — opens the PR job in Jenkins') {
  const el = document.createElement('a')
  el.className = 'chip build b-unknown'
  el.textContent = text
  el.title = title
  el.href = url
  el.target = '_blank'
  el.rel = 'noopener'
  el.addEventListener('click', (event) => event.stopPropagation())
  return el
}

/**
 * Long comments (AI reviews run to pages) start clipped with a "Show more".
 * Measured after layout, since only the browser knows the rendered height.
 *
 * @param {HTMLElement} body
 * @param {HTMLButtonElement} button
 */
function collapsible(body, button) {
  body.classList.add('clipped')
  requestAnimationFrame(() => {
    if (body.scrollHeight <= body.clientHeight + 4) {
      body.classList.remove('clipped')
      return
    }
    button.hidden = false
    button.addEventListener('click', (event) => {
      event.preventDefault()
      const open = body.classList.toggle('clipped') === false
      button.textContent = open ? 'Show less' : 'Show more'
    })
  })
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

/** Session id → project folder, from the helper; lets a comment's marker resume in the right place. */
const localCwd = new Map()

/**
 * Make `button` copy the command that resumes a Claude Code session.
 * @param {HTMLButtonElement} button
 * @param {string} sessionId
 * @param {string} [cwd]
 * @param {string} [label]  button text (default: keep it)
 */
function ccCopy(button, sessionId, cwd, label) {
  const command = resumeCommand(sessionId, cwd)
  if (label) button.textContent = label
  button.title = `${command}${cwd ? '' : '\n(run it from the project the review was done in)'}`
  button.addEventListener('click', async (event) => {
    event.preventDefault()
    event.stopPropagation()
    const before = button.textContent
    try {
      await navigator.clipboard.writeText(command)
      button.textContent = 'Copied'
    } catch {
      button.textContent = 'Copy failed'
    }
    setTimeout(() => (button.textContent = before), 1500)
  })
}

/** Watched repos as typed in Settings: gdncomm ones by bare name. */
const showRepos = (/** @type {string[]} */ repos) => repos.map((r) => r.replace(/^gdncomm\//, '')).join(', ')

/**
 * The author's GitHub avatar, or their initial when GitHub gave none.
 * @param {string} login
 * @param {string} [url]
 */
function avatar(login, url) {
  if (url && /^https:\/\//.test(url)) {
    const img = document.createElement('img')
    img.className = 'avatar'
    img.src = url
    img.alt = ''
    img.loading = 'lazy'
    return img
  }
  const span = document.createElement('span')
  span.className = 'avatar'
  span.textContent = (login[0] ?? '?').toUpperCase()
  return span
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
  if (f.judgedBy === 'claude') {
    status.classList.add('by-claude')
    status.title = 'Decided by Claude'
  }
  setText(li, '.who', f.author === viewer ? `${f.author} (you)` : f.author)
  li.querySelector('.avatar')?.replaceWith(avatar(f.author, f.avatar))
  const action =
    f.kind === 'inline'
      ? 'commented on'
      : f.kind === 'review'
        ? f.reviewState === 'APPROVED'
          ? 'approved'
          : f.reviewState === 'CHANGES_REQUESTED'
            ? 'requested changes'
            : 'reviewed'
        : 'commented'
  setText(li, '.action', action)
  const cc = /** @type {HTMLButtonElement} */ (li.querySelector('.cc'))
  if (f.viaClaudeCode) {
    cc.hidden = false
    if (f.claudeSession) ccCopy(cc, f.claudeSession, localCwd.get(f.claudeSession))
    else {
      cc.disabled = true
      cc.title = 'Written with Claude Code (no session id in the comment)'
    }
  }
  const where = li.querySelector('.where')
  if (where) {
    where.textContent = f.kind === 'inline' ? `${f.path}${f.line ? `:${f.line}` : ''}` : ''
    where.toggleAttribute('hidden', f.kind !== 'inline')
    if (f.path) where.setAttribute('title', f.path)
  }
  const when = /** @type {HTMLAnchorElement} */ (li.querySelector('.when'))
  stamp(when, f.createdAt)
  when.href = f.url
  when.title = new Date(f.createdAt).toLocaleString()
  const body = /** @type {HTMLElement} */ (li.querySelector('.body'))
  body.append(renderComment(f.bodyHTML, excerpt(f.body)))
  const more = /** @type {HTMLButtonElement} */ (li.querySelector('.more'))

  // The rest of the thread, as on GitHub: each reply with its author.
  const convo = /** @type {HTMLElement} */ (li.querySelector('.conversation'))
  for (const c of f.conversation ?? []) {
    const item = document.createElement('li')
    const head = document.createElement('div')
    head.className = 'c-head'
    const who = document.createElement('strong')
    who.textContent = c.author === viewer ? `${c.author} (you)` : c.author
    const verb = document.createElement('span')
    verb.className = 'muted'
    verb.textContent = 'replied'
    const when = document.createElement('a')
    when.className = 'muted'
    when.href = c.url
    when.target = '_blank'
    when.rel = 'noopener'
    stamp(when, c.createdAt)
    head.append(avatar(c.author, c.avatar), who, verb, when)
    const text = document.createElement('div')
    text.className = 'markdown-body'
    text.append(renderComment(c.bodyHTML, c.body))
    item.append(head, text)
    convo.append(item)
  }
  convo.hidden = !f.conversation?.length
  setText(li, '.evidence-text', f.evidence)
  li.querySelector('.evidence')?.toggleAttribute('hidden', !f.evidence)

  // Fixed and no-action comments fold to one line; the header toggles them.
  const fold = /** @type {HTMLButtonElement} */ (li.querySelector('.fold'))
  let measured = false
  const setFolded = (/** @type {boolean} */ folded) => {
    li.classList.toggle('folded', folded)
    fold.setAttribute('aria-expanded', String(!folded))
    fold.textContent = folded ? '▸' : '▾'
    fold.title = folded ? 'Show this comment' : 'Fold this comment'
    // "Show more" needs a rendered height, so measure on first unfold.
    if (!folded && !measured) {
      measured = true
      collapsible(body, more)
    }
  }
  if (f.fixed || f.noAction) {
    fold.hidden = false
    setText(li, '.preview', excerpt(f.body).replace(/\s+/g, ' ').slice(0, 140) || '(no text)')
    setFolded(!state.unfolded.has(f.id))
    const toggle = (/** @type {Event} */ event) => {
      if (/** @type {HTMLElement} */ (event.target).closest('a, button.mark')) return
      const folded = !li.classList.contains('folded')
      if (folded) state.unfolded.delete(f.id)
      else state.unfolded.add(f.id)
      setFolded(folded)
    }
    li.querySelector('.f-head')?.addEventListener('click', toggle)
    li.querySelector('.preview')?.addEventListener('click', toggle)
  } else {
    setFolded(false)
  }

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
  const meta = [showRepo ? pr.repo : '', state.tab === 'toReview' ? `by ${pr.author}` : '', 'updated ']
  const repoLine = el.querySelector('.repo')
  if (repoLine) stamp(repoLine, pr.updatedAt, meta.filter(Boolean).join(' · '))
  // My PRs: who approved, who wants changes, whose review is still pending.
  const approvals = /** @type {HTMLElement} */ (el.querySelector('.approvals'))
  const a = pr.approvals
  if (state.tab === 'mine' && a) {
    const names = (/** @type {string[]} */ list) => list.map((l) => (l.startsWith('@') ? `${l.slice(1)} (team)` : shortLogin(l, pr.repo))).join(', ')
    const rows = /** @type {[string, string, string[]][]} */ ([
      ['ap-ok', 'Approved by', a.approvedBy],
      ['ap-bad', 'Changes requested by', a.changesBy],
      ['ap-wait', 'Waiting on', a.waitingOn],
    ])
    for (const [cls, label, list] of rows) {
      if (!list.length) continue
      const row = document.createElement('span')
      row.className = `ap ${cls}`
      const b = document.createElement('b')
      b.textContent = label
      row.append(b, ` ${names(list)}`)
      if (list.includes('a team')) row.title = "GitHub hides which team from your token. Add Organization permissions → Members: Read-only to the token to see the team's name."
      approvals.append(row)
    }
    if (!a.approvedBy.length && !a.waitingOn.length && !a.changesBy.length && !pr.isDraft) {
      const row = document.createElement('span')
      row.className = 'ap ap-wait'
      row.textContent = 'No reviewer requested yet'
      approvals.append(row)
    }
    approvals.hidden = !approvals.childElementCount
  }
  const summary = /** @type {HTMLElement} */ (el.querySelector('.ai-summary'))
  const canAsk = state.claudeReady && pr.hasHumanComments
  summary.hidden = !pr.aiSummary && !canAsk
  setText(el, '.ai-summary-text', pr.aiSummary ?? '')
  const stale = /** @type {HTMLElement} */ (el.querySelector('.ai-stale'))
  stale.hidden = !(pr.aiSummary && pr.aiStale)
  summary.classList.toggle('stale', !!(pr.aiSummary && pr.aiStale))
  const mark = /** @type {HTMLElement} */ (el.querySelector('.ai-mark'))
  mark.hidden = !pr.aiSummary
  const ask = /** @type {HTMLButtonElement} */ (el.querySelector('.ai-ask'))
  ask.hidden = !canAsk || (!!pr.aiSummary && !pr.aiStale)
  ask.textContent = pr.aiSummary ? 'Summarize again' : 'Summarize with Claude'
  ask.addEventListener('click', async (event) => {
    event.preventDefault() // inside <summary>: don't toggle the card
    event.stopPropagation()
    ask.disabled = true
    ask.textContent = 'Asking Claude…'
    const result = await judgeOnePR(pr.id, { claudeCode })
    if (result.kind === 'ok') {
      // Repaint from storage ourselves: an unchanged answer raises no storage event.
      state.snapshot = await loadSnapshot()
      paint()
      return
    }
    ask.disabled = false
    ask.textContent = { 'no-helper': 'Connect Claude Code first', error: 'Failed — retry', gone: 'PR gone' }[result.kind] ?? 'Failed'
    ask.title = result.message ?? ''
    if (result.message) showError(result.message)
  })

  const chips = /** @type {HTMLElement} */ (el.querySelector('.chips'))
  const deploy = deployJenkinsLink(pr)
  if (pr.build) chips.append(buildChip(pr.build))
  else if (deploy) chips.append(jobChip(deploy.url, 'Jenkins ↗', `Finds this repo's job on ${deploy.host} (sign in to Jenkins if asked)`))
  else if (state.jenkinsHidden && !state.snapshot?.jenkinsChecked) {
    // Only guess the job link when GitHub is hiding builds from the token; a PR
    // whose builds are visible but absent (deployment repos) has no job to link.
    // The team folder (TRFCEE, SEO, …) is only known with a Jenkins token: search for the repo instead.
    const job = ciSearchLink(pr)
    if (job) chips.append(jobChip(job, 'Jenkins ↗', 'Finds this repo\'s job on Jenkins (add a Jenkins token to see pass/fail)'))
  }
  if (pr.isDraft) chips.append(chip('Draft', 'c-draft'))
  if (state.tab === 'toReview') chips.append(pr.requested ? chip('Review requested', 'c-req') : pr.watched ? chip('Watched repo', 'c-watch') : chip('Reviewed by you', 'c-muted'))
  if (pr.reviewDecision && DECISION_LABEL[pr.reviewDecision]) {
    chips.append(chip(DECISION_LABEL[pr.reviewDecision], `c-${pr.reviewDecision.toLowerCase()}`))
  }

  // Claude Code: sessions on this machine (helper), plus comments marked as written with it.
  for (const s of pr.ccSessions ?? []) localCwd.set(s.sessionId, s.cwd)
  const marked = pr.findings.some((f) => f.viaClaudeCode)
  const sessions = pr.ccSessions ?? []
  if (sessions.length || marked) {
    const reviewed = sessions.some((s) => s.kind === 'review')
    const c = chip(sessions.length ? `Claude Code · ${sessions.length}` : 'Claude Code', 'c-cc')
    c.title = sessions.length ? `${sessions.length} local session${sessions.length === 1 ? '' : 's'}${reviewed ? ', including a review' : ''} — open the card to resume one` : 'Some comments were written with Claude Code'
    chips.append(c)
  }
  const ccBox = /** @type {HTMLElement} */ (el.querySelector('.cc-sessions'))
  ccBox.hidden = !sessions.length
  const ccList = /** @type {HTMLElement} */ (ccBox.querySelector('ul'))
  for (const s of sessions) {
    const row = document.createElement('li')
    const kind = document.createElement('span')
    kind.className = `cc-kind k-${s.kind}`
    kind.textContent = s.kind === 'review' ? 'Reviewed' : 'Mentioned'
    const title = document.createElement('span')
    title.className = 'cc-title'
    title.textContent = s.title || s.sessionId
    title.title = s.sessionId
    const where = document.createElement('span')
    where.className = 'muted cc-where'
    const folder = s.cwd.split('/').pop() ?? ''
    if (s.lastAt) stamp(where, s.lastAt, folder ? `${folder} · ` : '')
    else where.textContent = folder
    where.title = s.cwd
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'cc-copy'
    ccCopy(copy, s.sessionId, s.cwd, 'Copy resume command')
    row.append(kind, title, where, copy)
    ccList.append(row)
  }

  const tally = /** @type {HTMLElement} */ (el.querySelector('.tally'))
  if (!pr.hasHumanComments) {
    tally.append(chip('No human comments', 'c-muted'))
    if (!sessions.length) details.classList.add('no-findings')
  } else {
    tally.append(chip(`${pr.counts.total} comment${pr.counts.total === 1 ? '' : 's'}`, 'c-human'))
    if (pr.counts.fixed) tally.append(chip(`${pr.counts.fixed} fixed`, 'c-fixed'))
    if (pr.counts.pending) tally.append(chip(`${pr.counts.pending} unfixed`, 'c-pending'))
    if (pr.counts.noAction) tally.append(chip(`${pr.counts.noAction} no action`, 'c-muted'))
    const list = /** @type {HTMLElement} */ (el.querySelector('.findings'))
    // Unfixed first — those are what need doing — then no-action, then fixed;
    // within each, my own comments first.
    const rank = (/** @type {Finding} */ f) => (f.fixed ? 2 : f.noAction ? 1 : 0)
    const own = (/** @type {Finding} */ f) => (f.author === viewer ? 0 : 1)
    const ordered = [...pr.findings].sort((a, b) => rank(a) - rank(b) || own(a) - own(b))
    const groups = ['Needs attention', 'No action needed', 'Fixed']
    let current = -1
    for (const f of ordered) {
      if (rank(f) !== current) {
        current = rank(f)
        const n = ordered.filter((x) => rank(x) === current).length
        const head = document.createElement('li')
        head.className = `f-group g-${current}`
        head.textContent = `${groups[current]} · ${n}`
        list.append(head)
      }
      list.append(renderFinding(f, viewer))
    }
  }
  if (state.showSignals && pr.signals) tally.append(signalsButton(/** @type {ReviewPR & {signals: import('../lib/signals.js').SignalsFacts}} */ (pr)))
  tally.append(refreshButton(pr))
  return el
}

/** ↻ on a card: fetch just this PR again. @param {ReviewPR} pr */
function refreshButton(pr) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'pr-refresh'
  btn.textContent = '↻'
  btn.title = 'Refresh this PR'
  btn.setAttribute('aria-label', `Refresh #${pr.number}`)
  btn.addEventListener('click', async (event) => {
    event.preventDefault() // inside <summary>: don't toggle the card
    event.stopPropagation()
    btn.disabled = true
    btn.classList.add('spinning')
    const result = await refreshOnePR(pr.id, { jenkinsAllowed, localSessions, claudeCode, secrets })
    btn.disabled = false
    btn.classList.remove('spinning')
    if (result.kind === 'error') {
      btn.title = `Couldn't refresh: ${result.message}`
      showError(`Couldn't refresh #${pr.number}: ${result.message}`)
      return
    }
    // Repaint from storage ourselves: when nothing changed, Chrome raises no
    // storage event, and the card would keep spinning.
    state.snapshot = await loadSnapshot()
    paint()
  })
  return btn
}

/** Hidden by the Watched repos filter? */
const shown = (/** @type {ReviewPR} */ pr) => state.showWatched || !pr.watched

/**
 * Redraw the page. The list is rebuilt from scratch, which would leave the
 * page momentarily short and snap it to the top: keep where the reader was.
 */
function paint() {
  const y = window.scrollY
  paintList()
  if (window.scrollY !== y) window.scrollTo({ top: y, behavior: 'instant' })
}

function paintList() {
  const snap = state.snapshot && applyOverrides(state.snapshot, state.overrides)
  state.jenkinsHidden = !!snap?.warnings?.some((w) => w.startsWith(JENKINS_HIDDEN))
  const list = $('list')
  const empty = $('empty')
  list.replaceChildren()

  for (const tab of /** @type {const} */ (['toReview', 'mine'])) {
    const btn = $(`tab-${tab}`)
    btn.setAttribute('aria-selected', String(state.tab === tab))
    $(`n-${tab}`).textContent = String(snap?.[tab].filter(shown).length ?? 0)
  }
  const signalsTab = $('tab-signals')
  signalsTab.hidden = !state.showSignals
  if (state.tab === 'signals' && !state.showSignals) state.tab = 'mine'
  signalsTab.setAttribute('aria-selected', String(state.tab === 'signals'))
  const overall = snap?.sprint?.card
  $('n-signals').textContent = overall ? String(overall.overall) : ''
  $('pending-filter').hidden = state.tab === 'signals'
  input('only-pending').checked = state.onlyPending
  // Watched-repo PRs (nobody asked me) can be hidden; only offered when there are some.
  const watchedCount = snap?.toReview.filter((p) => p.watched).length ?? 0
  $('watched-filter').hidden = state.tab !== 'toReview' || watchedCount === 0
  input('show-watched').checked = state.showWatched
  $('n-watched').textContent = String(watchedCount)

  const warn = $('warning')
  // With a Jenkins link to fall back on, a hidden build status isn't worth a standing banner.
  const warnings = (snap?.warnings ?? []).filter((w) => !w.startsWith(JENKINS_HIDDEN))
  warn.hidden = !warnings.length
  warn.textContent = warnings.join(' ')

  // Jenkins: while GitHub hides builds, suggest a token; with one, make sure Chrome may use it.
  const origin = jenkinsOrigin(JENKINS_TEMPLATE)
  $('jenkins-access').hidden = !(origin && state.jenkinsHidden && !state.jenkinsHasToken)
  $('jenkins-grant-needed').hidden = !(origin && state.jenkinsHasToken && !state.jenkinsGranted)
  $('jenkins-bad-token').hidden = !snap?.jenkinsBadToken
  void paintClaudeCode()
  if (origin) /** @type {HTMLAnchorElement} */ ($('jenkins-token-link')).href = `${origin}/me/configure`

  $('viewer').textContent = snap?.viewer ? `@${snap.viewer}` : ''
  if (snap) stamp($('fetched'), snap.fetchedAt, 'updated ')
  else {
    delete $('fetched').dataset.ago
    $('fetched').textContent = ''
  }

  if (!snap) {
    empty.hidden = false
    empty.textContent = 'No data yet. Add a token in Settings, then Refresh.'
    return
  }
  if (state.tab === 'signals') {
    empty.hidden = true
    list.append(renderSprint(snap.sprint))
    return
  }
  const prs = /** @type {ReviewPR[]} */ (snap[state.tab]).filter(shown).filter((p) => !state.onlyPending || p.counts.pending > 0)
  const { services, stale } = groupPRs(prs, Date.now(), snap?.viewer ?? '')
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

/** @param {string} tag @param {string} [className] @param {string} [text] */
function el(tag, className = '', text = '') {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text) e.textContent = text
  return e
}

/** @param {import('../lib/signals.js').Tier} tier */
const tierChip = (tier) => el('span', `chip ${TIER_CLASS[tier]}`, TIER_LABEL[tier])

/** WIB calendar date → "19 Oct". @param {string} date */
const shortDate = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/**
 * Score a sprint or year the page doesn't have yet (or again, with ↻). The
 * result lands in storage; the storage listener repaints.
 * @param {string} key
 */
async function requestSprint(key) {
  if (state.sprintLoading.has(key)) return
  state.sprintLoading.add(key)
  delete state.sprintErrors[key]
  paint()
  const result = await loadSprint(key, { secrets })
  state.sprintLoading.delete(key)
  if (result.kind === 'error') state.sprintErrors[key] = result.message
  else state.sprintCards = { ...state.sprintCards, [key]: result.card }
  paint()
}

/**
 * The OrgSignals tab: the picked sprint's (or year's) scorecard, with the
 * year's trend line. The current sprint comes from the refresh.
 * @param {import('../lib/sprint.js').SprintCard | undefined} current
 */
function renderSprint(current) {
  const box = el('section', 'sprint')
  box.id = 'sprint'
  const now = Date.now()
  const choices = sprintChoices(now)
  if (state.sprintKey !== 'current' && !choices.some((c) => c.key === state.sprintKey)) state.sprintKey = 'current'
  const key = state.sprintKey === 'current' ? current?.sprint.key ?? '' : state.sprintKey
  const sc = state.sprintKey === 'current' || key === current?.sprint.key ? current : state.sprintCards[key]

  const bar = el('div', 'sprint-bar')
  const pick = /** @type {HTMLSelectElement} */ (el('select', ''))
  pick.id = 'sprint-pick'
  pick.setAttribute('aria-label', 'Sprint or year to show')
  const now0 = el('option', '', `Current sprint${current ? ` (${current.sprint.name})` : ''}`)
  now0.setAttribute('value', 'current')
  pick.append(now0)
  for (const c of choices) {
    const o = el('option', '', c.label)
    o.setAttribute('value', c.key)
    pick.append(o)
  }
  pick.value = state.sprintKey
  pick.addEventListener('change', () => {
    state.sprintKey = pick.value
    remember()
    paint()
  })
  const loading = state.sprintLoading.has(key)
  const again = /** @type {HTMLButtonElement} */ (el('button', 'sprint-reload', loading ? 'Loading…' : '↻'))
  again.type = 'button'
  again.disabled = loading
  again.title = sc?.sprint.kind === 'year' ? 'Fetch this year again from GitHub' : 'Fetch this sprint again from GitHub'
  again.setAttribute('aria-label', again.title)
  again.addEventListener('click', () => (state.sprintKey === 'current' || key === current?.sprint.key ? void doRefresh() : void requestSprint(key)))
  bar.append(pick, again)
  box.append(bar)

  const year = sc?.sprint.year ?? Number(key.slice(0, 4)) ?? new Date(now).getFullYear()
  if (Number.isFinite(year) && year > 2000) box.append(renderTrend(year, current, key))

  if (state.sprintErrors[key]) box.append(el('p', 'banner error', `Couldn't load it: ${state.sprintErrors[key]}`))
  if (!sc) {
    if (key && state.sprintKey !== 'current' && !loading && !state.sprintErrors[key]) void requestSprint(key)
    box.append(el('p', 'muted empty', loading || (key && state.sprintKey !== 'current') ? (/^\d{4}$/.test(key) ? `Fetching all of ${key} from GitHub; this takes about half a minute, once…` : 'Fetching it from GitHub…') : 'No sprint scorecard yet. Refresh to compute it (the sprint calendar must cover today).'))
    return box
  }
  const s = sc.sprint
  const isYear = s.kind === 'year'
  const head = el('div', 'sprint-head')
  const title = el('div', 'sprint-title')
  const status = isYear ? `${s.days} working days${s.current ? `, ${s.day} so far` : ''}` : s.current ? `day ${s.day} of ${s.days}` : 'finished'
  const span = isYear ? `${shortDate(s.start)} ${s.start.slice(0, 4)} – ${shortDate(s.end)} ${s.end.slice(0, 4)}` : `${shortDate(s.start)} – ${shortDate(s.end)}`
  title.append(el('h2', '', isYear ? s.name : `${s.name} ${s.year}`), el('span', 'muted', `${span} · ${status}`))
  const updated = el('span', 'muted sprint-updated')
  stamp(updated, sc.computedAt, 'computed ')
  title.append(updated)
  head.append(title)
  if (sc.card) {
    const score = el('div', 'sprint-overall')
    score.dataset.tier = sc.card.overallTier
    score.append(el('strong', '', String(sc.card.overall)), el('span', 'muted', '/ 100'), tierChip(sc.card.overallTier))
    score.title = 'Overall: the plain mean of the four category scores (OrgSignals\' own weights aren\'t published, so its overall can differ).'
    head.append(score)
  }
  box.append(head)
  if (s.between) box.append(el('p', 'banner info', `${s.between.name} (${shortDate(s.between.start)} – ${shortDate(s.between.end)}): showing the last sprint.`))
  if (sc.error) box.append(el('p', 'banner warning', `Couldn't update the scorecard on the last refresh (${sc.error}); this is the previous one.`))
  if (!sc.card) {
    box.append(el('p', 'muted empty', `Nothing scored in ${s.name}: no PRs opened, merged or reviewed in the team's repos into release/*.`))
    return box
  }
  if (isYear) box.append(el('p', 'muted sprint-note', `The whole year as one window: P75s over all its PRs, per-week metrics over ${Number(s.weeks.toFixed(1))} weeks (gap and hack weeks included). OrgSignals itself scores per sprint.`))
  else if (s.current) box.append(el('p', 'muted sprint-note', `Mid-sprint: per-week metrics divide by ${s.weeks} week${s.weeks === 1 ? '' : 's'} so far, and P75s move as more PRs land.`))

  const grid = el('div', 'sprint-cats')
  for (const cat of CATEGORIES) {
    const c = sc.card.categories.find((x) => x.key === cat.key)
    if (!c) continue
    const block = el('section', 'sprint-cat')
    block.dataset.category = c.key
    const h = el('h3', '')
    h.append(el('span', '', c.label), el('span', 'sprint-pts', `${c.score} / 100`), tierChip(c.tier))
    block.append(h, metricList(cat.metrics, sc.card.metrics))
    grid.append(block)
  }
  box.append(grid)

  const context = el('details', 'sprint-context')
  context.append(el('summary', '', 'Inside cycle time (not scored)'), metricList(CONTEXT, sc.card.metrics))
  box.append(context)

  const prs = el('section', 'sprint-prs')
  prs.append(el('h3', '', `Your PRs opened in ${isYear ? s.year : s.name} (${sc.prs.length}) · ${sc.reviewedCount} reviewed for others`))
  if (sc.prs.length) {
    const table = el('table', '')
    fillPRTable(table, sc.prs)
    const wrap = el('div', 'sprint-table')
    wrap.append(table)
    prs.append(wrap)
  }
  box.append(prs)
  box.append(el('p', 'muted sig-foot', 'Computed from GitHub the way the growth-signals sprint-score skill does (P75 of your PRs, sprint calendar in WIB), for the team\'s tracked repos merging into release/* only, so it can differ from OrgSignals. Hover a metric for what it measures.'))
  return box
}

/**
 * The rows of "Your PRs opened in …", in the chosen order. A header click
 * sorts this table alone, so nothing else on the page moves.
 *
 * @param {HTMLElement} table
 * @param {SprintRow[]} prs
 */
function fillPRTable(table, prs) {
  const thead = el('tr', '')
  const { col, dir } = SPRINT_COLUMNS.some((c) => c.key === state.sprintSort.col) ? state.sprintSort : { col: 'opened', dir: /** @type {'desc'} */ ('desc') }
  for (const c of SPRINT_COLUMNS) {
    const th = el('th', '')
    th.setAttribute('aria-sort', c.key === col ? (dir === 'asc' ? 'ascending' : 'descending') : 'none')
    const btn = /** @type {HTMLButtonElement} */ (el('button', 'sort', c.label))
    btn.type = 'button'
    btn.dataset.sort = c.key
    btn.title = `Sort by ${c.label.toLowerCase()}`
    btn.addEventListener('click', () => {
      // Numbers start largest first (the PRs to look at); the PR name A → Z.
      state.sprintSort = { col: c.key, dir: c.key === col ? (dir === 'asc' ? 'desc' : 'asc') : c.key === 'pr' ? 'asc' : 'desc' }
      remember()
      fillPRTable(table, prs)
      const again = /** @type {HTMLElement | null} */ (table.querySelector(`button[data-sort="${c.key}"]`))
      again?.focus({ preventScroll: true })
    })
    th.append(btn)
    thead.append(th)
  }
  const rows = sortedPRs(prs, col, dir).map((p) => {
    const row = el('tr', '')
    const cell = el('td', 'sprint-pr')
    const a = /** @type {HTMLAnchorElement} */ (el('a', '', p.ref.replace(/^gdncomm\//, '')))
    a.href = p.url
    a.target = '_blank'
    a.rel = 'noopener'
    cell.append(a, el('span', 'muted', ` ${p.title}`))
    row.append(
      cell,
      el('td', '', p.createdAt ? shortDate(wibDate(Date.parse(p.createdAt))) : '—'),
      el('td', '', p.size.toLocaleString('en-US')),
      el('td', '', formatHours(p.codingH)),
      el('td', '', String(p.commitsAfter)),
      el('td', '', p.firstResponseH === null ? '—' : formatHours(Math.max(0.01, p.firstResponseH))),
      el('td', '', String(p.comments)),
      el('td', '', p.cycleH === null ? 'open' : formatHours(Math.max(0.01, p.cycleH))),
    )
    return row
  })
  table.replaceChildren(thead, ...rows)
}

/** The columns of "Your PRs opened in …", and what each sorts by (null sorts last). */
const SPRINT_COLUMNS = /** @type {const} */ ([
  { key: 'pr', label: 'PR' },
  { key: 'opened', label: 'Opened' },
  { key: 'size', label: 'Size' },
  { key: 'coding', label: 'Coding' },
  { key: 'after', label: 'After open' },
  { key: 'review', label: '1st review' },
  { key: 'comments', label: 'Comments' },
  { key: 'cycle', label: 'Cycle' },
])

/** @typedef {import('../lib/sprint.js').SprintCard['prs'][number]} SprintRow */
/** @type {Record<string, (p: SprintRow, i: number) => number | string | null>} */
const SPRINT_SORT = {
  pr: (p) => p.ref.toLowerCase(),
  // Cards kept before v0.12.1 have no opened time: they were stored newest first.
  opened: (p, i) => (p.createdAt ? Date.parse(p.createdAt) : -i),
  size: (p) => p.size,
  coding: (p) => p.codingH,
  after: (p) => p.commitsAfter,
  review: (p) => p.firstResponseH,
  comments: (p) => p.comments,
  cycle: (p) => p.cycleH,
}

/**
 * @param {SprintRow[]} prs
 * @param {string} col
 * @param {'asc' | 'desc'} dir
 */
function sortedPRs(prs, col, dir) {
  const value = SPRINT_SORT[col] ?? SPRINT_SORT.opened
  return prs
    .map((p, i) => ({ p, v: value(p, i), i }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1
      const c = typeof a.v === 'string' ? a.v.localeCompare(String(b.v), undefined, { numeric: true }) : a.v - /** @type {number} */ (b.v)
      return (dir === 'asc' ? c : -c) || a.i - b.i
    })
    .map((x) => x.p)
}

/**
 * Overall score per sprint of the year, from the scorecards the page has.
 * Tier bounds (55 / 70 / 85) are the only grid lines; a point opens its sprint.
 *
 * @param {number} year
 * @param {import('../lib/sprint.js').SprintCard | undefined} current
 * @param {string} selected
 */
function renderTrend(year, current, selected) {
  const sprints = sprintsOfYear(year, Date.now())
  const points = sprints.map((sp, i) => {
    const sc = sp.key === current?.sprint.key ? current : state.sprintCards[sp.key]
    return { ...sp, i, loaded: !!sc, score: sc?.card ? sc.card.overall : null, tier: sc?.card?.overallTier ?? 'NO_ACTIVITY', running: !!sc?.sprint.current }
  })
  const box = el('figure', 'sprint-trend')
  const cap = el('figcaption', '')
  cap.append(el('span', '', `Overall per sprint, ${year}`))
  const missing = points.filter((p) => !p.loaded).length
  if (missing) {
    const loadYear = /** @type {HTMLButtonElement} */ (el('button', 'sprint-load-year', state.sprintLoading.has(String(year)) ? 'Loading…' : `Load all ${year} (${missing} missing)`))
    loadYear.type = 'button'
    loadYear.disabled = state.sprintLoading.has(String(year))
    loadYear.title = `Fetch the whole of ${year} once from GitHub; that scores every sprint in it`
    loadYear.addEventListener('click', () => void requestSprint(String(year)))
    cap.append(loadYear)
  }
  box.append(cap)

  // Drawn at the width it gets, so labels stay readable on a phone.
  const W = Math.max(300, Math.min(820, ($('list').clientWidth || 640) - 34))
  const HGT = 150
  const pad = { l: 62, r: 12, t: 10, b: 22 }
  const x = (/** @type {number} */ i) => pad.l + (sprints.length < 2 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (sprints.length - 1))
  const y = (/** @type {number} */ v) => pad.t + ((100 - v) * (HGT - pad.t - pad.b)) / 100
  const NS = 'http://www.w3.org/2000/svg'
  /** @type {Element} */
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${HGT}`)
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', `Overall score per sprint in ${year}: ${points.filter((p) => p.loaded).map((p) => `${p.name} ${p.score ?? 'no activity'}`).join(', ') || 'none loaded yet'}`)
  /** @param {string} tag @param {Record<string, string | number>} attrs @param {Element} [parent] */
  const add = (tag, attrs, parent = svg) => {
    const n = document.createElementNS(NS, tag)
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v))
    parent.append(n)
    return n
  }
  for (const [v, label] of /** @type {const} */ ([[85, 'Elite'], [70, 'High'], [55, 'Medium']])) {
    add('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'trend-grid' })
    add('text', { x: pad.l - 6, y: y(v) + 3, class: 'trend-axis', 'text-anchor': 'end' }).textContent = `${label} ${v}`
  }
  add('line', { x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0), class: 'trend-base' })
  // The line breaks where a sprint isn't loaded or had no activity, rather than guessing across it.
  let run = /** @type {string[]} */ ([])
  const flush = () => {
    if (run.length > 1) add('polyline', { points: run.join(' '), class: 'trend-line' })
    run = []
  }
  for (const p of points) {
    if (p.score === null) flush()
    else run.push(`${x(p.i)},${y(p.score)}`)
  }
  flush()
  const tip = el('div', 'trend-tip')
  tip.hidden = true
  const every = Math.ceil(sprints.length / 12)
  for (const p of points) {
    if (p.i % every === 0 || p.key === selected) add('text', { x: x(p.i), y: HGT - 6, class: `trend-axis${p.key === selected ? ' trend-on' : ''}`, 'text-anchor': 'middle' }).textContent = p.name.replace('SP', '')
    if (!p.loaded) continue
    if (p.score === null) {
      // Nothing scored that sprint: a hollow mark on the baseline, not a score of 0.
      const none = add('circle', { cx: x(p.i), cy: y(0), r: 3.5, class: 'trend-none' })
      add('title', {}, none).textContent = `${p.name}: no activity`
      continue
    }
    const g = add('g', { class: `trend-pt${p.key === selected ? ' trend-on' : ''}`, 'data-key': p.key, tabindex: 0, role: 'button', 'aria-label': `${p.name}: ${p.score}, ${TIER_LABEL[p.tier]}` })
    add('circle', { cx: x(p.i), cy: y(p.score), r: 12, class: 'trend-hit' }, g)
    add('circle', { cx: x(p.i), cy: y(p.score), r: p.key === selected ? 5.5 : 4, class: `trend-dot ${TIER_CLASS[p.tier]}` }, g)
    const show = () => {
      tip.textContent = `${p.name}: ${p.score} · ${TIER_LABEL[p.tier]}${p.running ? ' (so far)' : ''}`
      tip.hidden = false
      tip.style.left = `${(x(p.i) / W) * 100}%`
      // Near an edge, hang the tip inward so it never leaves the card.
      const at = x(p.i) / W
      tip.style.transform = `translate(${at > 0.75 ? '-100%' : at < 0.25 ? '0' : '-50%'}, calc(-100% - 10px))`
      tip.style.top = `${(y(p.score ?? 0) / HGT) * 100}%`
    }
    const open = () => {
      state.sprintKey = p.key === current?.sprint.key ? 'current' : p.key
      remember()
      paint()
    }
    g.addEventListener('pointerenter', show)
    g.addEventListener('focus', show)
    g.addEventListener('pointerleave', () => (tip.hidden = true))
    g.addEventListener('blur', () => (tip.hidden = true))
    g.addEventListener('click', open)
    g.addEventListener('keydown', (event) => {
      if (/** @type {KeyboardEvent} */ (event).key === 'Enter' || /** @type {KeyboardEvent} */ (event).key === ' ') open()
    })
  }
  const plot = el('div', 'trend-plot')
  svg.setAttribute('width', String(W))
  svg.setAttribute('height', String(HGT))
  plot.append(svg, tip)
  box.append(plot)
  return box
}

/** @param {string[]} keys @param {Record<string, import('../lib/sprint.js').ScoredMetric>} metrics */
function metricList(keys, metrics) {
  const ul = el('ul', 'sig-list')
  for (const key of keys) {
    const m = metrics[key]
    if (!m) continue
    const li = el('li', 'sig-row')
    li.dataset.metric = key
    li.title = `${m.label}: ${m.means}.`
    const val = el('span', 'sig-val')
    val.append(el('strong', '', formatValue(m)), tierChip(m.tier))
    if (m.max) val.append(el('span', 'note', `${m.points}/${m.max} pts`))
    const detail = [`${m.samples} ${m.unit === '/wk' || key === 'coding_days' ? 'counted' : `sample${m.samples === 1 ? '' : 's'}`}`, m.next].filter(Boolean).join(' · ')
    li.append(el('span', 'sig-name', m.label), val, el('span', 'sig-means', m.means), el('span', 'sig-scale', detail))
    ul.append(li)
  }
  return ul
}

/** @param {string | null | undefined} message */
function showError(message) {
  const el = $('error')
  el.hidden = !message
  el.textContent = message ?? ''
}

function paintInbox() {
  const list = $('inbox-list')
  list.replaceChildren()
  for (const item of state.inbox) {
    const li = document.createElement('li')
    li.classList.toggle('unread', !item.read)
    li.dataset.key = item.key
    const a = document.createElement('a')
    a.href = item.url
    a.target = '_blank'
    a.rel = 'noopener'
    // Which list the PR is in, so "New comment" on my PR and on a review read differently.
    if (item.side) {
      const side = document.createElement('span')
      side.className = `i-side side-${item.side}`
      side.textContent = item.side === 'mine' ? 'My PR' : 'To review'
      a.append(side)
    }
    const parts = /** @type {const} */ ([['i-title', item.title], ['i-context', item.context], ['i-message', item.message]])
    for (const [cls, text] of parts) {
      if (!text) continue
      const span = document.createElement('span')
      span.className = cls
      span.textContent = text
      a.append(span)
    }
    const when = document.createElement('span')
    when.className = 'i-when'
    stamp(when, item.at)
    a.append(when)
    a.addEventListener('click', () => {
      state.inbox = markRead(state.inbox, item.key)
      paintInbox()
      void saveInbox(state.inbox)
    })
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'i-remove'
    remove.textContent = '×'
    remove.title = 'Delete this update'
    remove.setAttribute('aria-label', `Delete update: ${item.title}`)
    remove.addEventListener('click', () => {
      state.inbox = removeItem(state.inbox, item.key)
      paintInbox()
      void saveInbox(state.inbox)
    })
    const read = document.createElement('button')
    read.type = 'button'
    read.className = 'i-read'
    read.textContent = '✓'
    read.title = 'Mark as read'
    read.setAttribute('aria-label', `Mark as read: ${item.title}`)
    read.hidden = item.read
    read.addEventListener('click', () => {
      state.inbox = markRead(state.inbox, item.key)
      paintInbox()
      void saveInbox(state.inbox)
    })
    li.append(a, read, remove)
    list.append(li)
  }
  $('inbox-empty').hidden = state.inbox.length > 0
  const unread = unreadCount(state.inbox)
  const badge = $('unread')
  badge.hidden = unread === 0
  badge.textContent = String(unread)
  const readAll = /** @type {HTMLButtonElement} */ ($('inbox-read-all'))
  readAll.disabled = unread === 0
  const clear = /** @type {HTMLButtonElement} */ ($('inbox-clear'))
  clear.disabled = state.inbox.length === 0
  if (!state.inbox.length) disarmClear()
}

/** Clear all asks once more before deleting: the first click only arms it. */
let clearTimer = 0
function disarmClear() {
  clearTimeout(clearTimer)
  const clear = $('inbox-clear')
  clear.classList.remove('armed')
  clear.textContent = 'Clear all'
}

/** @param {boolean} open */
function showInbox(open) {
  $('layout').classList.toggle('show-inbox', open)
  $('toggle-inbox').setAttribute('aria-expanded', String(open))
}

// ---------------------------------------------------------------- actions

$('toggle-inbox').addEventListener('click', () => showInbox(!$('layout').classList.contains('show-inbox')))
$('inbox-close').addEventListener('click', () => showInbox(false))
$('inbox-read-all').addEventListener('click', async () => {
  state.inbox = markRead(state.inbox)
  paintInbox()
  await saveInbox(state.inbox)
})

$('inbox-clear').addEventListener('click', async () => {
  const clear = $('inbox-clear')
  if (!clear.classList.contains('armed')) {
    clear.classList.add('armed')
    clear.textContent = `Delete ${state.inbox.length}?`
    clearTimer = window.setTimeout(disarmClear, 4000)
    return
  }
  disarmClear()
  state.inbox = []
  paintInbox()
  await saveInbox(state.inbox)
  // Desktop notifications still on screen go too.
  const shown = await chrome.notifications.getAll().catch(() => ({}))
  await Promise.all(Object.keys(shown).map((id) => chrome.notifications.clear(id)))
})

async function doRefresh() {
  const btn = /** @type {HTMLButtonElement} */ ($('refresh'))
  btn.disabled = true
  btn.textContent = 'Refreshing…'
  try {
    state.snapshot = await refresh({ jenkinsAllowed, localSessions, claudeCode, secrets })
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

const settingsDialog = /** @type {HTMLDialogElement} */ ($('settings-dialog'))

/** Open Settings as a pop-up. @param {string} [focus]  id of the field to start in */
function openSettings(focus) {
  showSettingsError(null)
  if (!settingsDialog.open) settingsDialog.showModal()
  $('toggle-settings').setAttribute('aria-expanded', 'true')
  if (focus) input(focus).focus()
}

/** A problem saving, shown inside the pop-up where it can be seen. @param {string | null} message */
function showSettingsError(message) {
  const el = $('settings-error')
  el.hidden = !message
  el.textContent = message ?? ''
}

$('toggle-settings').addEventListener('click', () => openSettings())
$('settings-close').addEventListener('click', () => settingsDialog.close())
settingsDialog.addEventListener('close', () => $('toggle-settings').setAttribute('aria-expanded', 'false'))
// A click on the dimmed backdrop closes it; the form fills the dialog, so only
// the backdrop targets the dialog itself. Both ends must be outside, so a text
// selection dragged out of a field doesn't close it.
let pressedOutside = false
settingsDialog.addEventListener('pointerdown', (event) => (pressedOutside = event.target === settingsDialog))
settingsDialog.addEventListener('click', (event) => {
  if (pressedOutside && event.target === settingsDialog) settingsDialog.close()
})

$('settings').addEventListener('submit', async (event) => {
  event.preventDefault()
  // A new Jenkins token needs the Jenkins host permission. Ask first: Chrome
  // only allows the prompt synchronously inside the click, before any await.
  const typedJenkins = input('jenkins-token').value.trim()
  const origin = jenkinsOrigin(JENKINS_TEMPLATE)
  const asking = typedJenkins && origin && !state.jenkinsGranted ? chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false) : null

  const current = await loadSettings()
  const typed = input('token').value.trim()
  const watchedBox = /** @type {HTMLTextAreaElement} */ ($('watched'))
  const watchedRepos = parseRepos(parseList(watchedBox.value))
  watchedBox.value = showRepos(watchedRepos) // what will actually be searched
  const keychain = input('keychain').checked
  let token = typed || current.token
  let jenkinsToken = typedJenkins || current.jenkinsToken
  try {
    ;[token, jenkinsToken] = await placeTokens(keychain, current.keychain, { github: token, jenkins: jenkinsToken })
  } catch (error) {
    showSettingsError(`Couldn't ${keychain ? 'save to' : 'move out of'} the macOS Keychain: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`)
    return
  }
  await saveSettings({
    keychain,
    token,
    extraBots: parseList(/** @type {HTMLTextAreaElement} */ ($('bots')).value),
    refreshMinutes: Number(/** @type {HTMLSelectElement} */ ($('minutes')).value),
    notify: input('notify').checked,
    signals: input('signals').checked,
    watchedRepos,
    jenkinsUser: input('jenkins-user').value.trim(),
    jenkinsToken,
    claudeModel: /** @type {HTMLSelectElement} */ ($('claude-model')).value,
  })
  state.showSignals = input('signals').checked
  if (asking && (await asking) && origin) state.jenkinsGranted = await jenkinsAllowed(origin)
  state.jenkinsHasToken = !!(typedJenkins || current.jenkinsToken)
  input('token').value = ''
  input('jenkins-token').value = ''
  if (typedJenkins || current.jenkinsToken) input('jenkins-token').placeholder = 'Token saved — paste a new one to replace it'
  input('token').placeholder = typed || current.token ? 'Token saved — paste a new one to replace it' : 'github_pat_…'
  settingsDialog.close()
  await doRefresh()
})

/** Ask for the Jenkins host permission — must run inside the click, as a user gesture. */
async function grantJenkins() {
  const origin = jenkinsOrigin(JENKINS_TEMPLATE)
  if (!origin) return
  try {
    state.jenkinsGranted = await chrome.permissions.request({ origins: [`${origin}/*`] })
  } catch (error) {
    showError(`Can't request access to ${origin}: ${error instanceof Error ? error.message : String(error)}. Only *.gdn-app.com Jenkins hosts are supported.`)
    return
  }
  paint()
  if (state.jenkinsGranted) await doRefresh()
}
$('jenkins-grant').addEventListener('click', () => void grantJenkins())
$('jenkins-setup').addEventListener('click', () => openSettings('jenkins-user'))
/** Settings line for the Claude Code helper: connected, not installed, or off. */
async function paintClaudeCode() {
  $('cc-install').textContent = `sh native/install.sh ${chrome.runtime.id}`
  const status = $('cc-status')
  const connect = /** @type {HTMLButtonElement} */ ($('cc-connect'))
  if (!(await nativeAllowed())) {
    status.textContent = 'Not connected.'
    connect.hidden = false
    return
  }
  connect.hidden = true
  const cc = state.snapshot?.claudeCode
  status.textContent = cc?.state === 'error' ? `Connected, but the helper didn't answer: ${cc.message}. Is it installed?` : cc?.state === 'ok' ? 'Connected — sessions are looked up on every refresh.' : 'Connected — sessions show after the next refresh.'
  if (cc?.state === 'error') return
  const info = await helperInfo().catch(() => null)
  // Summaries need a company Claude plan; the helper refuses otherwise, so don't offer them.
  const account = $('claude-account')
  const current = !!info?.ok && (info.version ?? 0) >= SUMMARY_HELPER
  const allowed = current && !!info?.account?.ok
  account.textContent = !info?.ok
    ? ''
    : !current
      ? 'Summaries are off until you update the helper: re-run the install command below from the new folder (it now checks that Claude Code uses a company plan).'
      : info.account?.ok
        ? `Claude Code account: ${info.account.label} — summaries allowed.`
        : `Summaries are off: ${info.account && 'reason' in info.account ? info.account.reason : 'unknown account'}`
  account.classList.toggle('bad', !!info?.ok && !allowed)
  if (state.claudeReady !== allowed) {
    state.claudeReady = allowed
    paint()
  }
  // The Keychain needs helper v3; keep the box usable to untick it whatever happens.
  const box = input('keychain')
  box.disabled = !(info?.ok && info.keychain) && !box.checked
  $('keychain-note').textContent = info?.ok && !info.keychain ? 'Re-run the install command below to update the helper, then this can keep your tokens in the macOS Keychain.' : $('keychain-note').textContent
  if (info?.ok && (info.version ?? 1) < 2) status.textContent += ' The helper is out of date for Claude Code summaries: re-run the install command below from the new folder.'
  else if (info?.ok && !info.claude) status.textContent += " It can't find the claude command: re-run the install command from a terminal where claude works."
}

$('cc-connect').addEventListener('click', async () => {
  // Synchronous inside the click: Chrome only shows the prompt for a user gesture.
  const granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] }).catch(() => false)
  state.claudeReady = !!granted && (await claudeCode.allowed().catch(() => false))
  if (granted) await doRefresh()
  await paintClaudeCode()
})

/**
 * Where the tokens go on Save. Into the Keychain: each plain token is written
 * there and stored as KEYCHAIN_REF. Out of it: read back, then deleted there.
 * Throws before anything is saved if the helper refuses.
 *
 * @param {boolean} keychain  wanted now
 * @param {boolean} wasKeychain
 * @param {{github: string, jenkins: string}} tokens  typed, or as stored
 * @returns {Promise<[string, string]>}
 */
async function placeTokens(keychain, wasKeychain, tokens) {
  const names = /** @type {const} */ (['github', 'jenkins'])
  const out = { ...tokens }
  if (keychain) {
    for (const name of names) {
      if (!out[name] || out[name] === KEYCHAIN_REF) continue
      await secrets.set(name, out[name])
      out[name] = KEYCHAIN_REF
    }
  } else if (wasKeychain) {
    for (const name of names) if (out[name] === KEYCHAIN_REF) out[name] = await secrets.get(name)
    for (const name of names) await secrets.delete(name)
  }
  return [out.github, out.jenkins]
}

$('jenkins-token-clear').addEventListener('click', async () => {
  const current = await loadSettings()
  if (current.jenkinsToken === KEYCHAIN_REF) await secrets.delete('jenkins').catch((error) => showSettingsError(`Couldn't remove the Jenkins token from the Keychain: ${error.message}`))
  await saveSettings({ ...current, jenkinsToken: '' })
  state.jenkinsHasToken = false
  input('jenkins-token').placeholder = 'Paste an API token (optional)'
  await doRefresh()
})

for (const btn of document.querySelectorAll('[data-tab]')) {
  btn.addEventListener('click', () => {
    state.tab = /** @type {'toReview' | 'mine' | 'signals'} */ (/** @type {HTMLElement} */ (btn).dataset.tab)
    remember()
    paint()
  })
}

input('show-watched').addEventListener('change', () => {
  state.showWatched = input('show-watched').checked
  remember()
  paint()
})

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
  if (changes.sprintCards) {
    const next = changes.sprintCards.newValue
    state.sprintCards = next && typeof next === 'object' ? /** @type {any} */ (next) : {}
    if (state.tab === 'signals') paint()
  }
  if (changes.inbox) {
    state.inbox = normaliseInbox(changes.inbox.newValue)
    paintInbox()
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
  const [settings, snapshot, overrides, inbox, { lastError }, sprintCards] = await Promise.all([
    loadSettings(),
    loadSnapshot(),
    loadOverrides(),
    loadInbox(),
    chrome.storage.local.get('lastError'),
    loadSprintCards(),
  ])
  state.snapshot = snapshot
  state.sprintCards = sprintCards
  state.overrides = overrides
  state.inbox = inbox
  paintInbox()
  const bots = /** @type {HTMLTextAreaElement} */ ($('bots'))
  bots.value = settings.extraBots.join(', ')
  const watched = /** @type {HTMLTextAreaElement} */ ($('watched'))
  watched.value = showRepos(settings.watchedRepos)
  const minutes = /** @type {HTMLSelectElement} */ ($('minutes'))
  minutes.value = String(settings.refreshMinutes)
  input('notify').checked = settings.notify
  input('signals').checked = settings.signals
  state.showSignals = settings.signals
  input('jenkins-user').value = settings.jenkinsUser
  const model = /** @type {HTMLSelectElement} */ ($('claude-model'))
  model.value = settings.claudeModel
  input('keychain').checked = settings.keychain
  if (settings.keychain) input('keychain').disabled = false
  // Summarize is offered once the helper is connected and the Claude account is a company one.
  state.claudeReady = await claudeCode.allowed().catch(() => false)
  if (settings.jenkinsToken) input('jenkins-token').placeholder = 'Token saved — paste a new one to replace it'
  const origin = jenkinsOrigin(JENKINS_TEMPLATE)
  state.jenkinsGranted = origin ? await jenkinsAllowed(origin) : false
  state.jenkinsHasToken = !!(settings.jenkinsUser && settings.jenkinsToken)
  if (settings.token) input('token').placeholder = 'Token saved — paste a new one to replace it'
  showError(typeof lastError === 'string' ? lastError : null)
  paint()
  if (!settings.token) {
    openSettings()
  } else if (!snapshot || Date.now() - Date.parse(snapshot.fetchedAt) > 60_000) {
    void doRefresh()
  }
}

void init()
