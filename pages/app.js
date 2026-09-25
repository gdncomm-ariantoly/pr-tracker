import { groupPRs, STALE_DAYS } from '../lib/group.js'
import { renderComment } from './markdown.js'
import { markRead, normaliseInbox, removeItem, unreadCount } from '../lib/inbox.js'
import { applyOverrides, toggleOverride } from '../lib/overrides.js'
import { refresh } from '../lib/refresh.js'
import { shortLogin } from '../lib/notify.js'
import { JENKINS_HIDDEN } from '../lib/github.js'
import { CLAUDE_ORIGIN } from '../lib/claude.js'
import { resumeCommand } from '../lib/sessions.js'
import { localSessions, nativeAllowed } from '../platform.js'
import { deployJenkinsLink, JENKINS_TEMPLATE, jenkinsJobUrl, jenkinsOrigin, loadInbox, saveInbox, loadOverrides, loadSettings, loadSnapshot, parseList, parseRepos, saveOverrides, saveSettings } from '../lib/store.js'

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
  /** @type {'toReview' | 'mine'} */ tab: 'toReview',
  onlyPending: false,
  showWatched: true,
  staleOpen: false,
  /** @type {Snapshot | null} */ snapshot: null,
  /** @type {Set<string>} */ open: new Set(),
  /** @type {import('../lib/overrides.js').Overrides} */ overrides: {},
  jenkinsHidden: false,
  jenkinsGranted: false,
  jenkinsHasToken: false,
  /** @type {import('../lib/inbox.js').InboxItem[]} */ inbox: [],
  /** Folded comments (fixed / no action needed) the user opened. */
  /** @type {Set<string>} */ unfolded: new Set(),
}

/** @param {string} origin */
const jenkinsAllowed = (origin) => chrome.permissions.contains({ origins: [`${origin}/*`] })

try {
  const saved = JSON.parse(localStorage.getItem('ui') ?? '{}')
  if (saved.tab === 'mine' || saved.tab === 'toReview') state.tab = saved.tab
  state.onlyPending = saved.onlyPending === true
  state.showWatched = saved.showWatched !== false
  state.staleOpen = saved.staleOpen === true
} catch {
  // per-viewer convenience only
}

function remember() {
  try {
    localStorage.setItem('ui', JSON.stringify({ tab: state.tab, onlyPending: state.onlyPending, showWatched: state.showWatched, staleOpen: state.staleOpen }))
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
  when.textContent = ago(f.createdAt)
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
    when.textContent = ago(c.createdAt)
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
  const meta = [showRepo ? pr.repo : '', state.tab === 'toReview' ? `by ${pr.author}` : '', `updated ${ago(pr.updatedAt)}`]
  setText(el, '.repo', meta.filter(Boolean).join(' · '))
  // My PRs: who approved, who wants changes, whose review is still pending.
  const approvals = /** @type {HTMLElement} */ (el.querySelector('.approvals'))
  const a = pr.approvals
  if (state.tab === 'mine' && a) {
    const names = (/** @type {string[]} */ list) => list.map((l) => (l.startsWith('@') ? l : shortLogin(l, pr.repo))).join(', ')
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
  summary.hidden = !pr.aiSummary
  setText(el, '.ai-summary-text', pr.aiSummary ?? '')

  const chips = /** @type {HTMLElement} */ (el.querySelector('.chips'))
  const deploy = deployJenkinsLink(pr)
  if (pr.build) chips.append(buildChip(pr.build))
  else if (deploy) chips.append(jobChip(deploy.url, 'Jenkins ↗', `Finds this repo's job on ${deploy.host} (sign in to Jenkins if asked)`))
  else if (state.jenkinsHidden && !state.snapshot?.jenkinsChecked) {
    // Only guess the job link when GitHub is hiding builds from the token; a PR
    // whose builds are visible but absent (deployment repos) has no job to link.
    const job = jenkinsJobUrl(JENKINS_TEMPLATE, pr)
    if (job) chips.append(jobChip(job))
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
    where.textContent = [s.cwd.split('/').pop(), s.lastAt ? ago(s.lastAt) : ''].filter(Boolean).join(' · ')
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
    // Unfixed first — those are what need doing — then no-action, then fixed.
    const rank = (/** @type {Finding} */ f) => (f.fixed ? 2 : f.noAction ? 1 : 0)
    const ordered = [...pr.findings].sort((a, b) => rank(a) - rank(b))
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
  return el
}

/** Hidden by the Watched repos filter? */
const shown = (/** @type {ReviewPR} */ pr) => state.showWatched || !pr.watched

function paint() {
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
  $('claude-bad-key').hidden = snap?.claude?.state !== 'bad-key'
  void paintClaudeCode()
  $('claude-grant-needed').hidden = snap?.claude?.state !== 'no-access'
  if (origin) /** @type {HTMLAnchorElement} */ ($('jenkins-token-link')).href = `${origin}/me/configure`

  $('viewer').textContent = snap?.viewer ? `@${snap.viewer}` : ''
  $('fetched').textContent = snap ? `updated ${ago(snap.fetchedAt)}` : ''

  if (!snap) {
    empty.hidden = false
    empty.textContent = 'No data yet. Add a token in Settings, then Refresh.'
    return
  }
  const prs = /** @type {ReviewPR[]} */ (snap[state.tab]).filter(shown).filter((p) => !state.onlyPending || p.counts.pending > 0)
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
    const parts = /** @type {const} */ ([['i-title', item.title], ['i-context', item.context], ['i-message', item.message], ['i-when', ago(item.at)]])
    for (const [cls, text] of parts) {
      if (!text) continue
      const span = document.createElement('span')
      span.className = cls
      span.textContent = text
      a.append(span)
    }
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
    li.append(a, remove)
    list.append(li)
  }
  $('inbox-empty').hidden = state.inbox.length > 0
  const unread = unreadCount(state.inbox)
  const badge = $('unread')
  badge.hidden = unread === 0
  badge.textContent = String(unread)
  const readAll = /** @type {HTMLButtonElement} */ ($('inbox-read-all'))
  readAll.disabled = unread === 0
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

async function doRefresh() {
  const btn = /** @type {HTMLButtonElement} */ ($('refresh'))
  btn.disabled = true
  btn.textContent = 'Refreshing…'
  try {
    state.snapshot = await refresh({ jenkinsAllowed, claudeAllowed: jenkinsAllowed, localSessions })
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
  // A new Jenkins token needs the Jenkins host permission. Ask first: Chrome
  // only allows the prompt synchronously inside the click, before any await.
  const typedJenkins = input('jenkins-token').value.trim()
  const origin = jenkinsOrigin(JENKINS_TEMPLATE)
  const typedClaude = input('claude-key').value.trim()
  // One prompt for everything newly needed: Chrome allows a single request per click.
  const origins = [
    ...(typedJenkins && origin && !state.jenkinsGranted ? [`${origin}/*`] : []),
    ...(typedClaude ? [`${CLAUDE_ORIGIN}/*`] : []),
  ]
  const asking = origins.length ? chrome.permissions.request({ origins }).catch(() => false) : null

  const current = await loadSettings()
  const typed = input('token').value.trim()
  const watchedBox = /** @type {HTMLTextAreaElement} */ ($('watched'))
  const watchedRepos = parseRepos(parseList(watchedBox.value))
  watchedBox.value = showRepos(watchedRepos) // what will actually be searched
  await saveSettings({
    token: typed || current.token,
    extraBots: parseList(/** @type {HTMLTextAreaElement} */ ($('bots')).value),
    refreshMinutes: Number(/** @type {HTMLSelectElement} */ ($('minutes')).value),
    notify: input('notify').checked,
    watchedRepos,
    jenkinsUser: input('jenkins-user').value.trim(),
    jenkinsToken: typedJenkins || current.jenkinsToken,
    claudeKey: typedClaude || current.claudeKey,
    claudeModel: /** @type {HTMLSelectElement} */ ($('claude-model')).value,
  })
  if (asking && (await asking) && origin) state.jenkinsGranted = await jenkinsAllowed(origin)
  input('claude-key').value = ''
  if (typedClaude || current.claudeKey) input('claude-key').placeholder = 'Key saved — paste a new one to replace it'
  state.jenkinsHasToken = !!(typedJenkins || current.jenkinsToken)
  input('token').value = ''
  input('jenkins-token').value = ''
  if (typedJenkins || current.jenkinsToken) input('jenkins-token').placeholder = 'Token saved — paste a new one to replace it'
  input('token').placeholder = typed || current.token ? 'Token saved — paste a new one to replace it' : 'github_pat_…'
  $('settings').hidden = true
  $('toggle-settings').setAttribute('aria-expanded', 'false')
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
$('jenkins-setup').addEventListener('click', () => {
  $('settings').hidden = false
  $('toggle-settings').setAttribute('aria-expanded', 'true')
  input('jenkins-user').focus()
})
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
}

$('cc-connect').addEventListener('click', async () => {
  // Synchronous inside the click: Chrome only shows the prompt for a user gesture.
  const granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] }).catch(() => false)
  if (granted) await doRefresh()
  await paintClaudeCode()
})

$('claude-key-clear').addEventListener('click', async () => {
  await saveSettings({ ...(await loadSettings()), claudeKey: '' })
  input('claude-key').placeholder = 'Anthropic API key, sk-ant-…'
  await doRefresh()
})

$('claude-grant').addEventListener('click', async () => {
  // Synchronous inside the click: Chrome only shows the prompt for a user gesture.
  const granted = await chrome.permissions.request({ origins: [`${CLAUDE_ORIGIN}/*`] }).catch(() => false)
  if (granted) await doRefresh()
})

$('jenkins-token-clear').addEventListener('click', async () => {
  await saveSettings({ ...(await loadSettings()), jenkinsToken: '' })
  state.jenkinsHasToken = false
  input('jenkins-token').placeholder = 'Paste an API token (optional)'
  await doRefresh()
})

for (const btn of document.querySelectorAll('[data-tab]')) {
  btn.addEventListener('click', () => {
    state.tab = /** @type {'toReview' | 'mine'} */ (/** @type {HTMLElement} */ (btn).dataset.tab)
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
  const [settings, snapshot, overrides, inbox, { lastError }] = await Promise.all([
    loadSettings(),
    loadSnapshot(),
    loadOverrides(),
    loadInbox(),
    chrome.storage.local.get('lastError'),
  ])
  state.snapshot = snapshot
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
  input('jenkins-user').value = settings.jenkinsUser
  const model = /** @type {HTMLSelectElement} */ ($('claude-model'))
  model.value = settings.claudeModel
  if (settings.claudeKey) input('claude-key').placeholder = 'Key saved — paste a new one to replace it'
  if (settings.jenkinsToken) input('jenkins-token').placeholder = 'Token saved — paste a new one to replace it'
  const origin = jenkinsOrigin(JENKINS_TEMPLATE)
  state.jenkinsGranted = origin ? await jenkinsAllowed(origin) : false
  state.jenkinsHasToken = !!(settings.jenkinsUser && settings.jenkinsToken)
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
