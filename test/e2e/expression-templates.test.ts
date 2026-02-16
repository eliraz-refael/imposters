import { HttpApiBuilder } from "@effect/platform"
import * as Layer from "effect/Layer"
import { ApiLayer } from "imposters/layers/ApiLayer.js"
import { ImposterRepositoryLive } from "imposters/repositories/ImposterRepository.js"
import { FiberManagerLive } from "imposters/server/FiberManager.js"
import { ImposterServerLive } from "imposters/server/ImposterServer.js"
import { AppConfigLive } from "imposters/services/AppConfig.js"
import { MetricsServiceLive } from "imposters/services/MetricsService.js"
import { PortAllocatorLive } from "imposters/services/PortAllocator.js"
import { ProxyServiceLive } from "imposters/services/ProxyService.js"
import { RequestLoggerLive } from "imposters/services/RequestLogger.js"
import { UuidLive } from "imposters/services/UuidLive.js"
import { NodeServerFactoryLive } from "imposters/test/helpers/NodeServerFactory.js"
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

describe("E2E: Expression Templates (JSONata)", () => {
  it("evaluates ${expr} in response body", async () => {
    const imp = await createImposter(9401)
    await addStub(imp.id, {
      predicates: [],
      responses: [{
        status: 200,
        body: {
          greeting: "${$uppercase(request.query.name)}",
          method: "${request.method}"
        }
      }]
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      const resp = await fetch("http://localhost:9401/hello?name=alice")
      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body.greeting).toBe("ALICE")
      expect(body.method).toBe("GET")
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("evaluates arithmetic in ${expr}", async () => {
    const imp = await createImposter(9402)
    await addStub(imp.id, {
      predicates: [{ field: "method", operator: "equals", value: "POST" }],
      responses: [{
        status: 200,
        body: {
          total: "${request.body.price * request.body.quantity}"
        }
      }]
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      const resp = await fetch("http://localhost:9402/calculate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ price: 25, quantity: 4 })
      })
      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body.total).toBe(100)
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("coexists with {{key}} templates", async () => {
    const imp = await createImposter(9403)
    await addStub(imp.id, {
      predicates: [],
      responses: [{
        status: 200,
        body: {
          template: "{{request.query.name}}",
          expression: "${$uppercase(request.query.name)}",
          path: "{{request.path}}"
        }
      }]
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      const resp = await fetch("http://localhost:9403/test?name=Alice")
      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body.template).toBe("Alice")
      expect(body.expression).toBe("ALICE")
      expect(body.path).toBe("/test")
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("preserves raw expression on evaluation failure", async () => {
    const imp = await createImposter(9404)
    await addStub(imp.id, {
      predicates: [],
      responses: [{
        status: 200,
        body: {
          bad: "${$$$invalid_expression}",
          good: "${request.method}"
        }
      }]
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      const resp = await fetch("http://localhost:9404/test")
      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body.bad).toBe("${$$$invalid_expression}")
      expect(body.good).toBe("GET")
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("evaluates $count function", async () => {
    const imp = await createImposter(9405)
    await addStub(imp.id, {
      predicates: [{ field: "method", operator: "equals", value: "POST" }],
      responses: [{
        status: 200,
        body: {
          itemCount: "${$count(request.body.items)}"
        }
      }]
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      const resp = await fetch("http://localhost:9405/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: ["a", "b", "c", "d"] })
      })
      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body.itemCount).toBe(4)
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)
})
