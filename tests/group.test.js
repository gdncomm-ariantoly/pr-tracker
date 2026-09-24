import assert from 'node:assert/strict'
import { it } from 'node:test'

import { groupPRs, serviceName } from '../lib/group.js'

const NOW = Date.parse('2026-09-24T12:00:00Z')
const pr = (/** @type {string} */ id, /** @type {string} */ repo, /** @type {string} */ updatedAt) => ({ id, repo, updatedAt })

it('names a service by its repository, without the org', () => {
  assert.equal(serviceName('gdncomm/seo-backend'), 'seo-backend')
})

it('groups by service, alphabetically, newest PR first', () => {
  const { services, stale } = groupPRs([
    pr('a', 'gdncomm/seo-backend', '2026-09-20T00:00:00Z'),
    pr('b', 'gdncomm/product-feed', '2026-09-23T00:00:00Z'),
    pr('c', 'gdncomm/seo-backend', '2026-09-24T00:00:00Z'),
  ], NOW)
  assert.deepEqual(services.map((g) => [g.name, g.prs.map((p) => p.id)]), [['product-feed', ['b']], ['seo-backend', ['c', 'a']]])
  assert.deepEqual(stale, [])
})

it('moves PRs with no activity for more than 7 days to Stale', () => {
  const { services, stale } = groupPRs([
    pr('fresh', 'o/x', '2026-09-17T13:00:00Z'), // 6d23h ago
    pr('old', 'o/x', '2026-09-17T11:00:00Z'), // 7d1h ago
    pr('older', 'o/y', '2026-08-01T00:00:00Z'),
  ], NOW)
  assert.deepEqual(services.map((g) => g.name), ['x'])
  assert.deepEqual(stale.map((p) => p.id), ['old', 'older'])
})
