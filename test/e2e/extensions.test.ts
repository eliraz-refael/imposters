import { Effect, ManagedRuntime } from "effect"
import { ImpostersClient } from "imposters/client/ImpostersClient"
import { makeTestServer, withImposter } from "imposters/client/testing"
import { httpGet } from "imposters/test/helpers/net"
import { BoomExtension, EchoExtension } from "imposters/test/helpers/TestExtensions"
import { makeAdminUiRouter } from "imposters/ui/admin/AdminUiRouter"
import { afterAll, describe, expect, it } from "vitest"

// Ports 9801-9815 belong to this file.

const server = makeTestServer({ extensions: [EchoExtension, BoomExtension] })
const clientRuntime = ManagedRuntime.make(server.clientLayer)

afterAll(async () => {
  await clientRuntime.dispose()
  server.dispose()
})

const admin = (path: string, init?: RequestInit) => server.handler(new Request(`http://localhost:2525${path}`, init))

const sendJson = (method: string, path: string, body: unknown) =>
  admin(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

const createImposter = async (body: Record<string, unknown>) => {
  const resp = await sendJson("POST", "/imposters", body)
  expect(resp.status).toBe(201)
  const created: { id: string; port: number; protocol: string } = await resp.json()
  return created
}

const setStatus = async (id: string, status: "running" | "stopped") => {
  const resp = await sendJson("PATCH", `/imposters/${id}`, { status })
  expect(resp.status).toBe(200)
}

const addStub = async (id: string, stub: unknown) => {
  const resp = await sendJson("POST", `/imposters/${id}/stubs`, stub)
  expect(resp.status).toBe(201)
}

const remove = (id: string) => admin(`/imposters/${id}?force=true`, { method: "DELETE" })

// A start on a fresh imposter that answers ECHO requests
const startEcho = async (port: number) => {
  const imp = await createImposter({ port, protocol: "ECHO" })
  await setStatus(imp.id, "running")
  return imp
}

describe("extensions: creating imposters", () => {
  it("rejects a protocol no extension provides with 400 and the available list", async () => {
    const resp = await sendJson("POST", "/imposters", { port: 9801, protocol: "S3" })
    expect(resp.status).toBe(400)
    const body = await resp.json()
    expect(body._tag).toBe("ApiBadRequestError")
    expect(body.message).toBe(`Unknown protocol "S3". Available: HTTP, ECHO, BOOM`)

    // Nothing was created, and the port was not taken
    const imp = await createImposter({ port: 9801 })
    await remove(imp.id)
  })

  it("rejects a malformed protocol at decode time", async () => {
    const resp = await sendJson("POST", "/imposters", { port: 9802, protocol: "echo" })
    expect(resp.status).toBe(400)
    expect((await resp.json())._tag).toBe("HttpApiDecodeError")
  })

  it("creates an imposter for a registered protocol", async () => {
    const imp = await createImposter({ port: 9802, protocol: "ECHO" })
    expect(imp.protocol).toBe("ECHO")
    const fetched = await (await admin(`/imposters/${imp.id}`)).json()
    expect(fetched.protocol).toBe("ECHO")
    await remove(imp.id)
  })

  it("rejects proxy on a non-HTTP imposter, on create and on PATCH", async () => {
    const proxy = { targetUrl: "http://localhost:9899", mode: "passthrough" }

    const onCreate = await sendJson("POST", "/imposters", { port: 9803, protocol: "ECHO", proxy })
    expect(onCreate.status).toBe(400)
    expect((await onCreate.json()).message).toContain("Proxy is only supported on HTTP imposters")

    const imp = await createImposter({ port: 9803, protocol: "ECHO" })
    const onPatch = await sendJson("PATCH", `/imposters/${imp.id}`, { proxy })
    expect(onPatch.status).toBe(400)
    expect((await onPatch.json())._tag).toBe("ApiBadRequestError")
    expect((await (await admin(`/imposters/${imp.id}`)).json()).proxy).toBeUndefined()

    // Removing a proxy is a no-op, so it stays allowed
    expect((await sendJson("PATCH", `/imposters/${imp.id}`, { proxy: null })).status).toBe(200)
    await remove(imp.id)
  })

  it("/info lists HTTP first, then the registered protocols", async () => {
    const body = await (await admin("/info")).json()
    expect(body.server.protocols).toEqual(["HTTP", "ECHO", "BOOM"])
  })

  it("the /_ui imposter list shows each imposter's protocol", async () => {
    const imp = await createImposter({ port: 9813, name: "echo-in-ui", protocol: "ECHO" })
    try {
      const ui = makeAdminUiRouter({ apiHandler: server.handler, adminPort: 2525 })
      const resp = await ui(new Request("http://localhost:2525/_ui/imposters"))
      const html = (await resp?.text()) ?? ""
      const row = html.slice(html.indexOf(`id="row-${imp.id}"`))
      expect(row).toContain("echo-in-ui")
      expect(row.slice(0, row.indexOf("</tr>"))).toContain(">ECHO</td>")
    } finally {
      await remove(imp.id)
    }
  })

  it("the list filter selects by protocol", async () => {
    const http = await createImposter({ port: 9804 })
    const echo = await createImposter({ port: 9805, protocol: "ECHO" })
    try {
      const ids = async (query: string) => {
        const body: { imposters: ReadonlyArray<{ id: string; protocol: string }> } =
          await (await admin(`/imposters${query}`)).json()
        return body.imposters.filter((i) => i.id === http.id || i.id === echo.id).map((i) => [i.id, i.protocol])
      }
      expect(await ids("?protocol=ECHO")).toEqual([[echo.id, "ECHO"]])
      expect(await ids("?protocol=HTTP")).toEqual([[http.id, "HTTP"]])
      expect(await ids("?protocol=BOOM")).toEqual([])
      expect(await ids("")).toHaveLength(2)
    } finally {
      await remove(http.id)
      await remove(echo.id)
    }
  })
})

describe("extensions: serving requests", () => {
  it("stubs take precedence; unmatched requests reach the extension", async () => {
    const imp = await createImposter({ port: 9806, protocol: "ECHO" })
    try {
      await addStub(imp.id, {
        predicates: [{ field: "path", operator: "equals", value: "/stubbed" }],
        responses: [{ status: 201, body: { from: "stub" } }]
      })
      await setStatus(imp.id, "running")

      const stubbed = await fetch("http://localhost:9806/stubbed")
      expect(stubbed.status).toBe(201)
      expect(await stubbed.json()).toEqual({ from: "stub" })
      expect(stubbed.headers.get("x-echo-count")).toBeNull()

      const echoed = await fetch("http://localhost:9806/anything?x=1", {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: "hello"
      })
      expect(echoed.status).toBe(200)
      expect(echoed.headers.get("x-echo-route")).toBe("PUT /anything")
      expect(echoed.headers.get("x-echo-imposter")).toBe(imp.id)
      expect(await echoed.text()).toBe("hello")
    } finally {
      await remove(imp.id)
    }
  })

  it("binary bodies pass through the extension byte for byte", async () => {
    const imp = await startEcho(9807)
    try {
      // Every byte value, including ones that are never valid UTF-8
      const bytes = new Uint8Array(Array.from({ length: 512 }, (_, i) => (i * 37) % 256))
      const resp = await fetch("http://localhost:9807/blob", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
      expect(resp.status).toBe(200)
      expect(new Uint8Array(await resp.arrayBuffer())).toEqual(bytes)
    } finally {
      await remove(imp.id)
    }
  })

  it("extension responses are in the request log and the stats", async () => {
    const imp = await createImposter({ port: 9808, protocol: "ECHO" })
    try {
      await addStub(imp.id, {
        predicates: [{ field: "path", operator: "equals", value: "/stubbed" }],
        responses: [{ status: 200, body: "stub" }]
      })
      await setStatus(imp.id, "running")
      await (await fetch("http://localhost:9808/stubbed")).text()
      await (await fetch("http://localhost:9808/echoed", { method: "POST", body: "ping" })).text()

      const log: ReadonlyArray<{
        request: { path: string }
        response: { status: number; body?: string; matchedStubId?: string; proxied: boolean }
      }> = await (await admin(`/imposters/${imp.id}/requests`)).json()
      const byPath = new Map(log.map((entry) => [entry.request.path, entry.response]))
      expect(byPath.get("/echoed")).toMatchObject({ status: 200, body: "ping", proxied: false })
      expect(byPath.get("/echoed")?.matchedStubId).toBeUndefined()
      expect(byPath.get("/stubbed")?.matchedStubId).toBeDefined()
      expect(byPath.get("/stubbed")?.proxied).toBe(false)

      const stats = await (await admin(`/imposters/${imp.id}/stats`)).json()
      expect(stats.totalRequests).toBe(2)
      expect(stats.requestsByMethod).toEqual({ GET: 1, POST: 1 })
    } finally {
      await remove(imp.id)
    }
  })

  it("make runs on every start, so extension state resets on stop/start", async () => {
    const imp = await startEcho(9809)
    try {
      // A fresh connection per request: a pooled one would still point at the stopped server
      const count = async () => (await httpGet(9809, "/")).headers["x-echo-count"]
      expect(await count()).toBe("1")
      expect(await count()).toBe("2")
      expect(await count()).toBe("3")

      await setStatus(imp.id, "stopped")
      await setStatus(imp.id, "running")
      expect(await count()).toBe("1")
    } finally {
      await remove(imp.id)
    }
  })

  it("/_admin still serves the imposter UI on an extension imposter", async () => {
    const imp = await startEcho(9810)
    try {
      const resp = await fetch("http://localhost:9810/_admin")
      expect(resp.status).toBe(200)
      expect(resp.headers.get("content-type")).toContain("text/html")
      expect(resp.headers.get("x-echo-count")).toBeNull()
    } finally {
      await remove(imp.id)
    }
  })

  it("an extension defect becomes a logged 500, and the imposter keeps serving", async () => {
    const imp = await createImposter({ port: 9811, protocol: "BOOM" })
    try {
      await setStatus(imp.id, "running")
      const first = await fetch("http://localhost:9811/x")
      expect(first.status).toBe(500)
      expect((await first.json()).error).toBe("Internal server error")
      expect((await fetch("http://localhost:9811/y")).status).toBe(500)
    } finally {
      await remove(imp.id)
    }
  })
})

describe("extensions: test helpers", () => {
  it("withImposter creates, starts and cleans up an extension imposter", async () => {
    await clientRuntime.runPromise(
      withImposter(
        { port: 9812, protocol: "ECHO", stubs: [{ predicates: [], responses: [{ status: 418 }] }] },
        (ctx) =>
          Effect.gen(function*() {
            const client = yield* ImpostersClient
            const imp = yield* client.imposters.getImposter({ params: { id: ctx.id } })
            expect(imp.protocol).toBe("ECHO")
            // The catch-all stub wins over the extension
            const resp = yield* Effect.promise(() => fetch(`http://localhost:${ctx.port}/`))
            expect(resp.status).toBe(418)
          })
      )
    )
    const list = await (await admin("/imposters?protocol=ECHO")).json()
    expect(list.imposters.filter((i: { port: number }) => i.port === 9812)).toEqual([])
  })
})
