import { Effect, ManagedRuntime } from "effect"
import * as Layer from "effect/Layer"
import { HttpRouter } from "effect/unstable/http"
import { HandlerHttpClientLive } from "imposters/client/HandlerHttpClient"
import { type ImpostersClient, ImpostersClientLive } from "imposters/client/ImpostersClient"
import { withImposter } from "imposters/client/testing"
import { ApiLayer } from "imposters/layers/ApiLayer"
import { MainLayer } from "imposters/layers/MainLayer"
import { occupyPort, probeConnect } from "imposters/test/helpers/net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const FullLayer = ApiLayer.pipe(Layer.provide(MainLayer))

let adminHandler: (request: Request) => Promise<Response>
let dispose: () => void
let clientRuntime: ManagedRuntime.ManagedRuntime<ImpostersClient, never>

beforeAll(() => {
  const result = HttpRouter.toWebHandler(FullLayer)
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

    // Verify the imposter is reachable
    const resp = await fetch("http://localhost:9301/test")
    expect(resp.status).toBe(200)

    // Stop it: the PATCH resolves only once the port is released
    await stopImposter(imp.id)
    expect(await probeConnect(9301)).toBe("refused")

    // Verify status is stopped
    const info = await getImposter(imp.id)
    expect(info.status).toBe("stopped")
  }, 10000)

  it("reuse port after stop", async () => {
    const imp1 = await createImposter(9302)
    await addStub(imp1.id, { predicates: [], responses: [{ status: 200, body: { v: 1 } }] })
    await startImposter(imp1.id)
    await stopImposter(imp1.id)

    // Delete to release port
    await deleteImposter(imp1.id)

    // Create a new imposter on the same port
    const imp2 = await createImposter(9302)
    await addStub(imp2.id, { predicates: [], responses: [{ status: 200, body: { v: 2 } }] })
    await startImposter(imp2.id)

    try {
      const resp = await fetch("http://localhost:9302/test")
      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body).toEqual({ v: 2 })
    } finally {
      await stopImposter(imp2.id)
    }
  }, 15000)

  it("multiple imposters on different ports", async () => {
    const imp1 = await createImposter(9303)
    const imp2 = await createImposter(9304)
    await addStub(imp1.id, { predicates: [], responses: [{ status: 200, body: { port: 9303 } }] })
    await addStub(imp2.id, { predicates: [], responses: [{ status: 200, body: { port: 9304 } }] })

    await startImposter(imp1.id)
    await startImposter(imp2.id)

    try {
      const resp1 = await fetch("http://localhost:9303/test")
      expect(await resp1.json()).toEqual({ port: 9303 })

      const resp2 = await fetch("http://localhost:9304/test")
      expect(await resp2.json()).toEqual({ port: 9304 })
    } finally {
      await stopImposter(imp1.id)
      await stopImposter(imp2.id)
    }
  }, 10000)

  it("force delete running imposter", async () => {
    const imp = await createImposter(9305)
    await addStub(imp.id, { predicates: [], responses: [{ status: 200 }] })
    await startImposter(imp.id)

    // Force delete while running
    const deleteResp = await deleteImposter(imp.id, true)
    expect(deleteResp.status).toBe(200)

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

    try {
      const deleteResp = await deleteImposter(imp.id, false)
      expect(deleteResp.status).toBe(409)
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)

  it("starting on an occupied port returns a typed 409 and leaves the imposter stopped", async () => {
    const release = await occupyPort(9311)
    try {
      const imp = await createImposter(9311)
      const resp = await admin(`/imposters/${imp.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "running" })
      })
      expect(resp.status).toBe(409)
      const body = await resp.json()
      expect(body._tag).toBe("ApiConflictError")
      expect(body.message).toContain("Failed to bind port 9311")
      expect(body.message).toContain("EADDRINUSE")

      const info = await getImposter(imp.id)
      expect(info.status).toBe("stopped")
    } finally {
      await release()
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
