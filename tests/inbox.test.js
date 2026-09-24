import assert from 'node:assert/strict'
import { it } from 'node:test'

import { addEvents, INBOX_LIMIT, markRead, normaliseInbox, unreadCount } from '../lib/inbox.js'

const ev = (/** @type {string} */ key) => ({ key, url: 'https://github.com/o/r/pull/1', title: key, context: '', message: '' })

it('adds newest first, unread, without duplicates', () => {
  let inbox = addEvents([], [ev('a')], '2026-01-01T00:00:00Z')
  inbox = addEvents(inbox, [ev('b'), ev('a')], '2026-01-02T00:00:00Z')
  assert.deepEqual(inbox.map((i) => [i.key, i.at, i.read]), [['b', '2026-01-02T00:00:00Z', false], ['a', '2026-01-02T00:00:00Z', false]])
  assert.equal(unreadCount(inbox), 2)
})

it('caps the history', () => {
  const many = Array.from({ length: INBOX_LIMIT + 20 }, (_, i) => ev(`k${i}`))
  assert.equal(addEvents([], many).length, INBOX_LIMIT)
})

it('marks one or all read', () => {
  const inbox = addEvents([], [ev('a'), ev('b')])
  assert.equal(unreadCount(markRead(inbox, 'a')), 1)
  assert.equal(unreadCount(markRead(inbox)), 0)
})

it('drops malformed or non-https entries from storage', () => {
  assert.deepEqual(normaliseInbox('x'), [])
  assert.equal(normaliseInbox([{ ...ev('a'), at: '', read: false }, { ...ev('b'), url: 'javascript:1' }, null]).length, 1)
})
