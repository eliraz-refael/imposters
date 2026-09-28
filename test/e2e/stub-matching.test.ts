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

    try {
      const resp = await fetch("http://localhost:9201/hello")
      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body.message).toBe("Hello from imposter!")
    } finally {
      await stopImposter(imp.id)
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

    try {
      const getResp = await fetch("http://localhost:9202/any")
      expect(getResp.status).toBe(200)
      expect(await getResp.json()).toEqual({ action: "get" })

      const postResp = await fetch("http://localhost:9202/any", { method: "POST" })
      expect(postResp.status).toBe(201)
      expect(await postResp.json()).toEqual({ action: "post" })
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)

  it("returns 404 when no stub matches", async () => {
    const imp = await createImposter(9203)
    await addStub(imp.id, {
      predicates: [{ field: "path", operator: "equals", value: "/specific" }],
      responses: [{ status: 200 }]
    })

    await startImposter(imp.id)

    try {
      const resp = await fetch("http://localhost:9203/other")
      expect(resp.status).toBe(404)
      const body = await resp.json()
      expect(body.error).toBe("No matching stub found")
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)

  it("catch-all stub matches everything", async () => {
    const imp = await createImposter(9204)
    await addStub(imp.id, {
      predicates: [],
      responses: [{ status: 200, body: { catch: "all" } }]
    })

    await startImposter(imp.id)

    try {
      const resp = await fetch("http://localhost:9204/anything/at/all", { method: "DELETE" })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ catch: "all" })
    } finally {
      await stopImposter(imp.id)
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

    try {
      const resp = await fetch("http://localhost:9205/api/test?name=World")
      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body.greeting).toBe("Hello World")
      expect(body.path).toBe("/api/test")
    } finally {
      await stopImposter(imp.id)
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

    try {
      const jsonResp = await fetch("http://localhost:9207/data?format=json")
      expect(await jsonResp.json()).toEqual({ format: "json" })

      const defaultResp = await fetch("http://localhost:9207/data")
      expect(await defaultResp.json()).toEqual({ format: "default" })
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)

  // Regression: the request-log capture used to rebuild every response as `new Response("", ...)`,
  // which throws for null-body statuses and turned them into 500s
  it("serves null-body statuses (204, 304) instead of a 500", async () => {
    const imp = await createImposter(9208)
    await addStub(imp.id, {
      predicates: [{ field: "path", operator: "equals", value: "/no-content" }],
      responses: [{ status: 204 }]
    })
    await addStub(imp.id, {
      predicates: [{ field: "path", operator: "equals", value: "/not-modified" }],
      responses: [{ status: 304, headers: { etag: "\"v1\"" } }]
    })

    await startImposter(imp.id)

    try {
      const noContent = await fetch("http://localhost:9208/no-content", { method: "DELETE" })
      expect(noContent.status).toBe(204)
      expect(await noContent.text()).toBe("")

      const notModified = await fetch("http://localhost:9208/not-modified")
      expect(notModified.status).toBe(304)
      expect(notModified.headers.get("etag")).toBe("\"v1\"")
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)
})
