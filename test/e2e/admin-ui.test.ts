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
import { makeAdminUiRouter } from "imposters/ui/admin/AdminUiRouter.js"
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

let apiHandler: (request: Request) => Promise<Response>
let adminUiHandler: (request: Request) => Promise<Response | null>
let dispose: () => void

beforeAll(() => {
  const result = HttpApiBuilder.toWebHandler(FullLayer)
  apiHandler = result.handler
  dispose = result.dispose
  adminUiHandler = makeAdminUiRouter({ apiHandler, adminPort: 2525 })
})

afterAll(() => {
  dispose()
})

const adminApi = (path: string, init?: RequestInit) => apiHandler(new Request(`http://localhost:2525${path}`, init))

const adminUi = async (path: string, init?: RequestInit): Promise<Response> => {
  const resp = await adminUiHandler(new Request(`http://localhost:2525${path}`, init))
  return resp ?? new Response("Not found", { status: 404 })
}

describe("E2E: Admin UI", () => {
  it("GET /_ui returns HTML admin dashboard", async () => {
    const resp = await adminUi("/_ui")
    expect(resp.status).toBe(200)
    expect(resp.headers.get("content-type")).toContain("text/html")

    const html = await resp.text()
    expect(html).toContain("<!DOCTYPE html>")
    expect(html).toContain("Imposters")
    expect(html).toContain("Admin")
    expect(html).toContain("Create Imposter")
    expect(html).toContain("Total Imposters")
  })

  it("POST /_ui/imposters creates an imposter and returns updated list", async () => {
    const formData = new URLSearchParams()
    formData.set("name", "Test Service")
    formData.set("port", "")
    formData.set("autoStart", "")

    const resp = await adminUi("/_ui/imposters", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formData.toString()
    })
    expect(resp.status).toBe(200)
    const html = await resp.text()
    expect(html).toContain("Test Service")
  })

  it("shows imposters in the dashboard", async () => {
    // Create an imposter via API
    await adminApi("/imposters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 9901, name: "Dashboard Test" })
    })

    const resp = await adminUi("/_ui")
    const html = await resp.text()
    expect(html).toContain("Dashboard Test")
    expect(html).toContain("9901")
  })

  it("GET /_ui/imposters returns HTMX partial with imposter list", async () => {
    const resp = await adminUi("/_ui/imposters")
    expect(resp.status).toBe(200)
    const html = await resp.text()
    // Should be partial HTML (no DOCTYPE)
    expect(html).not.toContain("<!DOCTYPE")
  })

  it("DELETE /_ui/imposters/:id deletes imposter and returns updated list", async () => {
    // Create
    const createResp = await adminApi("/imposters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 9902, name: "To Delete" })
    })
    const imp = await createResp.json()

    // Delete via UI
    const resp = await adminUi(`/_ui/imposters/${imp.id}`, { method: "DELETE" })
    expect(resp.status).toBe(200)
    const html = await resp.text()
    expect(html).not.toContain("To Delete")
  })

  it("non-/_ui paths return null (pass through to API)", async () => {
    const resp = await adminUiHandler(new Request("http://localhost:2525/imposters"))
    expect(resp).toBeNull()
  })
})
