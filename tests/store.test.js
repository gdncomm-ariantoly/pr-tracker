import assert from 'node:assert/strict'
import { it } from 'node:test'

import { DEFAULTS, normalise, parseList } from '../lib/store.js'

it('normalises settings', () => {
  assert.deepEqual(normalise(undefined), DEFAULTS)
  assert.deepEqual(normalise({ token: ' x ', extraBots: ['Jenkins', 3, ''], refreshMinutes: -5 }), {
    token: 'x', extraBots: ['jenkins'], refreshMinutes: 15,
  })
})

it('parses a comma/newline list', () => {
  assert.deepEqual(parseList('a, b\n c,,'), ['a', 'b', 'c'])
})
