// Renders public/favicon.svg into the PNG/ICO icons referenced by index.html and the PWA
// manifest. Run after changing the artwork: `pnpm --filter @kadai/web icons`.
// Uses Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH, e.g. /opt/pw-browsers).
/* global document -- used inside page.waitForFunction (browser context) */
import { Buffer } from 'node:buffer'
import console from 'node:console'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'
import { chromium } from '@playwright/test'

const publicDir = fileURLToPath(new URL('../public/', import.meta.url))
const svg = await readFile(`${publicDir}favicon.svg`, 'utf8')

// Maskable icons need the artwork inside the central 80% safe zone on a full-bleed background:
// keep the gradient definitions, draw the gradient edge to edge, scale the shop artwork down.
const body = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
const defs = /<defs>[\s\S]*<\/defs>/.exec(body)?.[0] ?? ''
const artwork = body
  .replace(defs, '')
  .replace(/<rect width="512" height="512" rx="116" fill="url\(#bg\)"\/>/, '')
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  ${defs}
  <rect width="512" height="512" fill="url(#bg)"/>
  <g transform="translate(64 64) scale(0.75)">${artwork}</g>
</svg>`

const targets = [
  { file: 'pwa-192.png', size: 192, source: svg },
  { file: 'pwa-512.png', size: 512, source: svg },
  { file: 'pwa-maskable-512.png', size: 512, source: maskableSvg },
  { file: 'apple-touch-icon.png', size: 180, source: maskableSvg },
]

const browser = await chromium.launch()
const page = await browser.newPage()

async function render(source, size) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<html><body style="margin:0;background:transparent">
      <img src="data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}"
           width="${size}" height="${size}" style="display:block"></body></html>`,
  )
  await page.waitForFunction(() => document.images[0]?.complete)
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
}

for (const t of targets) {
  await writeFile(`${publicDir}${t.file}`, await render(t.source, t.size))
  console.warn(`wrote ${t.file}`)
}

// favicon.ico with embedded PNG images (supported by every current browser).
const icoSizes = [16, 32, 48]
const images = []
for (const size of icoSizes) images.push({ size, data: await render(svg, size) })
const header = Buffer.alloc(6 + 16 * images.length)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(images.length, 4)
let offset = header.length
images.forEach((img, i) => {
  const entry = 6 + i * 16
  header.writeUInt8(img.size % 256, entry) // width (0 = 256)
  header.writeUInt8(img.size % 256, entry + 1) // height
  header.writeUInt8(0, entry + 2) // palette
  header.writeUInt8(0, entry + 3) // reserved
  header.writeUInt16LE(1, entry + 4) // colour planes
  header.writeUInt16LE(32, entry + 6) // bits per pixel
  header.writeUInt32LE(img.data.length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += img.data.length
})
await writeFile(`${publicDir}favicon.ico`, Buffer.concat([header, ...images.map((i) => i.data)]))
console.warn('wrote favicon.ico')

await browser.close()
