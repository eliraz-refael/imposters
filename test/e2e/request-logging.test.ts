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

describe("E2E: Request Logging", () => {
  it("logs requests sent to an imposter and retrieves them via admin API", async () => {
    const imp = await createImposter(9511)
    const stubResp = await admin(`/imposters/${imp.id}/stubs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        predicates: [{ field: "path", operator: "equals", value: "/hello" }],
        responses: [{ status: 200, body: { greeting: "hi" } }]
      })
    })
    const stub = await stubResp.json()

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      // Send requests to the imposter
      await fetch("http://localhost:9511/hello")
      await fetch("http://localhost:9511/hello?name=world")
      await new Promise((r) => setTimeout(r, 100))

      // Query request log
      const res = await admin(`/imposters/${imp.id}/requests`)
      expect(res.status).toBe(200)
      const entries = await res.json()
      expect(entries.length).toBe(2)

      // Verify entry structure
      const entry = entries[0]
      expect(entry.id).toBeDefined()
      expect(entry.imposterId).toBe(imp.id)
      expect(entry.request.method).toBe("GET")
      expect(entry.request.path).toBe("/hello")
      expect(entry.response.status).toBe(200)
      expect(entry.response.matchedStubId).toBe(stub.id)
      expect(entry.duration).toBeGreaterThanOrEqual(0)
      expect(entry.timestamp).toBeDefined()
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("logs 404 responses with no matchedStubId", async () => {
    const imp = await createImposter(9512)
    await addStub(imp.id, {
      predicates: [{ field: "path", operator: "equals", value: "/specific" }],
      responses: [{ status: 200 }]
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      // Send a request that won't match any stub
      await fetch("http://localhost:9512/nomatch")
      await new Promise((r) => setTimeout(r, 100))

      const res = await admin(`/imposters/${imp.id}/requests`)
      const entries = await res.json()
      expect(entries.length).toBe(1)
      expect(entries[0].response.status).toBe(404)
      expect(entries[0].response.matchedStubId).toBeUndefined()
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("clears request log via DELETE and filters by query params", async () => {
    const imp = await createImposter(9513)
    await addStub(imp.id, {
      predicates: [],
      responses: [{ status: 200, body: { ok: true } }]
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      // Send mixed requests
      await fetch("http://localhost:9513/api/users")
      await fetch("http://localhost:9513/api/orders", { method: "POST" })
      await fetch("http://localhost:9513/api/users")
      await new Promise((r) => setTimeout(r, 100))

      // Filter by method
      const getOnly = await admin(`/imposters/${imp.id}/requests?method=GET`)
      const getEntries = await getOnly.json()
      expect(getEntries.length).toBe(2)

      // Filter by path
      const ordersOnly = await admin(`/imposters/${imp.id}/requests?path=/api/orders`)
      const orderEntries = await ordersOnly.json()
      expect(orderEntries.length).toBe(1)
      expect(orderEntries[0].request.method).toBe("POST")

      // Clear the log
      const clearRes = await admin(`/imposters/${imp.id}/requests`, { method: "DELETE" })
      expect(clearRes.status).toBe(200)

      // Verify cleared
      const afterClear = await admin(`/imposters/${imp.id}/requests`)
      const clearedEntries = await afterClear.json()
      expect(clearedEntries.length).toBe(0)
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)
})
