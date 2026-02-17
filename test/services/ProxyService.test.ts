import { Effect, Layer, ManagedRuntime } from "effect"
import type { ProxyConfigDomain } from "imposters/domain/imposter"
import type { RequestContext } from "imposters/matching/RequestMatcher"
import { ProxyService, ProxyServiceLive } from "imposters/services/ProxyService"
import { UuidLive } from "imposters/services/UuidLive"
import * as http from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// Test HTTP server
let testServer: http.Server
let testPort: number

beforeAll(async () => {
  testServer = http.createServer((req, res) => {
    const url = new URL(req.url!, `http://localhost`)

    // Collect request body
    let body = ""
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on("end", () => {
      const response: Record<string, unknown> = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        receivedHeaders: req.headers,
        receivedBody: body || undefined
      }

      if (url.pathname === "/slow") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify(response))
        }, 500)
        return
      }

      if (url.pathname === "/error") {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "Internal Server Error" }))
        return
      }

      res.writeHead(200, { "content-type": "application/json", "x-custom": "test-value" })
      res.end(JSON.stringify(response))
    })
  })

  await new Promise<void>((resolve) => {
    testServer.listen(0, () => {
      testPort = (testServer.address() as { port: number }).port
      resolve()
    })
  })
})

afterAll(() => {
  testServer.close()
})

const TestLayer = ProxyServiceLive.pipe(Layer.provide(UuidLive))
const runtime = ManagedRuntime.make(TestLayer)
afterAll(async () => {
  await runtime.dispose()
})

const makeCtx = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  method: "GET",
  path: "/api/test",
  headers: { "content-type": "application/json", host: "localhost:3000" },
  query: { key: "value" },
  body: undefined,
  ...overrides
})

const makeConfig = (overrides: Partial<ProxyConfigDomain> = {}): ProxyConfigDomain => ({
  targetUrl: `http://localhost:${testPort}`,
  mode: "passthrough",
  removeHeaders: [],
  followRedirects: true,
  timeout: 10000,
  ...overrides
})

describe("ProxyService", () => {
  describe("forward", () => {
    it("forwards GET request to target", async () => {
      await runtime.runPromise(
        Effect.gen(function*() {
          const proxy = yield* ProxyService
          const ctx = makeCtx()
          const config = makeConfig()
          const url = new URL("http://localhost:3000/api/test?key=value")
          const response = yield* proxy.forward(ctx, config, url)
          expect(response.status).toBe(200)
          const body = yield* Effect.promise(() => response.json())
          expect(body.method).toBe("GET")
          expect(body.path).toBe("/api/test")
          expect(body.query).toEqual({ key: "value" })
        })
      )
    })

    it("forwards POST request with body", async () => {
      await runtime.runPromise(
        Effect.gen(function*() {
          const proxy = yield* ProxyService
          const ctx = makeCtx({ method: "POST", body: { name: "test" } })
          const config = makeConfig()
          const url = new URL("http://localhost:3000/api/create")
          const response = yield* proxy.forward(ctx, config, url)
          expect(response.status).toBe(200)
          const body = yield* Effect.promise(() => response.json())
          expect(body.method).toBe("POST")
          expect(body.receivedBody).toBe("{\"name\":\"test\"}")
        })
      )
    })

    it("strips hop-by-hop headers", async () => {
      await runtime.runPromise(
        Effect.gen(function*() {
          const proxy = yield* ProxyService
          const ctx = makeCtx({
            headers: {
              "content-type": "application/json",
              host: "original-host",
              connection: "keep-alive",
              "transfer-encoding": "chunked"
            }
          })
          const config = makeConfig()
          const url = new URL("http://localhost:3000/api/test")
          const response = yield* proxy.forward(ctx, config, url)
          const body = yield* Effect.promise(() => response.json())
          // host should be stripped (replaced by fetch with target host)
          expect(body.receivedHeaders.host).not.toBe("original-host")
          // transfer-encoding should be stripped
          expect(body.receivedHeaders["transfer-encoding"]).toBeUndefined()
        })
      )
    })

    it("applies addHeaders", async () => {
      await runtime.runPromise(
        Effect.gen(function*() {
          const proxy = yield* ProxyService
          const ctx = makeCtx()
          const config = makeConfig({ addHeaders: { "x-api-key": "secret123" } })
          const url = new URL("http://localhost:3000/api/test")
          const response = yield* proxy.forward(ctx, config, url)
          const body = yield* Effect.promise(() => response.json())
          expect(body.receivedHeaders["x-api-key"]).toBe("secret123")
        })
      )
    })

    it("applies removeHeaders", async () => {
      await runtime.runPromise(
        Effect.gen(function*() {
          const proxy = yield* ProxyService
          const ctx = makeCtx({
            headers: { "content-type": "application/json", authorization: "Bearer token" }
          })
          const config = makeConfig({ removeHeaders: ["authorization"] })
          const url = new URL("http://localhost:3000/api/test")
          const response = yield* proxy.forward(ctx, config, url)
          const body = yield* Effect.promise(() => response.json())
          expect(body.receivedHeaders.authorization).toBeUndefined()
        })
      )
    })

    it("returns ProxyError on unreachable target", async () => {
      await runtime.runPromise(
        Effect.gen(function*() {
          const proxy = yield* ProxyService
          const ctx = makeCtx()
          const config = makeConfig({ targetUrl: "http://localhost:1" })
          const url = new URL("http://localhost:3000/api/test")
          const result = yield* proxy.forward(ctx, config, url).pipe(
            Effect.map(() => "success" as const),
            Effect.catchTag("ProxyError", (err) => Effect.succeed(err))
          )
          expect(result).not.toBe("success")
          expect((result as { targetUrl: string }).targetUrl).toContain("localhost:1")
        })
      )
    })

    it("times out on slow response", async () => {
      await runtime.runPromise(
        Effect.gen(function*() {
          const proxy = yield* ProxyService
          const ctx = makeCtx({ path: "/slow" })
          const config = makeConfig({ timeout: 100 })
          const url = new URL("http://localhost:3000/slow")
          const result = yield* proxy.forward(ctx, config, url).pipe(
            Effect.map(() => "success" as const),
            Effect.catchTag("ProxyError", (err) => Effect.succeed(err))
          )
          expect(result).not.toBe("success")
          expect((result as { reason: string }).reason).toContain("timed out")
        })
      )
    })
  })

  describe("recordAsStub", () => {
    it("creates a stub from request and response", async () => {
      await runtime.runPromise(
        Effect.gen(function*() {
          const proxy = yield* ProxyService
          const ctx = makeCtx({ method: "GET", path: "/api/users" })
          const response = new Response(
            JSON.stringify({ users: [] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
          const stub = yield* proxy.recordAsStub(ctx, response)
          expect(stub.id).toBeDefined()
          expect(stub.predicates).toHaveLength(2)
          expect(stub.predicates[0]).toEqual({
            field: "method",
            operator: "equals",
            value: "GET",
            caseSensitive: true
          })
          expect(stub.predicates[1]).toEqual({
            field: "path",
            operator: "equals",
            value: "/api/users",
            caseSensitive: true
          })
          expect(stub.responses).toHaveLength(1)
          expect(stub.responses[0]!.status).toBe(200)
          expect(stub.responses[0]!.body).toEqual({ users: [] })
        })
      )
    })
  })
})
