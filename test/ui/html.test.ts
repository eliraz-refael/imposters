import { describe, expect, it } from "vitest"
import { escapeHtml, html, raw, SafeHtml } from "imposters/ui/html.js"

describe("escapeHtml", () => {
  it("escapes all 5 special characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;")
  })

  it("leaves normal text unchanged", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123")
  })

  it("escapes mixed content", () => {
    expect(escapeHtml(`<script>alert("xss")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"
    )
  })
})

describe("html tagged template", () => {
  it("auto-escapes string interpolations", () => {
    const userInput = `<img onerror="alert('xss')">`
    const result = html`<div>${userInput}</div>`
    expect(result).toBeInstanceOf(SafeHtml)
    expect(result.value).toBe(`<div>&lt;img onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;</div>`)
  })

  it("passes SafeHtml through unescaped", () => {
    const trusted = raw(`<strong>bold</strong>`)
    const result = html`<div>${trusted}</div>`
    expect(result.value).toBe(`<div><strong>bold</strong></div>`)
  })

  it("handles numbers", () => {
    const result = html`<span>${42}</span>`
    expect(result.value).toBe("<span>42</span>")
  })

  it("handles booleans", () => {
    const result = html`<span>${true}</span>`
    expect(result.value).toBe("<span>true</span>")
  })

  it("handles null and undefined as empty string", () => {
    const result = html`<span>${null}${undefined}</span>`
    expect(result.value).toBe("<span></span>")
  })

  it("composes nested html calls correctly", () => {
    const inner = html`<em>${"<b>nested</b>"}</em>`
    const outer = html`<div>${inner}</div>`
    expect(outer.value).toBe("<div><em>&lt;b&gt;nested&lt;/b&gt;</em></div>")
  })

  it("handles multiple interpolations", () => {
    const a = "<a>"
    const b = raw("<br>")
    const result = html`${a}${b}${42}`
    expect(result.value).toBe("&lt;a&gt;<br>42")
  })
})
