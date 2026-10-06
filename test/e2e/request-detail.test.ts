import * as Layer from "effect/Layer"
import { HttpRouter } from "effect/unstable/http"
import { ApiLayer } from "imposters/layers/ApiLayer"
import { MainLayer } from "imposters/layers/MainLayer"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// A request's page, explain, copy as curl and replay, over real ports. This file owns 9561-9569.

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

const admin = (path: string, method = "GET", body?: unknown) =>
  adminHandler(
    new Request(`http://localhost:2525${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    })
  )

interface Logged {
  readonly id: string
  readonly request: {
    readonly method: string
    readonly path: string
    readonly headers: Record<string, string>
    readonly query: Record<string, string>
    readonly body?: unknown
  }
  readonly response: { readonly status: number; readonly matchedStubId?: string }
}

const logged = async (id: string): Promise<Array<Logged>> => (await admin(`/imposters/${id}/requests?limit=500`)).json()

const withImposter = async (
  port: number,
  stubs: ReadonlyArray<Record<string, unknown>>,
  body: (id: string, base: string) => Promise<void>
) => {
  const imp: { id: string } = await (await admin("/imposters", "POST", { port })).json()
  for (const stub of stubs) await admin(`/imposters/${imp.id}/stubs`, "POST", stub)
  await admin(`/imposters/${imp.id}`, "PATCH", { status: "running" })
  try {
    await body(imp.id, `http://localhost:${String(port)}`)
  } finally {
    await admin(`/imposters/${imp.id}`, "PATCH", { status: "stopped" })
  }
}

const ordersStub = {
  predicates: [
    { field: "method", operator: "equals", value: "GET" },
    { field: "path", operator: "equals", value: "/orders" }
  ],
  responses: [{ status: 200, body: { orders: [] } }, { status: 503, body: { error: "service_unavailable" } }]
}

const echoStub = {
  predicates: [
    { field: "method", operator: "equals", value: "POST" },
    { field: "path", operator: "equals", value: "/echo" },
    { field: "headers", operator: "equals", value: { "x-tenant": "acme" } }
  ],
  responses: [{ status: 201, body: "echo: ${request.body.sku}" }]
}

const SAME_ORIGIN = { "sec-fetch-site": "same-origin" }

const page = async (base: string, id: string): Promise<string> =>
  (await fetch(`${base}/_admin/requests/${encodeURIComponent(id)}`)).text()

const replay = (base: string, id: string, headers: Record<string, string> = SAME_ORIGIN) =>
  fetch(`${base}/_admin/requests/${encodeURIComponent(id)}/replay`, { method: "POST", redirect: "manual", headers })

describe("E2E: a request's page", () => {
  it("shows the request, the response, the stub and response that answered, and why it matched", async () => {
    await withImposter(9561, [ordersStub], async (id, base) => {
      await (await fetch(`${base}/orders?status=open`, { headers: { "x-request-id": "r-1" } })).arrayBuffer()
      await (await fetch(`${base}/orders`)).arrayBuffer()
      const [, second] = await logged(id)
      const html = await page(base, second?.id ?? "")
      expect(html).toContain(`<h2 class="detail-path">/orders</h2>`)
      expect(html).toContain("→&nbsp;503")
      expect(html).toContain("503 Service Unavailable")
      expect(html).toContain(">#1 GET /orders</a>, response 2 of 2")
      expect(html).toContain("why stub #1 matched")
      expect(html).toContain("sequential: answered #2 of 2, next is #1")
      expect(html).toContain(`<span class="c-text-2">method equals &quot;GET&quot;</span>`)
      expect(html).toContain("&quot;error&quot;: &quot;service_unavailable&quot;")

      const [first] = await logged(id)
      const firstPage = await page(base, first?.id ?? "")
      expect(firstPage).toContain(`/orders<span class="detail-query">?status=open</span>`)
      expect(firstPage).toContain(`<span>x-request-id</span><span>r-1</span>`)
    })
  }, 10000)

  it("copies as curl for the address the page was reached through", async () => {
    await withImposter(9562, [echoStub], async (id, base) => {
      await (await fetch(`${base}/echo?x=1`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant": "acme" },
        body: JSON.stringify({ sku: "it's" })
      })).arrayBuffer()
      const [entry] = await logged(id)
      const html = await page(base, entry?.id ?? "")
      const copy = /data-copy="([^"]*)"/.exec(html)?.[1]?.replaceAll("&#39;", "'").replaceAll("&quot;", "\"")
        .replaceAll("&amp;", "&")
      expect(copy).toBeDefined()
      const lines = copy?.split(" \\\n  ") ?? []
      expect(lines[0]).toBe("curl 'http://localhost:9562/echo?x=1'")
      expect(lines).toContain("-H 'content-type: application/json'")
      expect(lines).toContain("-H 'x-tenant: acme'")
      expect(lines.at(-1)).toBe(`--data-raw '{"sku":"it'\\''s"}'`)
      // curl sets these itself
      expect(lines.some((line) => /^-H '(host|content-length|connection):/.test(line))).toBe(false)
    })
  }, 10000)

  it("flags it when today's stubs would answer differently, and offers to stub an unmatched one", async () => {
    await withImposter(9563, [ordersStub], async (id, base) => {
      await (await fetch(`${base}/orders`)).arrayBuffer()
      await (await fetch(`${base}/payments/pm_1`)).arrayBuffer()
      const [matched, unmatched] = await logged(id)

      const missing = await page(base, unmatched?.id ?? "")
      expect(missing).toContain("why no stub matched")
      expect(missing).toContain(`<details class="disclose why-others" open>`)
      expect(missing).toContain(`href="/_admin/stubs?draft=GET&amp;path=%2Fpayments%2Fpm_1"`)

      const stubs: Array<{ id: string }> = await (await admin(`/imposters/${id}/stubs`)).json()
      await admin(`/imposters/${id}/stubs/${stubs[0]?.id ?? ""}`, "DELETE")
      const changed = await page(base, matched?.id ?? "")
      expect(changed).toContain("data-differs")
      expect(changed).toContain("since removed); now no stub matches.")
      expect(changed).toContain("no stubs to match")
    })
  }, 10000)

  it("a request no longer in the log is a 404 page", async () => {
    await withImposter(9564, [], async (_id, base) => {
      const resp = await fetch(`${base}/_admin/requests/no-such-entry`)
      expect(resp.status).toBe(404)
      expect(await resp.text()).toContain("request not found")
    })
  }, 10000)
})

describe("E2E: replay", () => {
  it("sends the same request to the imposter, logs it, and 303s to the new entry's page", async () => {
    await withImposter(9565, [echoStub], async (id, base) => {
      await (await fetch(`${base}/echo?x=1`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant": "acme" },
        body: JSON.stringify({ sku: "mug" })
      })).arrayBuffer()
      const [original] = await logged(id)

      const resp = await replay(base, original?.id ?? "")
      expect(resp.status).toBe(303)
      const location = resp.headers.get("location") ?? ""
      expect(location).toMatch(/^\/_admin\/requests\/[0-9a-f-]{36}$/)

      const entries = await logged(id)
      expect(entries).toHaveLength(2)
      const again = entries[1]
      expect(location).toBe(`/_admin/requests/${again?.id ?? ""}`)
      expect(again?.id).not.toBe(original?.id)
      expect(again?.request.method).toBe("POST")
      expect(again?.request.path).toBe("/echo")
      expect(again?.request.query).toEqual({ x: "1" })
      expect(again?.request.headers["x-tenant"]).toBe("acme")
      expect(again?.request.body).toEqual({ sku: "mug" })
      // It matched the same stub, so the templated answer is the same
      expect(again?.response.status).toBe(201)
      expect(again?.response.matchedStubId).toBe(original?.response.matchedStubId)

      // The new page is the replay's
      const html = await (await fetch(`${base}${location}`)).text()
      expect(html).toContain("echo: mug")

      // With JS, ui.js sends the same form; the answer is the same redirect, which it follows
      const viaJs = await replay(base, original?.id ?? "", { ...SAME_ORIGIN, "x-imposters-fragment": "1" })
      expect(viaJs.status).toBe(303)
      expect(await logged(id)).toHaveLength(3)

      // It counts in the stats like any request
      const stats: { totalRequests: number } = await (await admin(`/imposters/${id}/stats`)).json()
      expect(stats.totalRequests).toBe(3)
    })
  }, 10000)

  it("refuses a cross-site replay", async () => {
    await withImposter(9566, [ordersStub], async (id, base) => {
      await (await fetch(`${base}/orders`)).arrayBuffer()
      const [entry] = await logged(id)
      const crossSite = await replay(base, entry?.id ?? "", { "sec-fetch-site": "cross-site" })
      expect(crossSite.status).toBe(403)
      const otherOrigin = await replay(base, entry?.id ?? "", { origin: "http://evil.example" })
      expect(otherOrigin.status).toBe(403)
      expect(await logged(id)).toHaveLength(1)
    })
  }, 10000)

  it("an entry that aged out of the log is a clear 404, with JS or without", async () => {
    await withImposter(9567, [ordersStub], async (id, base) => {
      await (await fetch(`${base}/orders`)).arrayBuffer()
      const [first] = await logged(id)
      // The log keeps the latest 100
      for (let i = 0; i < 100; i++) await (await fetch(`${base}/orders`)).arrayBuffer()
      expect((await logged(id)).some((e) => e.id === first?.id)).toBe(false)

      const resp = await replay(base, first?.id ?? "")
      expect(resp.status).toBe(404)
      const html = await resp.text()
      expect(html).toContain("<!DOCTYPE html>")
      expect(html).toContain("request not found")
      expect(html).toContain("so there is nothing to replay")

      const viaJs = await replay(base, first?.id ?? "", { ...SAME_ORIGIN, "x-imposters-fragment": "1" })
      expect(viaJs.status).toBe(404)
      expect(await viaJs.text()).toContain("no longer in the log")
      expect(await logged(id)).toHaveLength(100)
    })
  }, 20000)

  it("a body the log could not keep cannot be replayed, and says why", async () => {
    await withImposter(9568, [], async (id, base) => {
      await (await fetch(`${base}/upload`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([0xff, 0xfe, 0x00, 0x80])
      })).arrayBuffer()
      const [entry] = await logged(id)
      const html = await page(base, entry?.id ?? "")
      expect(html).toContain("a body of 4 bytes that is not text")

      const resp = await replay(base, entry?.id ?? "")
      expect(resp.status).toBe(422)
      expect(await resp.text()).toContain("body was not text")
      expect(await logged(id)).toHaveLength(1)
    })
  }, 10000)
})
