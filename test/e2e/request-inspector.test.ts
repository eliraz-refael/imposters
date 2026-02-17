import { HttpApiBuilder } from "@effect/platform"
import * as Layer from "effect/Layer"
import { ApiLayer } from "imposters/layers/ApiLayer"
import { ImposterRepositoryLive } from "imposters/repositories/ImposterRepository"
import { FiberManagerLive } from "imposters/server/FiberManager"
import { ImposterServerLive } from "imposters/server/ImposterServer"
import { AppConfigLive } from "imposters/services/AppConfig"
import { MetricsServiceLive } from "imposters/services/MetricsService"
import { PortAllocatorLive } from "imposters/services/PortAllocator"
import { ProxyServiceLive } from "imposters/services/ProxyService"
import { RequestLoggerLive } from "imposters/services/RequestLogger"
import { UuidLive } from "imposters/services/UuidLive"
import { NodeServerFactoryLive } from "imposters/test/helpers/NodeServerFactory"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const PortAllocatorWithDeps = PortAllocatorLive.pipe(Layer.provide(AppConfigLive))
const ProxyServiceWithDeps = ProxyServiceLive.pipe(Layer.provide(UuidLive))

const ImposterServerWithDeps = ImposterServerLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      FiberManagerLive,
      ImposterRepositoryLive,
      NodeServerFactoryLive,
      RequestLoggerLive,
      MetricsServiceLive,
      ProxyServiceWithDeps
    )
  )
)
const MainLayer = Layer.mergeAll(
  UuidLive,
  AppConfigLive,
  PortAllocatorWithDeps,
  ImposterRepositoryLive,
  FiberManagerLive,
  RequestLoggerLive,
  MetricsServiceLive,
  ImposterServerWithDeps
)
const FullLayer = ApiLayer.pipe(Layer.provide(MainLayer))

let adminHandler: (request: Request) => Promise<Response>
let dispose: () => void

beforeAll(() => {
  const result = HttpApiBuilder.toWebHandler(FullLayer)
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
    await new Promise((r) => setTimeout(r, 150))

    try {
      const resp = await fetch("http://localhost:9611/_admin/requests")
      expect(resp.status).toBe(200)
      const html = await resp.text()
      expect(html).toContain("<!DOCTYPE html>")
      expect(html).toContain("Requests")
      expect(html).toContain("Send Test Request")
      expect(html).toContain("Filter")
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("requests appear in the log after making them", async () => {
    const imp = await createImposter(9612)
    await addStub(imp.id, {
      predicates: [],
      responses: [{ status: 200, body: { ok: true } }]
    })
    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      // Make a request that gets logged
      await fetch("http://localhost:9612/api/test")
      await new Promise((r) => setTimeout(r, 50))

      // Check the log page
      const resp = await fetch("http://localhost:9612/_admin/requests")
      const html = await resp.text()
      expect(html).toContain("/api/test")
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("GET /requests/list filters by method", async () => {
    const imp = await createImposter(9613)
    await addStub(imp.id, {
      predicates: [],
      responses: [{ status: 200, body: { ok: true } }]
    })
    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      // Make GET and POST requests
      await fetch("http://localhost:9613/test")
      await fetch("http://localhost:9613/test", { method: "POST", body: "data" })
      await new Promise((r) => setTimeout(r, 50))

      // Filter by POST
      const resp = await fetch("http://localhost:9613/_admin/requests/list?method=POST")
      const html = await resp.text()
      expect(html).toContain("POST")
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("DELETE /_admin/requests clears the log", async () => {
    const imp = await createImposter(9614)
    await addStub(imp.id, {
      predicates: [],
      responses: [{ status: 200, body: { ok: true } }]
    })
    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      // Make a request
      await fetch("http://localhost:9614/test")
      await new Promise((r) => setTimeout(r, 50))

      // Clear the log
      const delResp = await fetch("http://localhost:9614/_admin/requests", { method: "DELETE" })
      expect(delResp.status).toBe(200)
      const html = await delResp.text()
      expect(html).toContain("No requests recorded")
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("GET /_admin/requests/:id shows request detail", async () => {
    const imp = await createImposter(9615)
    await addStub(imp.id, {
      predicates: [],
      responses: [{ status: 200, body: { detail: "test" } }]
    })
    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      // Make a request
      await fetch("http://localhost:9615/my-path")
      await new Promise((r) => setTimeout(r, 50))

      // Get the request list to find the entry id
      const listResp = await fetch("http://localhost:9615/_admin/requests")
      const listHtml = await listResp.text()
      // Extract the entry ID from the detail link
      const match = listHtml.match(/\/_admin\/requests\/([a-f0-9-]+)/)
      expect(match).not.toBeNull()
      const entryId = match![1]

      // Get the detail page
      const detailResp = await fetch(`http://localhost:9615/_admin/requests/${entryId}`)
      expect(detailResp.status).toBe(200)
      const detailHtml = await detailResp.text()
      expect(detailHtml).toContain("/my-path")
      expect(detailHtml).toContain("Request")
      expect(detailHtml).toContain("Response")
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("POST /_admin/requests/test sends test request and returns result", async () => {
    const imp = await createImposter(9616)
    await addStub(imp.id, {
      predicates: [{ field: "path", operator: "equals", value: "/api/echo" }],
      responses: [{ status: 200, body: { echoed: true } }]
    })
    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

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
      const html = await resp.text()
      expect(html).toContain("Response")
      expect(html).toContain("200")
      expect(html).toContain("echoed")
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)
})
