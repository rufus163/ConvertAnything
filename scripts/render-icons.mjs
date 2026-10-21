// Renders assets/icon.svg into the PNG icons used by the web app and native shells.
// Usage: node scripts/render-icons.mjs, then `npx tauri icon assets/icon-1024.png` for desktop icons.
// Set CHROMIUM_PATH to use a specific Chromium build.
import { chromium } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const svg = await readFile(new URL('../assets/icon.svg', import.meta.url), 'utf8')
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const page = await browser.newPage()

async function render(size, out, { square = false } = {}) {
  await page.setViewportSize({ width: size, height: size })
  // iOS and Android apply their own rounded mask, so those icons are full-bleed squares.
  const art = square ? svg.replace(/rx="\d+"/, 'rx="0"') : svg
  await page.setContent(
    `<html><body style="margin:0;width:${size}px;height:${size}px">` +
      art.replace('<svg ', `<svg style="display:block;width:${size}px;height:${size}px" `) +
      '</body></html>',
  )
  await page.screenshot({ path: out, omitBackground: !square })
  console.log('wrote', out)
}

await render(1024, 'assets/icon-1024.png')
await render(192, 'public/icon-192.png')
await render(512, 'public/icon-512.png')
await render(180, 'public/apple-touch-icon.png', { square: true })
await render(1024, 'assets/icon-ios-1024.png', { square: true })

// iOS launch screen: the icon centred on the app background.
await page.setViewportSize({ width: 2732, height: 2732 })
await page.setContent(
  `<html><body style="margin:0;width:2732px;height:2732px;display:grid;place-items:center;background:#0b0b0f">` +
    svg.replace('<svg ', '<svg style="width:360px;height:360px" ') +
    '</body></html>',
)
for (const n of ['', '-1', '-2']) {
  const out = `ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732${n}.png`
  await page.screenshot({ path: out })
  console.log('wrote', out)
}
await browser.close()
