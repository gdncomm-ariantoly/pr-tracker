import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { it } from 'node:test'

// No semicolons in this codebase, so a line that *starts* with "(" is glued
// onto the line before it: `a = b\n/** @type {X} */ (el).x = 1` parses as
// `a = b(el).x = 1`. It has shipped twice; keep it out.
it('no statement starts with a parenthesised JSDoc cast', () => {
  const files = ['background.js', ...['lib', 'pages'].flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.js')).map((f) => `${d}/${f}`))]
  const hits = files.flatMap((file) => {
    const lines = readFileSync(file, 'utf8').split('\n')
    return lines.flatMap((line, i) => {
      if (!/^\s*(?:\/\*\*[^*]*\*\/\s*)?\(/.test(line)) return []
      // Safe when the previous line can't end a statement: inside a call, array, operator…
      const prev = lines.slice(0, i).reverse().find((l) => l.trim() && !l.trim().startsWith('//'))?.trim() ?? ''
      return /[([{,=&|?:+\-*/<>!]$/.test(prev) ? [] : [`${file}:${i + 1}: ${line.trim()}`]
    })
  })
  assert.deepEqual(hits, [])
})
