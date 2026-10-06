import { favicon } from "imposters/ui/assets/generated"
import { shell } from "imposters/ui/components/shell"
import { faviconSvg } from "imposters/ui/favicon"
import { html } from "imposters/ui/html"
import * as fs from "node:fs"
import { describe, expect, it } from "vitest"

describe("UI favicon", () => {
  it("is the site's brace-face mark", () => {
    const site = fs.readFileSync(new URL("../../site/public/favicon.svg", import.meta.url), "utf8")
    expect(faviconSvg).toBe(site)
    expect(favicon.body).toBe(site)
  })

  it("every imposter page links the hashed icon its UI router serves, so the browser never asks for /favicon.ico", () => {
    const imposterPage = shell({ title: "t", prefix: "/_admin", theme: null }, html``).value
    expect(imposterPage).toContain(`<link rel="icon" type="image/svg+xml" href="/_admin/assets/${favicon.name}">`)
  })
})
