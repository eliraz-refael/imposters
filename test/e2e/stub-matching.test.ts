import { HttpApiBuilder } from "@effect/platform"
import * as Layer from "effect/Layer"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ApiLayer } from "imposters/layers/ApiLayer.js"
import { FiberManagerLive } from "imposters/server/FiberManager.js"
import { ImposterServerLive } from "imposters/server/ImposterServer.js"
import { ImposterRepositoryLive } from "imposters/repositories/ImposterRepository.js"
import { AppConfigLive } from "imposters/services/AppConfig.js"
import { PortAllocatorLive } from "imposters/services/PortAllocator.js"
import { UuidLive } from "imposters/services/UuidLive.js"
import { NodeServerFactoryLive } from "imposters/test/helpers/NodeServerFactory.js"

const PortAllocatorWithDeps = PortAllocatorLive.pipe(Layer.provide(AppConfigLive))
const ImposterServerWithDeps = ImposterServerLive.pipe(
  Layer.provide(Layer.mergeAll(FiberManagerLive, ImposterRepositoryLive, NodeServerFactoryLive))
)
const MainLayer = Layer.mergeAll(
  UuidLive,
  AppConfigLive,
  PortAllocatorWithDeps,
  ImposterRepositoryLive,
  FiberManagerLive,
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

const admin = (path: string, init?: RequestInit) =>
  adminHandler(new Request(`http://localhost:2525${path}`, init))

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
  const resp = await admin(`/imposters/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "stopped" })
  })
  return resp.json()
}

const addStub = async (imposterId: string, stub: Record<string, unknown>) => {
  const resp = await admin(`/imposters/${imposterId}/stubs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(stub)
  })
  return resp.json()
}

describe("E2E: Stub Matching", () => {
  it("creates imposter, adds stub, starts, and serves response", async () => {
    const imp = await createImposter(9201)
    await addStub(imp.id, {
      predicates: [
        { field: "method", operator: "equals", value: "GET" },
        { field: "path", operator: "equals", value: "/hello" }
      ],
      responses: [{ status: 200, body: { message: "Hello from imposter!" } }]
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      const resp = await fetch("http://localhost:9201/hello")
      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body.message).toBe("Hello from imposter!")
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("matches correct stub among multiple", async () => {
    const imp = await createImposter(9202)
    await addStub(imp.id, {
      predicates: [{ field: "method", operator: "equals", value: "GET" }],
      responses: [{ status: 200, body: { action: "get" } }]
    })
    await addStub(imp.id, {
      predicates: [{ field: "method", operator: "equals", value: "POST" }],
      responses: [{ status: 201, body: { action: "post" } }]
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      const getResp = await fetch("http://localhost:9202/any")
      expect(getResp.status).toBe(200)
      expect(await getResp.json()).toEqual({ action: "get" })

      const postResp = await fetch("http://localhost:9202/any", { method: "POST" })
      expect(postResp.status).toBe(201)
      expect(await postResp.json()).toEqual({ action: "post" })
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("returns 404 when no stub matches", async () => {
    const imp = await createImposter(9203)
    await addStub(imp.id, {
      predicates: [{ field: "path", operator: "equals", value: "/specific" }],
      responses: [{ status: 200 }]
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      const resp = await fetch("http://localhost:9203/other")
      expect(resp.status).toBe(404)
      const body = await resp.json()
      expect(body.error).toBe("No matching stub found")
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("catch-all stub matches everything", async () => {
    const imp = await createImposter(9204)
    await addStub(imp.id, {
      predicates: [],
      responses: [{ status: 200, body: { catch: "all" } }]
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      const resp = await fetch("http://localhost:9204/anything/at/all", { method: "DELETE" })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ catch: "all" })
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("template substitution in response body", async () => {
    const imp = await createImposter(9205)
    await addStub(imp.id, {
      predicates: [],
      responses: [{
        status: 200,
        body: { greeting: "Hello {{request.query.name}}", path: "{{request.path}}" }
      }]
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      const resp = await fetch("http://localhost:9205/api/test?name=World")
      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body.greeting).toBe("Hello World")
      expect(body.path).toBe("/api/test")
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("header predicate matching", async () => {
    const imp = await createImposter(9206)
    await addStub(imp.id, {
      predicates: [{ field: "headers", operator: "contains", value: { authorization: "Bearer" } }],
      responses: [{ status: 200, body: { authenticated: true } }]
    })
    await addStub(imp.id, {
      predicates: [],
      responses: [{ status: 401, body: { authenticated: false } }]
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      const authResp = await fetch("http://localhost:9206/api", {
        headers: { Authorization: "Bearer token123" }
      })
      expect(authResp.status).toBe(200)
      expect(await authResp.json()).toEqual({ authenticated: true })

      const noAuthResp = await fetch("http://localhost:9206/api")
      expect(noAuthResp.status).toBe(401)
      expect(await noAuthResp.json()).toEqual({ authenticated: false })
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("query parameter predicate matching", async () => {
    const imp = await createImposter(9207)
    await addStub(imp.id, {
      predicates: [{ field: "query", operator: "equals", value: { format: "json" } }],
      responses: [{ status: 200, body: { format: "json" } }]
    })
    await addStub(imp.id, {
      predicates: [],
      responses: [{ status: 200, body: { format: "default" } }]
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      const jsonResp = await fetch("http://localhost:9207/data?format=json")
      expect(await jsonResp.json()).toEqual({ format: "json" })

      const defaultResp = await fetch("http://localhost:9207/data")
      expect(await defaultResp.json()).toEqual({ format: "default" })
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)
})
