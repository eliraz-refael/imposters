import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { rootDir } from "../../scripts/ui-assets"

type Tokens = ReadonlyMap<string, string>

const DARK = ":root"
const LIGHT = ":root[data-theme=\"light\"]"

// The --im-* declarations of every top-level rule with this exact selector, merged in order
const tokensOf = (css: string, selector: string): Tokens => {
  const tokens = new Map<string, string>()
  const uncommented = css.replaceAll(/\/\*[\s\S]*?\*\//g, "")
  for (const [, ruleSelector, block] of uncommented.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // The text before a rule's brace also holds any statements before it (the site's @imports)
    if (ruleSelector.split(";").at(-1)?.trim() !== selector) continue
    for (const declaration of block.split(";")) {
      const match = /^\s*(--im-[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(declaration)
      if (match !== null) tokens.set(match[1], match[2].replaceAll(/\s+/g, " "))
    }
  }
  return tokens
}

const read = (...segments: Array<string>) => fs.readFileSync(path.join(rootDir, ...segments), "utf8")
const site = read("site", "src", "styles", "theme.css")
const ui = read("ui-assets", "tokens.css")

describe("UI design tokens", () => {
  const themes: ReadonlyArray<readonly [string, string]> = [["dark", DARK], ["light", LIGHT]]
  for (const [theme, selector] of themes) {
    it(`every ${theme} --im-* value is the website's (site/src/styles/theme.css)`, () => {
      const ours = tokensOf(ui, selector)
      const theirs = tokensOf(site, selector)
      expect(ours.size).toBeGreaterThan(10)
      const drift = Array.from(ours).filter(([name, value]) => theirs.get(name) !== value)
        .map(([name, value]) => `${name}: ours ${value}, site ${theirs.get(name) ?? "(not defined)"}`)
      expect(drift).toEqual([])
    })
  }

  it("the light theme overrides every token the site's does, so no dark value leaks into it", () => {
    const ourDark = tokensOf(ui, DARK)
    const ourLight = tokensOf(ui, LIGHT)
    const missing = Array.from(tokensOf(site, LIGHT).keys()).filter((name) => ourDark.has(name) && !ourLight.has(name))
    expect(missing).toEqual([])
  })

  it("the @font-face families are the first families of the font tokens", () => {
    const families = Array.from(read("ui-assets", "fonts.css").matchAll(/font-family:\s*"([^"]+)"/g), (m) => m[1])
    const dark = tokensOf(ui, DARK)
    const first = (token: string) => /^"([^"]+)"/.exec(dark.get(token) ?? "")?.[1]
    expect(families).toEqual([first("--im-font-mono"), first("--im-font-body")])
  })
})
