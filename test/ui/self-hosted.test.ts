import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

// The web UIs are self-hosted and work offline: nothing in the source, the generated assets or
// their sources may point at a CDN or the htmx runtime the old pages loaded from one
const ROOTS = ["src", "ui-assets"]
const FORBIDDEN = /unpkg|cdn\.|htmx|hx-/i

const files = (dir: string): Array<string> =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? files(full) : [full]
  })

const rootDir = path.resolve(import.meta.dirname, "../..")

describe("self-hosted UI", () => {
  it("has no CDN or htmx reference anywhere in src/ (generated assets included) or ui-assets/", () => {
    const all = ROOTS.flatMap((root) => files(path.join(rootDir, root)))
    // The generated assets are where a stray reference would hide in minified code
    expect(all.some((file) => file.endsWith(path.join("ui", "assets", "generated.ts")))).toBe(true)
    const hits = all.flatMap((file) =>
      fs.readFileSync(file, "utf8").split("\n").flatMap((line, i) => {
        const match = FORBIDDEN.exec(line)
        return match === null ? [] : [`${path.relative(rootDir, file)}:${String(i + 1)}: ${match[0]}`]
      })
    )
    expect(hits).toEqual([])
  })
})
