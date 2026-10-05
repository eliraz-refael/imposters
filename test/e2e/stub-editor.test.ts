import * as Layer from "effect/Layer"
import { HttpRouter } from "effect/unstable/http"
import { ApiLayer } from "imposters/layers/ApiLayer"
import { MainLayer } from "imposters/layers/MainLayer"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// The stubs page (/_admin/stubs) and its editor over real sockets: add (first and last), edit,
// delete, with and without JS, the cross-site guard, the preview and validation. Ports 8701–8729.

const FullLayer = ApiLayer.pipe(Layer.provide(MainLayer))

let adminHandler: (request: Request) => Promise<Response>
let dispose: () => Promise<void>

beforeAll(() => {
  const result = HttpRouter.toWebHandler(FullLayer)
  adminHandler = result.handler
  dispose = result.dispose
})

afterAll(async () => {
  await dispose()
})

const admin = (path: string, body?: unknown, method?: string) =>
  adminHandler(
    new Request(`http://localhost:2525${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    })
  )

interface StubRow {
  readonly id: string
  readonly predicates: ReadonlyArray<{ readonly value: unknown }>
  readonly responses: ReadonlyArray<{ readonly status: number }>
  readonly responseMode: string
}

const stubsOf = async (id: string): Promise<ReadonlyArray<StubRow>> => (await admin(`/imposters/${id}/stubs`)).json()

const pathIs = (path: string) => [{ field: "path", operator: "equals", value: path }]

const withImposter = async (
  port: number,
  stubs: ReadonlyArray<Record<string, unknown>>,
  body: (id: string) => Promise<void>
) => {
  const imp: { id: string } = await (await admin("/imposters", { port })).json()
  for (const stub of stubs) await admin(`/imposters/${imp.id}/stubs`, stub)
  await admin(`/imposters/${imp.id}`, { status: "running" }, "PATCH")
  try {
    await body(imp.id)
  } finally {
    await admin(`/imposters/${imp.id}`, { status: "stopped" }, "PATCH")
  }
}

const url = (port: number, path: string) => `http://127.0.0.1:${String(port)}${path}`

// A form post as a browser sends it: same-origin; with JS (`fragment`) as ui.js sends it
const post = (port: number, path: string, fields: Record<string, string>, opts?: { readonly fragment?: boolean }) =>
  fetch(url(port, path), {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": "same-origin",
      ...(opts?.fragment === true ? { "x-imposters-fragment": "1" } : {})
    },
    body: new URLSearchParams(fields).toString()
  })

const stubJson = (stub: unknown): string => JSON.stringify(stub, null, 2)

// The textarea's text as a browser reads it: the newline straight after the tag is not part of it
const textareaOf = (page: string): string =>
  (/<textarea id="stub-json"[^>]*>\n([\s\S]*?)<\/textarea>/.exec(page)?.[1] ?? "")
    .replaceAll("&quot;", "\"").replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")

describe("E2E: the stubs page", () => {
  it("shows each stub as a card in matching order, the editor on a valid starter, and the 404 footer", async () => {
    await withImposter(8701, [
      { predicates: pathIs("/orders"), responses: [{ status: 200, body: { orders: [] } }, { status: 503 }] },
      { predicates: pathIs("/slow"), responses: [{ status: 200, delay: 2000, body: "eventually" }] }
    ], async () => {
      await fetch(url(8701, "/orders"))
      await fetch(url(8701, "/nothing"))
      const resp = await fetch(url(8701, "/_admin/stubs"))
      expect(resp.status).toBe(200)
      expect(resp.headers.get("cache-control")).toBe("no-store")
      const page = await resp.text()
      expect(page).not.toContain("cdn.tailwindcss.com")
      expect(page).toContain(`aria-label="Stub 1"`)
      expect(page.indexOf(`aria-label="Stub 1"`)).toBeLessThan(page.indexOf(`aria-label="Stub 2"`))
      expect(page).toContain(`<span class="tok-value">&quot;/orders&quot;</span>`)
      expect(page).toContain("1 hit · last")
      // The first response was given, so the second is next
      expect(page).toMatch(/c-error">503<\/span><span class="pill pill-next">next<\/span>/)
      expect(page).toContain("after 2,000 ms")
      expect(page).toContain("nothing else matches → <span class=\"c-caution\">404</span> · 1 request so far")
      expect(page).toMatch(/id="tab-stubs-count"[^>]*>2</)
      expect(page).toContain(`<h2 class="title" id="editor-title">new stub</h2>`)
      expect(JSON.parse(textareaOf(page))).toMatchObject({ responses: [{ status: 200 }] })
      expect(page).toContain("✓ valid stub")
    })
  }, 10000)

  it("adds a stub last by default and first when asked, then 303s back without JS", async () => {
    await withImposter(8702, [{ predicates: pathIs("/a"), responses: [{ status: 200 }] }], async (id) => {
      const last = await post(8702, "/_admin/stubs", {
        stub: stubJson({ predicates: pathIs("/b"), responses: [{ status: 201 }] })
      })
      expect(last.status).toBe(303)
      expect(last.headers.get("location")).toBe("/_admin/stubs")
      const first = await post(8702, "/_admin/stubs", {
        stub: stubJson({ predicates: [], responses: [{ status: 418 }] }),
        position: "first"
      })
      expect(first.status).toBe(303)
      expect((await stubsOf(id)).map((s) => s.responses[0]?.status)).toEqual([418, 200, 201])
      // Hot-reloaded: the catch-all added first now answers everything
      expect((await fetch(url(8702, "/b"))).status).toBe(418)
    })
  }, 10000)

  it("edits a stub in place: same id, same place, the new JSON", async () => {
    await withImposter(8703, [
      { predicates: pathIs("/a"), responses: [{ status: 200 }] },
      { predicates: pathIs("/b"), responses: [{ status: 200 }] }
    ], async (id) => {
      const before = await stubsOf(id)
      const [, second] = before
      const saved = await post(8703, `/_admin/stubs/${second?.id ?? ""}`, {
        stub: stubJson({ predicates: pathIs("/b2"), responses: [{ status: 202 }], responseMode: "repeat" })
      })
      expect(saved.status).toBe(303)
      const after = await stubsOf(id)
      expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id))
      expect(after[1]).toMatchObject({ id: second?.id, responseMode: "repeat", responses: [{ status: 202 }] })
      expect((await fetch(url(8703, "/b2"))).status).toBe(202)

      // The edit page and the editor fragment start from the stub
      const page = await (await fetch(url(8703, `/_admin/stubs?edit=${second?.id ?? ""}`))).text()
      expect(page).toContain(`edit stub<span id="stub-position-${second?.id ?? ""}"> #2</span>`)
      expect(JSON.parse(textareaOf(page))).toEqual({
        predicates: pathIs("/b2"),
        responses: [{ status: 202 }],
        responseMode: "repeat"
      })
      const fragment = await fetch(url(8703, `/_admin/fragments/stub-editor?edit=${second?.id ?? ""}`))
      expect(await fragment.text()).toMatch(
        /^<section class="panel panel-focus editor" id="stub-editor"[^>]* data-focus/
      )
    })
  }, 10000)

  it("an edit of a stub that is gone: 404s for the page, the fragment and a save", async () => {
    await withImposter(8704, [], async (id) => {
      const page = await fetch(url(8704, "/_admin/stubs?edit=gone"))
      expect(page.status).toBe(404)
      expect(await page.text()).toContain("That stub no longer exists")
      expect((await fetch(url(8704, "/_admin/fragments/stub-editor?edit=gone"))).status).toBe(404)
      const save = await post(8704, "/_admin/stubs/gone", { stub: stubJson({ responses: [{}] }) }, { fragment: true })
      expect(save.status).toBe(404)
      expect(await save.text()).toContain("add it as a new stub")
      // Without JS the page comes back with the editor: a stub that is not listed has no number
      const page404 = await post(8704, "/_admin/stubs/gone", { stub: stubJson({ responses: [{}] }) })
      expect(page404.status).toBe(404)
      const html = await page404.text()
      expect(html).toContain(`<h2 class="title" id="editor-title">edit stub<span id="stub-position-gone"></span></h2>`)
      expect(html).not.toContain("#0")
      expect(await stubsOf(id)).toEqual([])
    })
  }, 10000)

  it("with JS, a delete above the stub being edited renumbers the editor's heading", async () => {
    await withImposter(8710, [
      { predicates: pathIs("/a"), responses: [{ status: 200 }] },
      { predicates: pathIs("/b"), responses: [{ status: 200 }] }
    ], async (id) => {
      const [first, second] = await stubsOf(id)
      const editor = await (await fetch(url(8710, `/_admin/fragments/stub-editor?edit=${second?.id ?? ""}`))).text()
      expect(editor).toContain(`<span id="stub-position-${second?.id ?? ""}"> #2</span>`)
      const deleted = await post(8710, `/_admin/stubs/${first?.id ?? ""}/delete`, {}, { fragment: true })
      // The answer replaces that heading's number by id (ui.js swaps data-oob elements)
      expect(await deleted.text()).toContain(`<span id="stub-position-${second?.id ?? ""}" data-oob> #1</span>`)
    })
  }, 10000)

  it("deletes a stub; deleting one already gone just refreshes", async () => {
    await withImposter(8705, [{ predicates: pathIs("/x"), responses: [{ status: 200 }] }], async (id) => {
      const [stub] = await stubsOf(id)
      const deleted = await post(8705, `/_admin/stubs/${stub?.id ?? ""}/delete`, {})
      expect(deleted.status).toBe(303)
      expect((await fetch(url(8705, "/x"))).status).toBe(404)
      const again = await post(8705, `/_admin/stubs/${stub?.id ?? ""}/delete`, {}, { fragment: true })
      expect(again.status).toBe(200)
      const body = await again.text()
      expect(body).toContain("no stubs yet")
      expect(body).toContain(`id="tab-stubs-count" data-oob>0<`)
      // The editor is left as it is: it may hold unsaved work
      expect(body).not.toContain(`id="stub-editor"`)
    })
  }, 10000)

  it("with JS, an add answers with the list, a fresh editor and the tab count, the last two out of band", async () => {
    await withImposter(8706, [], async () => {
      const resp = await post(8706, "/_admin/stubs", {
        stub: stubJson({ predicates: pathIs("/f"), responses: [{ status: 200 }] })
      }, {
        fragment: true
      })
      expect(resp.status).toBe(200)
      const body = await resp.text()
      expect(body).toContain(`aria-label="Stub 1"`)
      expect(body).toMatch(/<section class="panel panel-focus editor" id="stub-editor"[^>]* data-oob>/)
      expect(body).toContain(`id="tab-stubs-count" data-oob>1<`)
      expect(body).not.toContain("<!DOCTYPE html>")
    })
  }, 10000)

  it("refuses an invalid stub in plain English, with JS and without, and stores nothing", async () => {
    await withImposter(8707, [], async (id) => {
      const text = stubJson({ responses: [{ status: "ok" }] })
      const withJs = await post(8707, "/_admin/stubs", { stub: text }, { fragment: true })
      expect(withJs.status).toBe(400)
      const message = await withJs.text()
      expect(message).toContain("The stub was not added")
      expect(message).toContain(
        "line 4: responses[0].status must be an HTTP status code (100–599), like 200, not &quot;ok&quot;"
      )
      expect(message).not.toContain("Expected")

      const withoutJs = await post(8707, "/_admin/stubs", { stub: text, position: "first" })
      expect(withoutJs.status).toBe(400)
      const page = await withoutJs.text()
      expect(page).toContain("<!DOCTYPE html>")
      expect(textareaOf(page)).toBe(text)
      // A text that starts with a blank line keeps it, so its line numbers hold
      const blankFirst = await post(8707, "/_admin/stubs", { stub: `\n${text}` })
      expect(textareaOf(await blankFirst.text())).toBe(`\n${text}`)
      expect(page).toContain(`data-state="invalid"`)
      expect(page).toContain("✗ not a valid stub yet")
      expect(page).toMatch(/value="first" checked/)

      const syntax = await post(8707, "/_admin/stubs", { stub: "{\n  \"responses\": [\n}" }, { fragment: true })
      expect(syntax.status).toBe(400)
      expect(await syntax.text()).toContain("line 3, column 1: unexpected &quot;}&quot;")

      expect(await stubsOf(id)).toEqual([])
    })
  }, 10000)

  it("refuses every stub write and the preview from another site", async () => {
    await withImposter(8708, [{ predicates: pathIs("/k"), responses: [{ status: 200 }] }], async (id) => {
      const [stub] = await stubsOf(id)
      const stubId = stub?.id ?? ""
      const fields = new URLSearchParams({ stub: stubJson({ responses: [{ status: 201 }] }) }).toString()
      for (
        const path of [
          "/_admin/stubs",
          `/_admin/stubs/${stubId}`,
          `/_admin/stubs/${stubId}/delete`,
          "/_admin/stubs/preview"
        ]
      ) {
        const resp = await fetch(url(8708, path), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" },
          body: fields
        })
        expect(resp.status).toBe(403)
      }
      const foreign = await fetch(url(8708, "/_admin/stubs"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://evil.example" },
        body: fields
      })
      expect(foreign.status).toBe(403)
      expect(await stubsOf(id)).toHaveLength(1)
      expect((await stubsOf(id))[0]?.responses[0]?.status).toBe(200)
    })
  }, 10000)

  it("previews a candidate against the unmatched traffic, leaving out the stub under edit", async () => {
    await withImposter(8709, [{ predicates: pathIs("/payments/old"), responses: [{ status: 200 }] }], async (id) => {
      for (const path of ["/payments/a", "/payments/a", "/payments/b", "/other", "/payments/old"]) {
        await (await fetch(url(8709, path))).arrayBuffer()
      }
      const candidate = stubJson({
        predicates: [{ field: "path", operator: "startsWith", value: "/payments/" }],
        responses: [{ status: 200, body: { id: "${$substringAfter(request.path, '/payments/')}" } }]
      })
      const preview = await post(8709, "/_admin/stubs/preview", { stub: candidate }, { fragment: true })
      expect(preview.status).toBe(200)
      const body = await preview.text()
      expect(body).toContain(`data-check="valid"`)
      expect(body).toContain("would answer 3 of the 4 unmatched requests")
      expect(body).toMatch(/GET \/payments\/[ab] → 200 \{ &quot;id&quot;: &quot;[ab]&quot; \}/)

      // A stub added since answers /payments/a, so those two no longer count as unmatched...
      await admin(`/imposters/${id}/stubs`, { predicates: pathIs("/payments/a"), responses: [{ status: 200 }] })
      const later = await post(8709, "/_admin/stubs/preview", { stub: candidate }, { fragment: true })
      expect(await later.text()).toContain("would answer 1 of the 2 unmatched requests")
      // ...unless it is the stub under edit: the question is what the edited stub would catch
      const added = (await stubsOf(id))[1]
      const editing = await post(8709, "/_admin/stubs/preview", { stub: candidate, editing: added?.id ?? "" }, {
        fragment: true
      })
      expect(await editing.text()).toContain("would answer 3 of the 4 unmatched requests")

      const invalid = await post(8709, "/_admin/stubs/preview", { stub: "{ \"responses\": [] }" }, { fragment: true })
      const problems = await invalid.text()
      expect(problems).toContain(`data-check="invalid"`)
      expect(problems).toContain("responses is empty")
    })
  }, 10000)
})
