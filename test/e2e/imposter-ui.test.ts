import * as Layer from "effect/Layer"
import { HttpRouter } from "effect/unstable/http"
import { ApiLayer } from "imposters/layers/ApiLayer"
import { MainLayer } from "imposters/layers/MainLayer"
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
  it("GET /_admin returns HTML dashboard with imposter info", async () => {
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

      const html = await resp.text()
      expect(html).toContain("<!DOCTYPE html>")
      expect(html).toContain("Dashboard")
      expect(html).toContain("port 9601")
      expect(html).toContain("Stubs")
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
      expect(html).toContain("Add Stub")
      // Should contain the stub's predicate summary
      expect(html).toContain("path")
      expect(html).toContain("equals")
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)

  it("POST /_admin/stubs adds a stub via form data", async () => {
    const imp = await createImposter(9603)
    await startImposter(imp.id)

    try {
      // Add a stub via the UI form
      const formData = new URLSearchParams()
      formData.set("predicates", "[]")
      formData.set("responses", "[{\"status\": 201, \"body\": {\"added\": true}}]")
      formData.set("responseMode", "sequential")

      const postResp = await fetch("http://localhost:9603/_admin/stubs", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formData.toString()
      })
      expect(postResp.status).toBe(200)
      const postHtml = await postResp.text()
      // Response should contain the new stub card
      expect(postHtml).toContain("sequential")
      expect(postHtml).toContain("catch-all")

      // Verify the stub actually works
      const stubResp = await fetch("http://localhost:9603/anything")
      expect(stubResp.status).toBe(201)
      const body = await stubResp.json()
      expect(body).toEqual({ added: true })
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)

  it("DELETE /_admin/stubs/:id removes a stub", async () => {
    const imp = await createImposter(9604)
    // Add via admin API so we get the stub ID
    const stubResp = await admin(`/imposters/${imp.id}/stubs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        predicates: [{ field: "path", operator: "equals", value: "/to-delete" }],
        responses: [{ status: 200 }]
      })
    })
    const stub = await stubResp.json()
    await startImposter(imp.id)

    try {
      // Verify stub matches
      const before = await fetch("http://localhost:9604/to-delete")
      expect(before.status).toBe(200)

      // Delete via UI
      const delResp = await fetch(`http://localhost:9604/_admin/stubs/${stub.id}`, {
        method: "DELETE"
      })
      expect(delResp.status).toBe(200)
      const delHtml = await delResp.text()
      // Should no longer contain the stub
      expect(delHtml).toContain("No stubs configured")

      // Verify stub no longer matches (404)
      const after = await fetch("http://localhost:9604/to-delete")
      expect(after.status).toBe(404)
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

// Regression tests for the UI audit. Ports 9621-9639 belong to this block.
const form = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "hx-request": "true" },
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
      expect(page).toMatch(/>\d{2}:\d{2}:\d{2} UTC</)
      const list = await (await fetch("http://localhost:9624/_admin/requests/list")).text()
      expect(list).toMatch(/>\d{2}:\d{2}:\d{2} UTC</)
    })
  }, 10000)

  it("rejects an invalid stub with a visible 400 and leaves the imposter healthy", async () => {
    await withRunningImposter(9625, async (id) => {
      const cases: Array<[Record<string, string>, string]> = [
        [{ predicates: "not json", responses: "[{\"status\":200}]" }, "predicates"],
        [{ predicates: "{\"a\":1}", responses: "[{\"status\":200}]" }, "predicates"],
        [{ predicates: "[]", responses: "[{\"status\":99}]" }, "status"],
        [{ predicates: "[]", responses: "[{\"status\":200}]", responseMode: "bogus" }, "responseMode"],
        [{ predicates: "[{\"field\":\"nope\",\"operator\":\"equals\",\"value\":1}]", responses: "[{}]" }, "field"],
        [{ predicates: "[]", responses: "[]" }, "non-empty"],
        [{ predicates: "[]", responses: "" }, "required"]
      ]
      for (const [fields, mentions] of cases) {
        const resp = await fetch("http://localhost:9625/_admin/stubs", form(fields))
        expect(resp.status).toBe(400)
        expect(resp.headers.get("hx-retarget")).toBe("#ui-error")
        expect(await resp.text()).toContain(mentions)
      }

      // Nothing was stored, so the pages and the API still work
      expect((await fetch("http://localhost:9625/_admin/stubs")).status).toBe(200)
      const stubs = await admin(`/imposters/${id}/stubs`)
      expect(stubs.status).toBe(200)
      expect(await stubs.json()).toEqual([])
    })
  }, 10000)

  it("a UI stub gets the API's defaults (status 200, case-sensitive predicates)", async () => {
    await withRunningImposter(9626, async (id) => {
      const resp = await fetch(
        "http://localhost:9626/_admin/stubs",
        form({
          predicates: "[{\"field\":\"path\",\"operator\":\"equals\",\"value\":\"/Case\"}]",
          responses: "[{\"body\":\"ok\"}]",
          responseMode: ""
        })
      )
      expect(resp.status).toBe(200)

      const hit = await fetch("http://localhost:9626/Case")
      expect(hit.status).toBe(200)
      expect(await hit.text()).toBe("ok")
      expect((await fetch("http://localhost:9626/case")).status).toBe(404)

      const stubs: Array<Record<string, unknown>> = await (await admin(`/imposters/${id}/stubs`)).json()
      expect(stubs[0]).toMatchObject({ responseMode: "sequential", responses: [{ status: 200, body: "ok" }] })
    })
  }, 10000)

  it("hot reload: a UI-added stub answers at once, and deleting it stops the match", async () => {
    await withRunningImposter(9627, async (id) => {
      await fetch(
        "http://localhost:9627/_admin/stubs",
        form({
          predicates: "[{\"field\":\"path\",\"operator\":\"equals\",\"value\":\"/hot\"}]",
          responses: "[{\"status\":201}]"
        })
      )
      expect((await fetch("http://localhost:9627/hot")).status).toBe(201)

      const stubs: Array<{ id: string }> = await (await admin(`/imposters/${id}/stubs`)).json()
      const del = await fetch(`http://localhost:9627/_admin/stubs/${stubs[0]?.id ?? ""}`, { method: "DELETE" })
      expect(del.status).toBe(200)
      expect((await fetch("http://localhost:9627/hot")).status).toBe(404)
    })
  }, 10000)

  it("deleting a stub that is already gone is a visible 404 that refreshes the list", async () => {
    await withRunningImposter(9628, async () => {
      const resp = await fetch("http://localhost:9628/_admin/stubs/missing", { method: "DELETE" })
      expect(resp.status).toBe(404)
      expect(resp.headers.get("hx-retarget")).toBe("#ui-error")
      const body = await resp.text()
      expect(body).toContain("Stub missing no longer exists")
      expect(body).toContain("id=\"stub-list\" hx-swap-oob=\"innerHTML\"")
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

  it("Send Test Request: a path without a leading slash works, and errors are escaped 400s", async () => {
    await withRunningImposter(9630, async (id) => {
      await addStub(id, {
        predicates: [{ field: "path", operator: "equals", value: "/ping" }],
        responses: [{ status: 200, body: "pong" }]
      })
      const ok = await fetch("http://localhost:9630/_admin/requests/test", form({ method: "GET", path: "ping" }))
      expect(ok.status).toBe(200)
      expect(await ok.text()).toContain("pong")

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

  it("PUT /_admin/stubs/:id validates like add, and updates only the fields given", async () => {
    await withRunningImposter(9634, async (id) => {
      await addStub(id, {
        predicates: [{ field: "path", operator: "equals", value: "/put" }],
        responses: [{ status: 200 }]
      })
      const stubs: Array<{ id: string }> = await (await admin(`/imposters/${id}/stubs`)).json()
      const url = `http://localhost:9634/_admin/stubs/${stubs[0]?.id ?? ""}`

      const bad = await fetch(url, { ...form({ responses: "[{\"status\":1}]" }), method: "PUT" })
      expect(bad.status).toBe(400)
      expect((await fetch("http://localhost:9634/put")).status).toBe(200)

      const ok = await fetch(url, { ...form({ responses: "[{\"status\":202}]" }), method: "PUT" })
      expect(ok.status).toBe(200)
      expect((await fetch("http://localhost:9634/put")).status).toBe(202)

      const missing = await fetch("http://localhost:9634/_admin/stubs/nope", {
        ...form({ responseMode: "repeat" }),
        method: "PUT"
      })
      expect(missing.status).toBe(404)
    })
  }, 10000)

  it("a non-numeric status filter is a visible 400, not an empty table", async () => {
    await withRunningImposter(9631, async () => {
      const resp = await fetch("http://localhost:9631/_admin/requests/list?status=abc")
      expect(resp.status).toBe(400)
      expect(resp.headers.get("hx-retarget")).toBe("#ui-error")
      expect(await resp.text()).toContain("Status filter must be a number")
    })
  }, 10000)

  it("a detail link for an unknown request id is a 404 page inside the layout", async () => {
    await withRunningImposter(9632, async () => {
      const resp = await fetch("http://localhost:9632/_admin/requests/no-such-id")
      expect(resp.status).toBe(404)
      const page = await resp.text()
      expect(page).toContain("<!DOCTYPE html>")
      expect(page).toContain("Request not found")
      expect(page).toContain("Back to Requests")
      expect(page).toContain("no-such-id")
    })
  }, 10000)

  it("the request detail page shows the instant in UTC and the matched stub without a Delete button", async () => {
    await withRunningImposter(9633, async (id) => {
      await addStub(id, { predicates: [], responses: [{ status: 200, body: "<script>alert(1)</script>" }] })
      await fetch("http://localhost:9633/x")
      const list = await (await fetch("http://localhost:9633/_admin/requests")).text()
      const link = /href="(\/_admin\/requests\/[0-9a-f-]{36})"/.exec(list)?.[1]
      expect(link).toBeDefined()
      const page = await (await fetch(`http://localhost:9633${link ?? ""}`)).text()
      expect(page).toMatch(/Timestamp: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
      expect(page).toContain("Matched Stub")
      expect(page).not.toContain("hx-delete")
      expect(page).not.toContain("<script>alert(1)</script>")
    })
  }, 10000)

  it("refuses a form post a browser marks cross-site, and adds no stub", async () => {
    await withRunningImposter(9635, async (id) => {
      const stubForm = new URLSearchParams({ predicates: "[]", responses: "[{\"status\": 201}]" }).toString()
      const refused = await fetch("http://localhost:9635/_admin/stubs", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" },
        body: stubForm
      })
      expect(refused.status).toBe(403)
      // Without Sec-Fetch-Site (a LAN address over http), an Origin naming another host is refused too
      const foreignOrigin = await fetch("http://localhost:9635/_admin/stubs", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://evil.example" },
        body: stubForm
      })
      expect(foreignOrigin.status).toBe(403)
      const stubs: Array<unknown> = await (await admin(`/imposters/${id}/stubs`)).json()
      expect(stubs).toEqual([])

      // The UI's own posts are same-origin
      const own = await fetch("http://localhost:9635/_admin/stubs", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
        body: stubForm
      })
      expect(own.status).toBe(200)
      expect(await (await admin(`/imposters/${id}/stubs`)).json()).toHaveLength(1)
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
})
