/**
 * The sample GitHub response the browser checks replay, with its timestamps
 * moved forward so the data is as fresh today as the day it was captured.
 * Without this the fixture ages: past STALE_DAYS every PR folds into the
 * collapsed Stale group and the checks that click a card fail.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
export const FIXTURE_FILE = path.join(ROOT, 'tests/fixtures/dashboard.json')

/** When tests/fixtures/dashboard.json was "now": the day after its newest update. */
const CAPTURED = Date.parse('2026-09-24T00:00:00Z')
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/

/**
 * @param {string} [file]  a real capture (FIXTURE=…) is replayed as is
 * @returns {any}
 */
export function loadFixture(file = FIXTURE_FILE) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  if (file !== FIXTURE_FILE) return data
  const shift = Date.now() - CAPTURED
  return JSON.parse(JSON.stringify(data), (_key, value) =>
    typeof value === 'string' && ISO.test(value) ? new Date(Date.parse(value) + shift).toISOString() : value,
  )
}
