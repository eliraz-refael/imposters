import { favicon, geistFont, martianMonoFont, uiCss, uiJs } from "imposters/ui/assets/generated"
import type { UiPrefix } from "imposters/ui/assets/serve"
import { shell } from "imposters/ui/components/shell"
import { html } from "imposters/ui/html"
import { THEME_COOKIE, themeFromCookie } from "imposters/ui/theme"
import { describe, expect, it } from "vitest"

describe("themeFromCookie", () => {
  it("reads the imposters-theme cookie", () => {
    expect(THEME_COOKIE).toBe("imposters-theme")
    expect(themeFromCookie("imposters-theme=light")).toBe("light")
    expect(themeFromCookie("a=1; imposters-theme=dark; b=2")).toBe("dark")
    expect(themeFromCookie("a=1;imposters-theme = light ;b=2")).toBe("light")
  })

  it("is null with no cookie, or a value that is not a theme: the page follows the system", () => {
    expect(themeFromCookie(null)).toBeNull()
    expect(themeFromCookie(undefined)).toBeNull()
    expect(themeFromCookie("")).toBeNull()
    expect(themeFromCookie("other=light")).toBeNull()
    expect(themeFromCookie("imposters-theme=sepia")).toBeNull()
    expect(themeFromCookie("imposters-theme=\"><script>")).toBeNull()
    expect(themeFromCookie("x-imposters-theme=light")).toBeNull()
  })

  it("skips an invalid duplicate for a valid one", () => {
    expect(themeFromCookie("imposters-theme=bogus; imposters-theme=light")).toBe("light")
  })
})

describe("shell", () => {
  it("renders the theme on <html>, so the first paint is already in it", () => {
    expect(shell({ title: "t", prefix: "/_ui", theme: "light" }, html``).value).toContain(
      "<html lang=\"en\" data-theme=\"light\">"
    )
    const system = shell({ title: "t", prefix: "/_ui", theme: null }, html``).value
    expect(system).toContain("<html lang=\"en\">")
    expect(system).toContain("<meta name=\"color-scheme\" content=\"dark light\">")
  })

  it("links the hashed assets under its own UI's prefix, and nothing from a CDN", () => {
    const prefixes: ReadonlyArray<UiPrefix> = ["/_ui", "/_admin"]
    for (const prefix of prefixes) {
      const page = shell({ title: "t", prefix, theme: null }, html`<main>hi</main>`).value
      expect(page).toContain(`<link rel="stylesheet" href="${prefix}/assets/${uiCss.name}">`)
      expect(page).toContain(`<script defer src="${prefix}/assets/${uiJs.name}"></script>`)
      expect(page).toContain(`<link rel="icon" type="image/svg+xml" href="${prefix}/assets/${favicon.name}">`)
      expect(page).toContain(`href="${prefix}/assets/${martianMonoFont.name}" as="font"`)
      expect(page).toContain(`href="${prefix}/assets/${geistFont.name}" as="font"`)
      expect(page).toContain("<main>hi</main>")
      expect(page).not.toMatch(/https?:\/\//)
    }
  })

  it("escapes the title", () => {
    expect(shell({ title: "<x>", prefix: "/_ui", theme: null }, html``).value).toContain("<title>&lt;x&gt;</title>")
  })
})
