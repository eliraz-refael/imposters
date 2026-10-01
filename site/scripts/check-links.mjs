// Crawls the built site in dist/ and fails on any internal link or asset that does not resolve,
// including #fragments that name no element on the target page. Run after `bun run build`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const BASE = "/imposters/"
const ORIGIN = "https://eliraz-refael.github.io"
const dist = fileURLToPath(new URL("../dist/", import.meta.url))

const htmlFiles = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? htmlFiles(path) : name.endsWith(".html") ? [path] : []
  })

// The URL path a file is served at: dist/docs/cli/index.html is /imposters/docs/cli/
const urlOf = (file) => BASE + relative(dist, file).replace(/index\.html$/, "").split("\\").join("/")

// The file a URL path is served from, if any
const fileFor = (pathname) => {
  if (!pathname.startsWith(BASE)) return undefined
  const rest = decodeURIComponent(pathname.slice(BASE.length))
  const candidates = rest === "" || rest.endsWith("/")
    ? [join(dist, rest, "index.html")]
    : [join(dist, rest), join(dist, rest, "index.html")]
  return candidates.find((path) => existsSync(path) && statSync(path).isFile())
}

const idsCache = new Map()
const idsOf = (file) => {
  if (!idsCache.has(file)) {
    const html = readFileSync(file, "utf8")
    idsCache.set(file, new Set(Array.from(html.matchAll(/\sid="([^"]+)"/g), (m) => m[1])))
  }
  return idsCache.get(file)
}

// content="..." holds a URL only in meta tags such as og:image, so only absolute ones count there
const ATTR = /\s(?:href|src|srcset)="([^"]+)"|\scontent="(https?:[^"]+)"/g
const problems = []
let checked = 0

for (const file of htmlFiles(dist)) {
  const pageUrl = new URL(urlOf(file), ORIGIN)
  const html = readFileSync(file, "utf8")
  for (const [, attrValue, contentValue] of html.matchAll(ATTR)) {
    const raw = attrValue ?? contentValue ?? ""
    for (const value of raw.split(",").map((part) => part.trim().split(/\s+/)[0])) {
      if (!value || /^(mailto:|tel:|data:|javascript:)/.test(value)) continue
      let target
      try {
        target = new URL(value.replaceAll("&amp;", "&"), pageUrl)
      } catch {
        continue
      }
      // Only this site's own URLs
      if (target.origin !== ORIGIN) continue
      checked++
      const where = `${relative(dist, file)}: ${value}`
      if (!target.pathname.startsWith(BASE)) {
        problems.push(`${where} (outside ${BASE})`)
        continue
      }
      const targetFile = fileFor(target.pathname)
      if (targetFile === undefined) {
        problems.push(`${where} (no such page or file)`)
        continue
      }
      const fragment = decodeURIComponent(target.hash.slice(1))
      if (fragment && targetFile.endsWith(".html") && !idsOf(targetFile).has(fragment)) {
        problems.push(`${where} (no #${fragment} on the page)`)
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`${problems.length} broken internal link(s):\n${problems.join("\n")}`)
  process.exit(1)
}
console.log(`check-links: ${checked} internal links and assets resolve`)
