import * as Layer from "effect/Layer"
import { HttpRouter } from "effect/unstable/http"
import { ApiLayer } from "imposters/layers/ApiLayer"
import { MainLayer } from "imposters/layers/MainLayer"
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

describe("E2E: Request Inspector", () => {
  it("GET /_admin/requests returns HTML request log page", async () => {
    const imp = await createImposter(9611)
    await addStub(imp.id, {
      predicates: [],
      responses: [{ status: 200, body: { ok: true } }]
    })
    await startImposter(imp.id)

    try {
      const resp = await fetch("http://localhost:9611/_admin/requests")
      expect(resp.status).toBe(200)
      const html = await resp.text()
      expect(html).toContain("<!DOCTYPE html>")
      expect(html).toContain(`<h2 class="page-title">requests</h2>`)
      expect(html).toContain("send a request")
      expect(html).toContain(`<form class="panel filters" method="get" action="/_admin/requests"`)
      expect(html).toContain("nothing logged yet")
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)

  it("requests appear in the log after making them", async () => {
    const imp = await createImposter(9612)
    await addStub(imp.id, {
      predicates: [],
      responses: [{ status: 200, body: { ok: true } }]
    })
    await startImposter(imp.id)

    try {
      // Make a request that gets logged
      await fetch("http://localhost:9612/api/test")

      // Check the log page
      const resp = await fetch("http://localhost:9612/_admin/requests")
      const html = await resp.text()
      expect(html).toContain("/api/test")
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)

  it("GET /_admin/requests?method= filters by method, path and status", async () => {
    const imp = await createImposter(9613)
    await addStub(imp.id, {
      predicates: [],
      responses: [{ status: 200, body: { ok: true } }]
    })
    await startImposter(imp.id)

    try {
      // Make GET and POST requests
      await fetch("http://localhost:9613/test")
      await fetch("http://localhost:9613/test", { method: "POST", body: "data" })
      await fetch("http://localhost:9613/other", { method: "POST", body: "data" })

      const methods = (page: string) => Array.from(page.matchAll(/class="req-method [^"]*">([A-Z]+)</g), (m) => m[1])
      const paths = (page: string) => Array.from(page.matchAll(/class="req-path ellipsis"[^>]*>([^<]*)</g), (m) => m[1])

      const posts = await (await fetch("http://localhost:9613/_admin/requests?method=post")).text()
      expect(methods(posts)).toEqual(["POST", "POST"])
      expect(posts).toContain("2 of 3 requests")
      // The select shows the filter in use
      expect(posts).toContain(`<option value="POST" selected>POST</option>`)

      const one = await (await fetch("http://localhost:9613/_admin/requests?method=POST&path=%2Ftest&status=200"))
        .text()
      expect(paths(one)).toEqual(["/test"])
      expect(methods(one)).toEqual(["POST"])

      const none = await (await fetch("http://localhost:9613/_admin/requests?status=500")).text()
      expect(paths(none)).toEqual([])
      expect(none).toContain("no logged request matches these filters")

      // Newest first, unfiltered
      const all = await (await fetch("http://localhost:9613/_admin/requests")).text()
      expect(paths(all)).toEqual(["/other", "/test", "/test"])
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)

  it("POST /_admin/requests/clear clears the log and goes back to the list", async () => {
    const imp = await createImposter(9614)
    await addStub(imp.id, {
      predicates: [],
      responses: [{ status: 200, body: { ok: true } }]
    })
    await startImposter(imp.id)

    try {
      // Make a request
      await fetch("http://localhost:9614/test")

      // A page on another site cannot clear it
      const refused = await fetch("http://localhost:9614/_admin/requests/clear", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" }
      })
      expect(refused.status).toBe(403)
      expect(await (await fetch("http://localhost:9614/_admin/requests")).text()).toContain("1 request<")

      // Clear the log
      const cleared = await fetch("http://localhost:9614/_admin/requests/clear", {
        method: "POST",
        redirect: "manual",
        headers: { "sec-fetch-site": "same-origin" }
      })
      expect(cleared.status).toBe(303)
      expect(cleared.headers.get("location")).toBe("/_admin/requests")
      const html = await (await fetch("http://localhost:9614/_admin/requests")).text()
      expect(html).toContain("nothing logged yet")
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)

  it("GET /_admin/requests/:id shows request detail", async () => {
    const imp = await createImposter(9615)
    await addStub(imp.id, {
      predicates: [],
      responses: [{ status: 200, body: { detail: "test" } }]
    })
    await startImposter(imp.id)

    try {
      // Make a request
      await fetch("http://localhost:9615/my-path")

      // Get the request list to find the entry id
      const listResp = await fetch("http://localhost:9615/_admin/requests")
      const listHtml = await listResp.text()
      // Extract the entry ID from the detail link
      const match = listHtml.match(/\/_admin\/requests\/([a-f0-9-]{36})"/)
      expect(match).not.toBeNull()
      const entryId = match?.[1] ?? ""

      // Get the detail page
      const detailResp = await fetch(`http://localhost:9615/_admin/requests/${entryId}`)
      expect(detailResp.status).toBe(200)
      const detailHtml = await detailResp.text()
      expect(detailHtml).toContain("/my-path")
      expect(detailHtml).toContain(`aria-label="Request"`)
      expect(detailHtml).toContain(`aria-label="Response"`)
      expect(detailHtml).toContain("&quot;detail&quot;: &quot;test&quot;")
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)

  it("POST /_admin/requests/test sends a request and answers with its page", async () => {
    const imp = await createImposter(9616)
    await addStub(imp.id, {
      predicates: [{ field: "path", operator: "equals", value: "/api/echo" }],
      responses: [{ status: 200, body: { echoed: true } }]
    })
    await startImposter(imp.id)

    try {
      const formData = new URLSearchParams()
      formData.set("method", "GET")
      formData.set("path", "/api/echo")
      formData.set("contentType", "application/json")
      formData.set("headers", "")
      formData.set("body", "")

      const resp = await fetch("http://localhost:9616/_admin/requests/test", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formData.toString()
      })
      expect(resp.status).toBe(200)
      expect(resp.redirected).toBe(true)
      const html = await resp.text()
      expect(html).toContain(`aria-label="Response"`)
      expect(html).toContain("200 OK")
      expect(html).toContain("echoed")
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)
})
