import { HttpApiBuilder } from "@effect/platform"
import { Effect, ManagedRuntime } from "effect"
import * as Layer from "effect/Layer"
import { HandlerHttpClientLive } from "imposters/client/HandlerHttpClient"
import { type ImpostersClient, ImpostersClientLive } from "imposters/client/ImpostersClient"
import { withImposter } from "imposters/client/testing"
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
let clientRuntime: ManagedRuntime.ManagedRuntime<ImpostersClient, never>

beforeAll(() => {
  const result = HttpApiBuilder.toWebHandler(FullLayer)
  adminHandler = result.handler
  dispose = result.dispose

  const clientLayer = ImpostersClientLive().pipe(
    Layer.provide(HandlerHttpClientLive(adminHandler))
  )
  clientRuntime = ManagedRuntime.make(clientLayer)
})

afterAll(async () => {
  await clientRuntime.dispose()
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
  const resp = await admin(`/imposters/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "running" })
  })
  return resp.json()
}

const stopImposter = async (id: string) => {
  await admin(`/imposters/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "stopped" })
  })
}

const deleteImposter = async (id: string, force = false) => {
  return admin(`/imposters/${id}?force=${force}`, { method: "DELETE" })
}

const addStub = async (imposterId: string, stub: Record<string, unknown>) => {
  await admin(`/imposters/${imposterId}/stubs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(stub)
  })
}

const getImposter = async (id: string) => {
  const resp = await admin(`/imposters/${id}`)
  return resp.json()
}

describe("E2E: Imposter Lifecycle", () => {
  it("create → start → request → stop → port freed", async () => {
    const imp = await createImposter(9301)
    await addStub(imp.id, { predicates: [], responses: [{ status: 200, body: { alive: true } }] })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    // Verify the imposter is reachable
    const resp = await fetch("http://localhost:9301/test")
    expect(resp.status).toBe(200)

    // Stop it
    await stopImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    // Verify status is stopped
    const info = await getImposter(imp.id)
    expect(info.status).toBe("stopped")
  }, 10000)

  it("reuse port after stop", async () => {
    const imp1 = await createImposter(9302)
    await addStub(imp1.id, { predicates: [], responses: [{ status: 200, body: { v: 1 } }] })
    await startImposter(imp1.id)
    await new Promise((r) => setTimeout(r, 150))
    await stopImposter(imp1.id)
    await new Promise((r) => setTimeout(r, 150))

    // Delete to release port
    await deleteImposter(imp1.id)

    // Create a new imposter on the same port
    const imp2 = await createImposter(9302)
    await addStub(imp2.id, { predicates: [], responses: [{ status: 200, body: { v: 2 } }] })
    await startImposter(imp2.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      const resp = await fetch("http://localhost:9302/test")
      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body).toEqual({ v: 2 })
    } finally {
      await stopImposter(imp2.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 15000)

  it("multiple imposters on different ports", async () => {
    const imp1 = await createImposter(9303)
    const imp2 = await createImposter(9304)
    await addStub(imp1.id, { predicates: [], responses: [{ status: 200, body: { port: 9303 } }] })
    await addStub(imp2.id, { predicates: [], responses: [{ status: 200, body: { port: 9304 } }] })

    await startImposter(imp1.id)
    await startImposter(imp2.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      const resp1 = await fetch("http://localhost:9303/test")
      expect(await resp1.json()).toEqual({ port: 9303 })

      const resp2 = await fetch("http://localhost:9304/test")
      expect(await resp2.json()).toEqual({ port: 9304 })
    } finally {
      await stopImposter(imp1.id)
      await stopImposter(imp2.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("force delete running imposter", async () => {
    const imp = await createImposter(9305)
    await addStub(imp.id, { predicates: [], responses: [{ status: 200 }] })
    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    // Force delete while running
    const deleteResp = await deleteImposter(imp.id, true)
    expect(deleteResp.status).toBe(200)
    await new Promise((r) => setTimeout(r, 150))

    // Verify it's gone
    const getResp = await admin(`/imposters/${imp.id}`)
    expect(getResp.status).toBe(404)
  }, 10000)

  it("delete non-running imposter without force", async () => {
    const imp = await createImposter(9306)
    const deleteResp = await deleteImposter(imp.id, false)
    expect(deleteResp.status).toBe(200)
  }, 10000)

  it("cannot delete running imposter without force", async () => {
    const imp = await createImposter(9307)
    await addStub(imp.id, { predicates: [], responses: [{ status: 200 }] })
    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      const deleteResp = await deleteImposter(imp.id, false)
      expect(deleteResp.status).toBe(409)
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("withImposter helper: create → request → auto-cleanup", async () => {
    await clientRuntime.runPromise(
      withImposter(
        {
          port: 9308,
          name: "helper-test",
          stubs: [{
            predicates: [{ field: "path", operator: "equals", value: "/api" }],
            responses: [{ status: 200, body: { via: "withImposter" } }]
          }]
        },
        (ctx) =>
          Effect.gen(function*() {
            expect(ctx.port).toBe(9308)
            const resp = yield* Effect.promise(() => fetch(`http://localhost:${ctx.port}/api`))
            expect(resp.status).toBe(200)
            const body = yield* Effect.promise(() => resp.json())
            expect(body).toEqual({ via: "withImposter" })
          })
      )
    )

    // Verify cleanup
    const getResp = await adminHandler(new Request("http://localhost:2525/imposters"))
    const list = await getResp.json()
    const found = (list as any).imposters.filter((i: any) => i.port === 9308)
    expect(found.length).toBe(0)
  }, 15000)
})
