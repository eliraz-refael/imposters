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
import * as http from "node:http"
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

// Upstream server that the proxy forwards to
let upstreamServer: http.Server
let upstreamPort: number

let adminHandler: (request: Request) => Promise<Response>
let dispose: () => void

beforeAll(async () => {
  // Start upstream server
  upstreamServer = http.createServer((req, res) => {
    const url = new URL(req.url!, `http://localhost`)

    let _body = ""
    req.on("data", (chunk: Buffer) => {
      _body += chunk.toString()
    })
    req.on("end", () => {
      if (url.pathname === "/error") {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "upstream error" }))
        return
      }

      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        upstream: true,
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams)
      }))
    })
  })

  await new Promise<void>((resolve) => {
    upstreamServer.listen(0, () => {
      upstreamPort = (upstreamServer.address() as { port: number }).port
      resolve()
    })
  })

  const result = HttpApiBuilder.toWebHandler(FullLayer)
  adminHandler = result.handler
  dispose = result.dispose
})

afterAll(() => {
  dispose()
  upstreamServer.close()
})

const admin = (path: string, init?: RequestInit) => adminHandler(new Request(`http://localhost:2525${path}`, init))

const createImposterWithProxy = async (port: number, proxyConfig: Record<string, unknown>) => {
  const resp = await admin("/imposters", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port, proxy: proxyConfig })
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

describe("E2E: Proxy Mode", () => {
  it("passthrough mode forwards requests to upstream", async () => {
    const imp = await createImposterWithProxy(9501, {
      targetUrl: `http://localhost:${upstreamPort}`,
      mode: "passthrough"
    })
    expect(imp.proxy).toBeDefined()
    expect(imp.proxy.targetUrl).toBe(`http://localhost:${upstreamPort}`)

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      const resp = await fetch("http://localhost:9501/api/data?key=value")
      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body.upstream).toBe(true)
      expect(body.method).toBe("GET")
      expect(body.path).toBe("/api/data")
      expect(body.query).toEqual({ key: "value" })
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("stubs take precedence over proxy", async () => {
    const imp = await createImposterWithProxy(9502, {
      targetUrl: `http://localhost:${upstreamPort}`,
      mode: "passthrough"
    })

    // Add a stub that matches /stubbed
    await admin(`/imposters/${imp.id}/stubs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        predicates: [{ field: "path", operator: "equals", value: "/stubbed" }],
        responses: [{ status: 200, body: { source: "stub" } }]
      })
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      // /stubbed should be served by stub, not proxy
      const stubbedResp = await fetch("http://localhost:9502/stubbed")
      expect(stubbedResp.status).toBe(200)
      const stubbedBody = await stubbedResp.json()
      expect(stubbedBody.source).toBe("stub")

      // /other should be proxied
      const proxiedResp = await fetch("http://localhost:9502/other")
      expect(proxiedResp.status).toBe(200)
      const proxiedBody = await proxiedResp.json()
      expect(proxiedBody.upstream).toBe(true)
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("record mode saves proxied responses as stubs", async () => {
    const imp = await createImposterWithProxy(9503, {
      targetUrl: `http://localhost:${upstreamPort}`,
      mode: "record"
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      // First request: proxied and recorded
      const firstResp = await fetch("http://localhost:9503/api/recorded")
      expect(firstResp.status).toBe(200)
      const firstBody = await firstResp.json()
      expect(firstBody.upstream).toBe(true)

      // Give time for stub recording
      await new Promise((r) => setTimeout(r, 200))

      // Check that a stub was created
      const stubsResp = await admin(`/imposters/${imp.id}/stubs`)
      const stubs = await stubsResp.json()
      expect(stubs.length).toBeGreaterThanOrEqual(1)
      const recordedStub = stubs.find((s: any) =>
        s.predicates.some((p: any) => p.field === "path" && p.value === "/api/recorded")
      )
      expect(recordedStub).toBeDefined()
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("returns 502 when upstream is unreachable", async () => {
    const imp = await createImposterWithProxy(9504, {
      targetUrl: "http://localhost:1",
      mode: "passthrough"
    })

    await startImposter(imp.id)
    await new Promise((r) => setTimeout(r, 150))

    try {
      const resp = await fetch("http://localhost:9504/any")
      expect(resp.status).toBe(502)
      const body = await resp.json()
      expect(body.error).toBe("Proxy failed")
    } finally {
      await stopImposter(imp.id)
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10000)

  it("proxy config shows in imposter response", async () => {
    const imp = await createImposterWithProxy(9505, {
      targetUrl: `http://localhost:${upstreamPort}`,
      mode: "record",
      addHeaders: { "x-forwarded-by": "imposters" }
    })

    expect(imp.proxy.targetUrl).toBe(`http://localhost:${upstreamPort}`)
    expect(imp.proxy.mode).toBe("record")
    expect(imp.proxy.addHeaders["x-forwarded-by"]).toBe("imposters")
  }, 10000)

  it("proxy config can be removed via update with null", async () => {
    const imp = await createImposterWithProxy(9506, {
      targetUrl: `http://localhost:${upstreamPort}`,
      mode: "passthrough"
    })

    // Remove proxy
    const updateResp = await admin(`/imposters/${imp.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proxy: null })
    })
    const updated = await updateResp.json()
    expect(updated.proxy).toBeUndefined()
  }, 10000)
})
