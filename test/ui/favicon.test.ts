import { adminLayout } from "imposters/ui/admin/AdminLayout"
import { favicon } from "imposters/ui/assets/generated"
import { faviconSvg } from "imposters/ui/favicon"
import { html } from "imposters/ui/html"
import { layout } from "imposters/ui/layout"
import * as fs from "node:fs"
import { describe, expect, it } from "vitest"

describe("UI favicon", () => {
  it("is the site's brace-face mark", () => {
    const site = fs.readFileSync(new URL("../../site/public/favicon.svg", import.meta.url), "utf8")
    expect(faviconSvg).toBe(site)
    expect(favicon.body).toBe(site)
  })

  it("each layout links the hashed icon its own UI router serves, so the browser never asks for /favicon.ico", () => {
    const imposterPage = layout({ title: "t", imposterName: "n", port: 1, activeTab: "dashboard" }, html``).value
    expect(imposterPage).toContain(`<link rel="icon" type="image/svg+xml" href="/_admin/assets/${favicon.name}">`)

    const adminPage = adminLayout({ title: "t" }, html``).value
    expect(adminPage).toContain(`<link rel="icon" type="image/svg+xml" href="/_ui/assets/${favicon.name}">`)
  })

  it("each layout has the error slot and the htmx config that swaps 4xx answers into it", () => {
    for (
      const page of [
        layout({ title: "t", imposterName: "n", port: 1, activeTab: "dashboard" }, html``).value,
        adminLayout({ title: "t" }, html``).value
      ]
    ) {
      expect(page).toContain("<div id=\"ui-error\"></div>")
      expect(page).toContain("name=\"htmx-config\"")
      expect(page).toContain("{\"code\":\"[45]..\",\"swap\":true,\"error\":true}")
    }
  })
})
