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

describe("E2E: Statistics", () => {
  it("returns zero stats for imposter with no requests", async () => {
    const imp = await createImposter(9301)
    const resp = await admin(`/imposters/${imp.id}/stats`)
    expect(resp.status).toBe(200)
    const stats = await resp.json()
    expect(stats.totalRequests).toBe(0)
    expect(stats.requestsPerMinute).toBe(0)
    expect(stats.errorRate).toBe(0)
  }, 10000)

  it("tracks request statistics after serving requests", async () => {
    const imp = await createImposter(9302)
    await addStub(imp.id, {
      predicates: [{ field: "method", operator: "equals", value: "GET" }],
      responses: [{ status: 200, body: { ok: true } }]
    })
    await addStub(imp.id, {
      predicates: [{ field: "method", operator: "equals", value: "POST" }],
      responses: [{ status: 201, body: { created: true } }]
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      // Make some requests
      await fetch("http://localhost:9302/a")
      await fetch("http://localhost:9302/b")
      await fetch("http://localhost:9302/c", { method: "POST" })

      // Small delay for async logging
      await new Promise((r) => setTimeout(r, 100))

      const resp = await admin(`/imposters/${imp.id}/stats`)
      expect(resp.status).toBe(200)
      const stats = await resp.json()

      expect(stats.totalRequests).toBe(3)
      expect(stats.requestsByMethod.GET).toBe(2)
      expect(stats.requestsByMethod.POST).toBe(1)
      expect(stats.requestsByStatusCode["200"]).toBe(2)
      expect(stats.requestsByStatusCode["201"]).toBe(1)
      expect(stats.errorRate).toBe(0)
      expect(stats.lastRequestAt).toBeDefined()
      expect(stats.p50ResponseTime).toBeDefined()
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("resets stats via DELETE", async () => {
    const imp = await createImposter(9303)
    await addStub(imp.id, {
      predicates: [],
      responses: [{ status: 200 }]
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      await fetch("http://localhost:9303/something")
      await new Promise((r) => setTimeout(r, 100))

      // Verify stats exist
      let resp = await admin(`/imposters/${imp.id}/stats`)
      let stats = await resp.json()
      expect(stats.totalRequests).toBe(1)

      // Reset stats
      resp = await admin(`/imposters/${imp.id}/stats`, { method: "DELETE" })
      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body.message).toContain("reset")

      // Verify stats are cleared
      resp = await admin(`/imposters/${imp.id}/stats`)
      stats = await resp.json()
      expect(stats.totalRequests).toBe(0)
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("returns 404 for stats of nonexistent imposter", async () => {
    const resp = await admin("/imposters/nonexistent/stats")
    expect(resp.status).toBe(404)
  })
})
