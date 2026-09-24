/**
 * Renders icons/icon.svg to the PNG sizes Chrome wants.
 *   node tools/make-icons.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(path.join(ROOT, 'icons/icon.svg'), 'utf8')
const browser = await chromium.launch({ channel: 'chromium' })
const page = await browser.newPage()
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`)
  await page.locator('img').screenshot({ path: path.join(ROOT, `icons/icon-${size}.png`), omitBackground: true })
}
await browser.close()
