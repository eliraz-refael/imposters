// Renders the committed raster assets: public/og.png (from scripts/og.html), and
// public/apple-touch-icon.png and public/favicon-32.png (from public/favicon.svg).
//
// Run by hand after changing a source; the build does not run it. It needs playwright-core
// (not a site dependency) and a local Chrome:
//   npx -y -p playwright-core node scripts/render-assets.mjs
import { chromium } from "playwright-core"
import { readFileSync } from "node:fs"

const here = (path) => new URL(path, import.meta.url)
const browser = await chromium.launch({ channel: "chrome", headless: true })

const og = await browser.newPage({ viewport: { width: 1200, height: 630 } })
await og.goto(here("./og.html").href)
await og.evaluate(() => document.fonts.ready)
await og.screenshot({ path: here("../public/og.png").pathname })

const svg = readFileSync(here("../public/favicon.svg"), "utf8")
for (const [size, file] of [[180, "apple-touch-icon.png"], [32, "favicon-32.png"]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
  )
  await page.screenshot({ path: here(`../public/${file}`).pathname, omitBackground: true })
}

await browser.close()
console.log("rendered og.png, apple-touch-icon.png, favicon-32.png")
