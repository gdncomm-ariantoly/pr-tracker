import assert from 'node:assert/strict'
import { it } from 'node:test'

import { groupPRs, serviceName, tier } from '../lib/group.js'

const NOW = Date.parse('2026-09-24T12:00:00Z')
/** @param {string} id @param {string} repo @param {string} updatedAt @param {[number, number]} [c] total, pending */
const pr = (id, repo, updatedAt, c = [0, 0]) => ({ id, repo, updatedAt, counts: { total: c[0], pending: c[1] } })

it('names a service by its repository, without the org', () => {
  assert.equal(serviceName('gdncomm/seo-backend'), 'seo-backend')
})

it('ranks unfixed over commented over quiet', () => {
  assert.deepEqual([tier(pr('a', 'o/x', '', [3, 1])), tier(pr('b', 'o/x', '', [3, 0])), tier(pr('c', 'o/x', ''))], [0, 1, 2])
})

it('within a service: unfixed first, then commented, then quiet; newest first inside each', () => {
  const { services } = groupPRs([
    pr('quiet-new', 'o/svc', '2026-09-24T10:00:00Z'),
    pr('commented', 'o/svc', '2026-09-22T00:00:00Z', [2, 0]),
    pr('unfixed-old', 'o/svc', '2026-09-20T00:00:00Z', [4, 1]),
    pr('unfixed-new', 'o/svc', '2026-09-23T00:00:00Z', [1, 1]),
  ], NOW)
  assert.deepEqual(services[0].prs.map((p) => p.id), ['unfixed-new', 'unfixed-old', 'commented', 'quiet-new'])
})

it('services follow their most urgent PR, then recency, then name', () => {
  const { services } = groupPRs([
    pr('a', 'o/alpha', '2026-09-24T11:00:00Z'), // quiet but newest
    pr('b', 'o/beta', '2026-09-20T00:00:00Z', [1, 1]), // unfixed
    pr('c', 'o/gamma', '2026-09-23T00:00:00Z', [1, 0]), // commented
    pr('d', 'o/delta', '2026-09-22T00:00:00Z', [1, 0]), // commented, older
  ], NOW)
  assert.deepEqual(services.map((g) => g.name), ['beta', 'gamma', 'delta', 'alpha'])
})

it('moves PRs with no activity for more than 7 days to Stale, same order inside', () => {
  const { services, stale } = groupPRs([
    pr('fresh', 'o/x', '2026-09-17T13:00:00Z'), // 6d23h ago
    pr('old', 'o/x', '2026-09-17T11:00:00Z'), // 7d1h ago
    pr('older-unfixed', 'o/y', '2026-08-01T00:00:00Z', [1, 1]),
  ], NOW)
  assert.deepEqual(services.map((g) => g.name), ['x'])
  assert.deepEqual(stale.map((p) => p.id), ['older-unfixed', 'old'])
})

it('puts prod-* and nonprod-* deployment repos after every service, however urgent', () => {
  const { services } = groupPRs([
    pr('deploy-urgent', 'o/prod-seo-backend', '2026-09-24T11:00:00Z', [2, 2]),
    pr('np', 'o/nonprod-seo-backend', '2026-09-24T11:30:00Z', [1, 1]),
    pr('svc-quiet', 'o/seo-backend', '2026-09-23T10:00:00Z'),
  ], NOW)
  assert.deepEqual(services.map((g) => g.name), ['seo-backend', 'nonprod-seo-backend', 'prod-seo-backend'])
})
