import { HttpApiBuilder } from "@effect/platform"
import * as Layer from "effect/Layer"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ApiLayer } from "imposters/layers/ApiLayer.js"
import { FiberManagerLive } from "imposters/server/FiberManager.js"
import { ImposterServerLive } from "imposters/server/ImposterServer.js"
import { ImposterRepositoryLive } from "imposters/repositories/ImposterRepository.js"
import { AppConfigLive } from "imposters/services/AppConfig.js"
import { PortAllocatorLive } from "imposters/services/PortAllocator.js"
import { RequestLoggerLive } from "imposters/services/RequestLogger.js"
import { UuidLive } from "imposters/services/UuidLive.js"
import { NodeServerFactoryLive } from "imposters/test/helpers/NodeServerFactory.js"

const PortAllocatorWithDeps = PortAllocatorLive.pipe(Layer.provide(AppConfigLive))
const ImposterServerWithDeps = ImposterServerLive.pipe(
  Layer.provide(Layer.mergeAll(FiberManagerLive, ImposterRepositoryLive, NodeServerFactoryLive, RequestLoggerLive))
)
const MainLayer = Layer.mergeAll(
  UuidLive,
  AppConfigLive,
  PortAllocatorWithDeps,
  ImposterRepositoryLive,
  FiberManagerLive,
  RequestLoggerLive,
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
    await new Promise((r) => setTimeout(r, 150))

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
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("GET /_admin/stubs returns HTML with stub list", async () => {
    const imp = await createImposter(9602)
    await addStub(imp.id, {
      predicates: [{ field: "path", operator: "equals", value: "/api" }],
      responses: [{ status: 200, body: { hello: "world" } }]
    })
    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

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
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("POST /_admin/stubs adds a stub via form data", async () => {
    const imp = await createImposter(9603)
    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      // Add a stub via the UI form
      const formData = new URLSearchParams()
      formData.set("predicates", "[]")
      formData.set("responses", '[{"status": 201, "body": {"added": true}}]')
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
      await new Promise((r) => setTimeout(r, 100))
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
    await new Promise((r) => setTimeout(r, 150))

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
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("non-/_admin requests still match stubs normally", async () => {
    const imp = await createImposter(9605)
    await addStub(imp.id, {
      predicates: [{ field: "path", operator: "equals", value: "/api/data" }],
      responses: [{ status: 200, body: { data: "normal" } }]
    })
    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

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
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)
})
