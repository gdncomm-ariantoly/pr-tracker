import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL } from './claude.js'
import { normaliseInbox } from './inbox.js'

/**
 * Settings and the last fetched snapshot, in chrome.storage.local. The storage
 * area is an argument so tests pass a plain object.
 */

/** @typedef {{token: string, extraBots: string[], refreshMinutes: number, notify: boolean, jenkinsUser: string, jenkinsToken: string, watchedRepos: string[], claudeKey: string, claudeModel: string, claudeAuto: boolean}} Settings */
/** @typedef {{get: (key: string) => Promise<Record<string, unknown>>, set: (items: Record<string, unknown>) => Promise<void>}} AreaLike */

/** @type {Settings} */
/** Where our Jenkins keeps PR jobs; {repo} and {number} are filled in per PR. */
export const JENKINS_TEMPLATE = 'https://jenkins-build-ci-2.gdn-app.com/job/GitHub/job/gdncomm/job/GDN/job/TRFCEE/job/{repo}/job/PR-{number}/'

export const DEFAULTS = { token: '', extraBots: [], refreshMinutes: 15, notify: true, jenkinsUser: '', jenkinsToken: '', watchedRepos: [], claudeKey: '', claudeModel: DEFAULT_CLAUDE_MODEL, claudeAuto: false }

/** @returns {AreaLike} */
function defaultArea() {
  return chrome.storage.local
}

/**
 * @param {unknown} value
 * @returns {Settings}
 */
export function normalise(value) {
  if (!value || typeof value !== 'object') return { ...DEFAULTS, extraBots: [], watchedRepos: [] }
  const raw = /** @type {Record<string, unknown>} */ (value)
  const minutes = Number(raw.refreshMinutes)
  return {
    token: typeof raw.token === 'string' ? raw.token.trim() : '',
    extraBots: Array.isArray(raw.extraBots)
      ? raw.extraBots.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().toLowerCase())
      : [],
    refreshMinutes: Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440 ? minutes : DEFAULTS.refreshMinutes,
    notify: typeof raw.notify === 'boolean' ? raw.notify : DEFAULTS.notify,
    jenkinsUser: typeof raw.jenkinsUser === 'string' ? raw.jenkinsUser.trim() : '',
    jenkinsToken: typeof raw.jenkinsToken === 'string' ? raw.jenkinsToken.trim() : '',
    claudeKey: typeof raw.claudeKey === 'string' ? raw.claudeKey.trim() : '',
    claudeModel: typeof raw.claudeModel === 'string' && /** @type {readonly string[]} */ (CLAUDE_MODELS).includes(raw.claudeModel) ? raw.claudeModel : DEFAULT_CLAUDE_MODEL,
    claudeAuto: raw.claudeAuto === true,
    watchedRepos: Array.isArray(raw.watchedRepos) ? parseRepos(raw.watchedRepos.filter((s) => typeof s === 'string')) : [],
  }
}

export const WATCH_ORG = 'gdncomm'
export const WATCH_LIMIT = 20

/**
 * Watched repositories as "owner/name", lower-cased and de-duplicated. A bare
 * name means a gdncomm repo; a pasted github.com URL is accepted too. Anything
 * else is dropped: it goes into a search query.
 *
 * @param {string[]} items
 * @returns {string[]}
 */
export function parseRepos(items) {
  const out = new Set()
  for (const item of items) {
    const s = item.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '').replace(/\.git$/i, '')
    const full = s.includes('/') ? s.split('/').slice(0, 2).join('/') : `${WATCH_ORG}/${s}`
    if (/^[\w.-]+\/[\w.-]+$/.test(full)) out.add(full.toLowerCase())
  }
  return [...out].slice(0, WATCH_LIMIT)
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

/**
 * @param {AreaLike} [area]
 * @returns {Promise<import('./overrides.js').Overrides>}
 */
export async function loadOverrides(area = defaultArea()) {
  const { overrides } = await area.get('overrides')
  if (!overrides || typeof overrides !== 'object') return {}
  return Object.fromEntries(Object.keys(overrides).filter((k) => typeof k === 'string' && k).map((k) => [k, true]))
}

/** @typedef {Record<string, {sig: string, at: string, judgement: import('./claude.js').Judgement, stale?: boolean}>} ClaudeCache  PR id → last judgement */

/** @param {AreaLike} [area] @returns {Promise<ClaudeCache>} */
export async function loadClaudeCache(area = defaultArea()) {
  const { claudeCache } = await area.get('claudeCache')
  return claudeCache && typeof claudeCache === 'object' ? /** @type {ClaudeCache} */ (claudeCache) : {}
}

/** @param {ClaudeCache} claudeCache @param {AreaLike} [area] */
export async function saveClaudeCache(claudeCache, area = defaultArea()) {
  await area.set({ claudeCache })
}

/** @param {import('./overrides.js').Overrides} overrides @param {AreaLike} [area] */
export async function saveOverrides(overrides, area = defaultArea()) {
  await area.set({ overrides })
}

/**
 * Deployment repos are run by the prod / non-prod Jenkins, which never report
 * PR builds to GitHub and don't live on the CI host the template points at.
 * Guessing a CI job for them only produces dead links and 404 lookups.
 */
export const NO_CI_REPO = /^(?:prod|nonprod)-/i

/** Test-automation repos (cucumber-*): no Jenkins job to look up or link. */
export const NO_JENKINS_REPO = /^cucumber-/i

/** @param {{repo: string}} pr */
export function skipsJenkins(pr) {
  return NO_JENKINS_REPO.test(pr.repo.split('/').pop() ?? '')
}

/**
 * Which Jenkins runs a deployment repo. These never report to GitHub and
 * don't let anonymous users list jobs, and folder paths differ per team — so
 * the link is that Jenkins's own search for the repo name. Signed in, a unique
 * match lands straight on the job.
 */
export const DEPLOY_JENKINS = /** @type {const} */ ([
  [/^prod-infra-/i, 'https://jenkins-prod-infra.gdn-app.com'],
  [/^prod-/i, 'https://jenkins-prod-deploy.gdn-app.com'],
  [/^nonprod-/i, 'https://jenkins-np-deploy.gdn-app.com'],
])

/** @param {{repo: string}} pr @returns {{host: string, url: string} | null} */
export function deployJenkinsLink(pr) {
  const name = pr.repo.split('/').pop() ?? ''
  const rule = DEPLOY_JENKINS.find(([re]) => re.test(name))
  return rule ? { host: new URL(rule[1]).host, url: `${rule[1]}/search/?q=${encodeURIComponent(name)}` } : null
}

/**
 * The PR's Jenkins job page from the template, for when GitHub will not show
 * the build itself.
 *
 * @param {string} template
 * @param {{repo: string, number: number}} pr
 */
export function jenkinsJobUrl(template, pr) {
  if (!template || skipsJenkins(pr) || NO_CI_REPO.test(pr.repo.split('/').pop() ?? '')) return null
  const repo = encodeURIComponent(pr.repo.split('/').pop() ?? '')
  return template.replaceAll('{repo}', repo).replaceAll('{number}', String(pr.number))
}

/** The Jenkins origin the template points at, for the host permission. */
export function jenkinsOrigin(/** @type {string} */ template) {
  if (!template) return null
  try {
    return new URL(template.replace(/\{\w+\}/g, 'x')).origin
  } catch {
    return null
  }
}

/** @param {AreaLike} [area] */
export async function loadInbox(area = defaultArea()) {
  // Static import (top of file): dynamic import() is not allowed in an extension service worker.
  return normaliseInbox((await area.get('inbox')).inbox)
}

/** @param {import('./inbox.js').InboxItem[]} inbox @param {AreaLike} [area] */
export async function saveInbox(inbox, area = defaultArea()) {
  await area.set({ inbox })
}
