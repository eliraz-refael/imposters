import { assets, editorJs, favicon, geistFont, martianMonoFont, uiCss, uiJs } from "imposters/ui/assets/generated"
import { assetRoute, assetUrl, serveAsset } from "imposters/ui/assets/serve"
import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { generate, generatedPath, hashedName, rootDir, withSystemLight } from "../../scripts/ui-assets"

const IMMUTABLE = "public, max-age=31536000, immutable"

describe("generated UI assets", () => {
  it("are fresh: regenerating from ui-assets/ gives the committed file (run `bun gen-ui-assets`)", async () => {
    const committed = fs.readFileSync(generatedPath, "utf8")
    const fresh = await generate()
    // Not toBe: a diff of a 100 KB line helps nobody
    expect(committed === fresh, "src/ui/assets/generated.ts is stale: run `bun gen-ui-assets`").toBe(true)
  }, 30_000)

  it("serve each file under a name carrying its content hash", () => {
    expect(assets.map((asset) => asset.name)).toEqual([
      hashedName("ui.css", uiCss.hash),
      hashedName("ui.js", uiJs.hash),
      hashedName("editor.js", editorJs.hash),
      hashedName("favicon.svg", favicon.hash),
      hashedName("martian-mono-latin-standard-normal.woff2", martianMonoFont.hash),
      hashedName("geist-latin-wght-normal.woff2", geistFont.hash)
    ])
    for (const asset of assets) expect(asset.hash).toMatch(/^[0-9a-f]{10}$/)
  })

  it("ship the latin subsets only, byte for byte the font packages' files", () => {
    const fonts = assets.filter((asset) => asset.contentType === "font/woff2")
    expect(fonts).toEqual([martianMonoFont, geistFont])
    const files = path.join(rootDir, "node_modules", "@fontsource-variable")
    const martian = fs.readFileSync(
      path.join(files, "martian-mono", "files", "martian-mono-latin-standard-normal.woff2")
    )
    const geist = fs.readFileSync(path.join(files, "geist", "files", "geist-latin-wght-normal.woff2"))
    expect(Buffer.from(martianMonoFont.body, "base64").equals(martian)).toBe(true)
    expect(Buffer.from(geistFont.body, "base64").equals(geist)).toBe(true)
  })

  it("the stylesheet loads each font by its hashed name, relative to itself", () => {
    expect(uiCss.body).toContain(`url(./${martianMonoFont.name})`)
    expect(uiCss.body).toContain(`url(./${geistFont.name})`)
  })

  it("nothing is fetched from another origin", () => {
    for (const asset of [uiCss, uiJs, editorJs]) {
      expect(asset.body).not.toMatch(/https?:\/\/(?!www\.w3\.org)/)
      expect(asset.body).not.toMatch(/@import/)
    }
  })

  it("the scripts are small IIFEs: ui.js on every page, editor.js on the stubs page only", () => {
    for (const script of [uiJs, editorJs]) {
      expect(script.body).toMatch(/^("use strict";)?\(\(\)=>\{/)
      expect(script.body.trimEnd().endsWith("})();")).toBe(true)
    }
    // About 8 KB of runtime; the stub editor is not in it
    expect(uiJs.body.length).toBeLessThan(12 * 1024)
    expect(uiJs.body).not.toContain("data-stub-editor")
    // The JSON scanner's and the form's messages are most of the editor
    expect(editorJs.body.length).toBeLessThan(40 * 1024)
  })
})

describe("withSystemLight", () => {
  it("repeats the light block under prefers-color-scheme for pages with no data-theme", () => {
    const out = withSystemLight(`:root { --a: 1; }\n:root[data-theme="light"] { --a: 2; }\n`)
    expect(out).toContain(`@media (prefers-color-scheme: light) {\n  :root:not([data-theme]) { --a: 2; }\n}`)
  })

  it("refuses tokens with no light block, or more than one", () => {
    expect(() => withSystemLight(":root { --a: 1; }")).toThrow(/expected one/)
    expect(() => withSystemLight(`:root[data-theme="light"] {} :root[data-theme="light"] {}`)).toThrow(/found 2/)
  })

  it("is applied to the shipped stylesheet", () => {
    expect(uiCss.body).toContain("@media(prefers-color-scheme:light){:root:not([data-theme]){--im-ground:")
  })
})

describe("serveAsset", () => {
  it("answers every asset with its type, immutable caching and an ETag", async () => {
    for (const asset of assets) {
      const resp = serveAsset(asset.name)
      expect(resp?.status).toBe(200)
      expect(resp?.headers.get("content-type")).toBe(asset.contentType)
      expect(resp?.headers.get("cache-control")).toBe(IMMUTABLE)
      expect(resp?.headers.get("etag")).toBe(`"${asset.hash}"`)
      expect(resp?.headers.get("x-content-type-options")).toBe("nosniff")
      const bytes = Buffer.from(await (resp ?? new Response()).arrayBuffer())
      const expected = asset.encoding === "base64" ? Buffer.from(asset.body, "base64") : Buffer.from(asset.body, "utf8")
      expect(bytes.equals(expected)).toBe(true)
    }
  })

  it("serves the same font bytes again (the decoded copy is not consumed)", async () => {
    const first = Buffer.from(await (serveAsset(geistFont.name) ?? new Response()).arrayBuffer())
    const second = Buffer.from(await (serveAsset(geistFont.name) ?? new Response()).arrayBuffer())
    expect(first.length).toBeGreaterThan(0)
    expect(second.equals(first)).toBe(true)
  })

  it("answers 304 with no body when If-None-Match has the ETag", async () => {
    const etag = `"${uiCss.hash}"`
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const resp = serveAsset(uiCss.name, header)
      expect(resp?.status).toBe(304)
      expect(resp?.headers.get("etag")).toBe(etag)
      expect(resp?.headers.get("cache-control")).toBe(IMMUTABLE)
      expect(await resp?.text()).toBe("")
    }
    expect(serveAsset(uiCss.name, `"${uiJs.hash}"`)?.status).toBe(200)
  })

  it("is null for a name it does not have, including an unhashed or stale one", () => {
    expect(serveAsset("ui.css")).toBeNull()
    expect(serveAsset("ui.0000000000.css")).toBeNull()
    expect(serveAsset(`../${uiCss.name}`)).toBeNull()
    expect(serveAsset("")).toBeNull()
  })
})

describe("assetRoute", () => {
  const get = (subpath: string, init?: RequestInit) =>
    assetRoute(new Request(`http://localhost/_ui${subpath}`, init), subpath)

  it("is null outside /assets/, so the router carries on", () => {
    expect(get("/")).toBeNull()
    expect(get("/assetsx")).toBeNull()
    expect(get("/imposters")).toBeNull()
  })

  it("serves a known asset, and 404s an unknown one", async () => {
    expect(get(`/assets/${uiJs.name}`)?.status).toBe(200)
    const missing = get("/assets/nope.js")
    expect(missing?.status).toBe(404)
    expect(await missing?.text()).toBe("Not found")
  })

  it("answers HEAD, and refuses other methods", () => {
    expect(get(`/assets/${uiJs.name}`, { method: "HEAD" })?.status).toBe(200)
    const post = get(`/assets/${uiJs.name}`, { method: "POST" })
    expect(post?.status).toBe(405)
    expect(post?.headers.get("allow")).toBe("GET, HEAD")
  })

  it("assetUrl links an asset under a UI's own prefix", () => {
    expect(assetUrl("/_ui", uiCss)).toBe(`/_ui/assets/${uiCss.name}`)
    expect(assetUrl("/_admin", uiJs)).toBe(`/_admin/assets/${uiJs.name}`)
  })
})
