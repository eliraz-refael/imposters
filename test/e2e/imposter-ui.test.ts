import * as Layer from "effect/Layer"
import { HttpRouter } from "effect/unstable/http"
import { ApiLayer } from "imposters/layers/ApiLayer"
import { MainLayer } from "imposters/layers/MainLayer"
import { makeWebHandler } from "imposters/server/AdminServer"
import { favicon } from "imposters/ui/assets/generated"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const FullLayer = ApiLayer.pipe(Layer.provide(MainLayer))

let adminHandler: (request: Request) => Promise<Response>
let dispose: () => void

beforeAll(() => {
  const result = HttpRouter.toWebHandler(FullLayer)
  adminHandler = result.handler
  dispose = result.dispose
})

afterAll(() => {
  dispose()
})

const admin = (path: string, init?: RequestInit) => adminHandler(new Request(`http://localhost:2525${path}`, init))

const createImposter = async (port: number) => {
  const resp = await admin("/imposters", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port })
  })
  return resp.json()
}

const startImposter = async (id: string) => {
  await admin(`/imposters/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "running" })
  })
}

const stopImposter = async (id: string) => {
  await admin(`/imposters/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "stopped" })
  })
}

const addStub = async (imposterId: string, stub: Record<string, unknown>) => {
  await admin(`/imposters/${imposterId}/stubs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(stub)
  })
}

describe("E2E: Imposter UI", () => {
  it("GET /_admin returns the live page with the imposter's info", async () => {
    const imp = await createImposter(9601)
    await addStub(imp.id, {
      predicates: [],
      responses: [{ status: 200, body: { ok: true } }]
    })
    await startImposter(imp.id)

    try {
      const resp = await fetch("http://localhost:9601/_admin")
      expect(resp.status).toBe(200)
      expect(resp.headers.get("content-type")).toContain("text/html")

      expect(resp.headers.get("cache-control")).toBe("no-store")

      const html = await resp.text()
      expect(html).toContain("<!DOCTYPE html>")
      expect(html).toContain("live requests")
      expect(html).toContain(":9601")
      expect(html).toContain("stub hits")
      expect(html).toContain("#1 catch-all")
      // Self-hosted: no CDN
      expect(html).not.toContain("cdn.tailwindcss.com")
      expect(html).not.toContain("unpkg.com")
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)

  it("GET /_admin/stubs returns HTML with stub list", async () => {
    const imp = await createImposter(9602)
    await addStub(imp.id, {
      predicates: [{ field: "path", operator: "equals", value: "/api" }],
      responses: [{ status: 200, body: { hello: "world" } }]
    })
    await startImposter(imp.id)

    try {
      const resp = await fetch("http://localhost:9602/_admin/stubs")
      expect(resp.status).toBe(200)
      const html = await resp.text()
      expect(html).toContain("<!DOCTYPE html>")
      expect(html).toContain("add stub")
      // The stub's predicate, as a chip
      expect(html).toContain(`<span class="tok-field">path</span>&nbsp;<span class="tok-op">equals</span>`)
      expect(html).toContain("&quot;/api&quot;")
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)

  it("non-/_admin requests still match stubs normally", async () => {
    const imp = await createImposter(9605)
    await addStub(imp.id, {
      predicates: [{ field: "path", operator: "equals", value: "/api/data" }],
      responses: [{ status: 200, body: { data: "normal" } }]
    })
    await startImposter(imp.id)

    try {
      // Normal stub matching still works
      const resp = await fetch("http://localhost:9605/api/data")
      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body).toEqual({ data: "normal" })

      // /_admin still serves UI
      const uiResp = await fetch("http://localhost:9605/_admin")
      expect(uiResp.status).toBe(200)
      expect(uiResp.headers.get("content-type")).toContain("text/html")
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)
})

// Regression tests for the UI audit. Ports 9621-9639 belong to this block (stub writes are in
// test/e2e/stub-editor.test.ts).
const form = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString()
})

const loggedPaths = async (id: string): Promise<Array<string>> => {
  const resp = await admin(`/imposters/${id}/requests`)
  const entries: Array<{ request: { path: string } }> = await resp.json()
  return entries.map((e) => e.request.path)
}

const withRunningImposter = async (port: number, body: (id: string) => Promise<void>) => {
  const imp = await createImposter(port)
  await startImposter(imp.id)
  try {
    await body(imp.id)
  } finally {
    await stopImposter(imp.id)
  }
}

describe("E2E: Imposter UI fixes", () => {
  it("serves its favicon under /_admin, and UI traffic never lands in the request log", async () => {
    await withRunningImposter(9621, async (id) => {
      const page = await (await fetch("http://localhost:9621/_admin")).text()
      expect(page).toContain(`href="/_admin/assets/${favicon.name}"`)

      const icon = await fetch("http://localhost:9621/_admin/favicon.svg")
      expect(icon.status).toBe(200)
      expect(icon.headers.get("content-type")).toBe("image/svg+xml")
      expect(await icon.text()).toContain("<svg")

      await fetch("http://localhost:9621/_admin/stubs")
      await fetch("http://localhost:9621/_admin/requests")
      expect(await loggedPaths(id)).toEqual([])
    })
  }, 10000)

  it("a user's own /favicon.ico stub still answers (no special case in the imposter)", async () => {
    await withRunningImposter(9622, async (id) => {
      await addStub(id, {
        predicates: [{ field: "path", operator: "equals", value: "/favicon.ico" }],
        responses: [{ status: 200, body: "icon" }]
      })
      const resp = await fetch("http://localhost:9622/favicon.ico")
      expect(resp.status).toBe(200)
      expect(await resp.text()).toBe("icon")
      expect(await loggedPaths(id)).toEqual(["/favicon.ico"])
    })
  }, 10000)

  it("paths that merely start with /_admin go to the stubs, not the UI", async () => {
    await withRunningImposter(9623, async (id) => {
      await addStub(id, {
        predicates: [{ field: "path", operator: "equals", value: "/_admin-api" }],
        responses: [{ status: 200, body: "mine" }]
      })
      const resp = await fetch("http://localhost:9623/_admin-api")
      expect(resp.status).toBe(200)
      expect(await resp.text()).toBe("mine")
    })
  }, 10000)

  it("the requests page shows request times, not NaN:NaN:NaN", async () => {
    await withRunningImposter(9624, async () => {
      await fetch("http://localhost:9624/some/path")
      const page = await (await fetch("http://localhost:9624/_admin/requests")).text()
      expect(page).not.toContain("NaN")
      expect(page).toMatch(/class="req-time c-muted">\d{2}:\d{2}:\d{2}\.\d{3}</)
    })
  }, 10000)

  it("pages show the imposter's current name, not the one it started with", async () => {
    await withRunningImposter(9629, async (id) => {
      await admin(`/imposters/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "renamed-while-running" })
      })
      for (const page of ["/_admin", "/_admin/stubs", "/_admin/requests"]) {
        expect(await (await fetch(`http://localhost:9629${page}`)).text()).toContain("renamed-while-running")
      }
    })
  }, 10000)

  it("send a request: a path without a leading slash works, and errors are escaped 400s", async () => {
    await withRunningImposter(9630, async (id) => {
      await addStub(id, {
        predicates: [{ field: "path", operator: "equals", value: "/ping" }],
        responses: [{ status: 200, body: "pong" }]
      })
      // Sent, it is logged like any request, and the answer is its page
      const ok = await fetch("http://localhost:9630/_admin/requests/test", form({ method: "GET", path: "ping" }))
      expect(ok.status).toBe(200)
      expect(ok.redirected).toBe(true)
      expect(ok.url).toMatch(/\/_admin\/requests\/[0-9a-f-]{36}$/)
      const detail = await ok.text()
      expect(detail).toContain(`<h2 class="detail-path">/ping</h2>`)
      expect(detail).toContain("pong")
      expect(await loggedPaths(id)).toEqual(["/ping"])

      const bad = await fetch(
        "http://localhost:9630/_admin/requests/test",
        form({ method: "GET", path: "/", headers: "<img src=x onerror=alert(1)>: v" })
      )
      expect(bad.status).toBe(400)
      const body = await bad.text()
      expect(body).toContain("Invalid test request")
      expect(body).not.toContain("<img")
      expect(body).toContain("&lt;img")
    })
  }, 10000)

  it("a non-numeric status filter is a visible 400, not an empty table", async () => {
    await withRunningImposter(9631, async () => {
      const resp = await fetch("http://localhost:9631/_admin/requests?status=abc")
      expect(resp.status).toBe(400)
      const page = await resp.text()
      expect(page).toContain(
        `<div class="alert" data-error-slot>Status filter must be a number, got &quot;abc&quot;.</div>`
      )
      // The field keeps what was typed, marked
      expect(page).toMatch(/id="filter-status"[^>]*value="abc"[^>]*aria-invalid="true"/)
    })
  }, 10000)

  it("a detail link for an unknown request id is a 404 page in the imposter's shell", async () => {
    await withRunningImposter(9632, async () => {
      const resp = await fetch("http://localhost:9632/_admin/requests/no-such-id")
      expect(resp.status).toBe(404)
      const page = await resp.text()
      expect(page).toContain("<!DOCTYPE html>")
      expect(page).toContain("request not found")
      expect(page).toContain(`href="/_admin/requests">← requests</a>`)
      expect(page).toContain("no-such-id")
    })
  }, 10000)

  it("the request detail page shows the instant in UTC and the matched stub, escaping the body", async () => {
    await withRunningImposter(9633, async (id) => {
      await addStub(id, { predicates: [], responses: [{ status: 200, body: "<script>alert(1)</script>" }] })
      await fetch("http://localhost:9633/x")
      const list = await (await fetch("http://localhost:9633/_admin/requests")).text()
      const link = /href="(\/_admin\/requests\/[0-9a-f-]{36})"/.exec(list)?.[1]
      expect(link).toBeDefined()
      const page = await (await fetch(`http://localhost:9633${link ?? ""}`)).text()
      expect(page).toMatch(
        /<time datetime="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z">\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} UTC<\/time>/
      )
      expect(page).toContain(`matched <a href="/_admin/stubs#stub-`)
      expect(page).toContain("#1 catch-all</a>")
      expect(page).not.toContain("<script>alert(1)</script>")
      expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    })
  }, 10000)

  it("the dashboard counts every request since start, not the request log's last 100", async () => {
    await withRunningImposter(9636, async (id) => {
      await addStub(id, { predicates: [], responses: [{ status: 200 }] })
      for (let i = 0; i < 105; i++) await (await fetch(`http://localhost:9636/r${i}`)).arrayBuffer()
      const page = await (await fetch("http://localhost:9636/_admin")).text()
      expect(page).toMatch(/>105</)
      expect(page).not.toMatch(/>100</)
    })
  }, 20000)

  it("the live page follows the theme cookie, and its tabs lead to the pages that still work", async () => {
    await withRunningImposter(9637, async () => {
      const page = (cookie?: string) =>
        fetch("http://localhost:9637/_admin", cookie === undefined ? {} : { headers: { cookie } }).then((r) => r.text())
      expect(await page("imposters-theme=light")).toContain(`<html lang="en" data-theme="light">`)
      expect(await page("other=1; imposters-theme=dark")).toContain(`<html lang="en" data-theme="dark">`)
      const plain = await page()
      expect(plain).toContain(`<html lang="en">`)
      expect(plain).toContain(`<link rel="stylesheet" href="/_admin/assets/ui.`)
      for (const href of ["/_admin/stubs", "/_admin/requests"]) {
        expect(plain).toContain(`href="${href}"`)
        const resp = await fetch(`http://localhost:9637${href}`)
        expect(resp.status).toBe(200)
        // Every page's tabs lead back here
        expect(await resp.text()).toContain(`href="/_admin"`)
      }
    })
  }, 10000)

  it("stub it: an unmatched request links to a prefilled stub form, and once stubbed it leaves the list", async () => {
    await withRunningImposter(9638, async () => {
      await fetch("http://localhost:9638/payments/pm_81?x=1")
      const live = await (await fetch("http://localhost:9638/_admin")).text()
      expect(live).toContain("no stub matched · 1")
      const link = /href="(\/_admin\/stubs\?draft=[^"]+)"/.exec(live)?.[1]?.replaceAll("&amp;", "&")
      expect(link).toBe("/_admin/stubs?draft=GET&path=%2Fpayments%2Fpm_81")

      const stubsPage = await (await fetch(`http://localhost:9638${link ?? ""}`)).text()
      expect(stubsPage).toContain("from GET /payments/pm_81")
      // Opened for the draft: ui.js brings the editor into view and focuses it
      expect(stubsPage).toMatch(/id="stub-editor"[^>]* data-focus/)
      // A stub for one request goes first, before the broader ones
      expect(stubsPage).toMatch(/value="first" checked/)
      const text = (/<textarea id="stub-json"[^>]*>([^<]*)<\/textarea>/.exec(stubsPage)?.[1] ?? "")
        .replaceAll("&quot;", "\"").replaceAll("&amp;", "&")
      const draft: { predicates: unknown } = JSON.parse(text)
      expect(draft.predicates).toEqual([
        { field: "method", operator: "equals", value: "GET" },
        { field: "path", operator: "equals", value: "/payments/pm_81" }
      ])

      const added = await fetch("http://localhost:9638/_admin/stubs", {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
        body: new URLSearchParams({ stub: text, position: "first" }).toString()
      })
      expect(added.status).toBe(303)
      expect((await fetch("http://localhost:9638/payments/pm_81")).status).toBe(200)

      const fragment = await (await fetch("http://localhost:9638/_admin/fragments/live")).text()
      expect(fragment).toContain("nothing unmatched")
      expect(fragment).toContain("#1 GET /payments/pm_81")
      expect(fragment).toContain(`id="tab-stubs-count" data-oob>1<`)
    })
  }, 10000)

  it("the live fragment renumbers a listed request's stub after a stub is inserted above it", async () => {
    await withRunningImposter(9634, async (id) => {
      const orders = { field: "path", operator: "equals", value: "/orders" }
      await addStub(id, { predicates: [orders], responses: [{ status: 200 }] })
      await (await fetch("http://localhost:9634/orders")).arrayBuffer()
      const entries: Array<{ id: string }> = await (await admin(`/imposters/${id}/requests`)).json()
      const cell = `id="answered-${entries[0]?.id ?? "none"}"`
      expect(await (await fetch("http://localhost:9634/_admin")).text()).toContain(`${cell}>#1 /orders<`)

      await admin(`/imposters/${id}/stubs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ predicates: [{ ...orders, value: "/health" }], responses: [{ status: 200 }], index: 0 })
      })
      const fragment = await (await fetch("http://localhost:9634/_admin/fragments/live")).text()
      expect(fragment).toContain(`${cell} data-oob>#2 /orders<`)
    })
  }, 10000)

  it("the recent-rows fragment lists the latest requests, newest first", async () => {
    await withRunningImposter(9639, async () => {
      for (const path of ["/one", "/two", "/three"]) await (await fetch(`http://localhost:9639${path}`)).arrayBuffer()
      const resp = await fetch("http://localhost:9639/_admin/fragments/requests")
      expect(resp.headers.get("cache-control")).toBe("no-store")
      const rows = await resp.text()
      const order = Array.from(rows.matchAll(/class="req-path ellipsis"[^>]*>([^<]*)</g), (m) => m[1])
      expect(order).toEqual(["/three", "/two", "/one"])
    })
  }, 10000)

  it("links its mark to the admin UI on the host the page was reached through", async () => {
    const { dispose: disposeLinked, handler } = makeWebHandler([], undefined, 2599)
    const call = (path: string, body?: unknown) =>
      handler(
        new Request(`http://localhost${path}`, {
          method: body === undefined ? "GET" : path.endsWith("/imposters") ? "POST" : "PATCH",
          headers: { "content-type": "application/json" },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        })
      )
    try {
      const imp = await (await call("/imposters", { port: 9640 })).json()
      await call(`/imposters/${imp.id}`, { status: "running" })
      const page = await (await fetch("http://127.0.0.1:9640/_admin")).text()
      expect(page).toContain(`href="http://127.0.0.1:2599/_ui" aria-label="All imposters"`)
      await call(`/imposters/${imp.id}`, { status: "stopped" })
    } finally {
      await disposeLinked()
    }
  }, 10000)
})
