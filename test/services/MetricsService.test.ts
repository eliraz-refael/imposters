import { Effect, ManagedRuntime } from "effect"
import * as DateTime from "effect/DateTime"
import { NonEmptyString } from "imposters/schemas/common"
import type { RequestLogEntry } from "imposters/schemas/RequestLogSchema"
import { MetricsService, MetricsServiceLive } from "imposters/services/MetricsService"
import { afterAll, describe, expect, it } from "vitest"

const runtime = ManagedRuntime.make(MetricsServiceLive)
afterAll(async () => {
  await runtime.dispose()
})

const makeEntry = (overrides: {
  imposterId?: string
  method?: string
  status?: number
  duration?: number
} = {}): RequestLogEntry => ({
  id: NonEmptyString.make(crypto.randomUUID()),
  imposterId: NonEmptyString.make(overrides.imposterId ?? "imp-1"),
  timestamp: DateTime.unsafeNow(),
  request: {
    method: overrides.method ?? "GET",
    path: "/test",
    headers: {},
    query: {},
    body: undefined
  },
  response: {
    status: overrides.status ?? 200,
    headers: {},
    proxied: false
  },
  duration: overrides.duration ?? 10
})

describe("MetricsService", () => {
  it("returns zero stats for unknown imposter", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const metrics = yield* MetricsService
        const stats = yield* metrics.getStats("nonexistent")
        expect(stats.totalRequests).toBe(0)
        expect(stats.requestsPerMinute).toBe(0)
        expect(stats.averageResponseTime).toBe(0)
        expect(stats.errorRate).toBe(0)
        expect(stats.requestsByMethod).toEqual({})
        expect(stats.requestsByStatusCode).toEqual({})
      })
    )
  })

  it("records request and updates totalRequests", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const metrics = yield* MetricsService
        const impId = "imp-total"
        yield* metrics.recordRequest(makeEntry({ imposterId: impId }))
        yield* metrics.recordRequest(makeEntry({ imposterId: impId }))
        yield* metrics.recordRequest(makeEntry({ imposterId: impId }))
        const stats = yield* metrics.getStats(impId)
        expect(stats.totalRequests).toBe(3)
      })
    )
  })

  it("tracks requestsByMethod", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const metrics = yield* MetricsService
        const impId = "imp-method"
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, method: "GET" }))
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, method: "GET" }))
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, method: "POST" }))
        const stats = yield* metrics.getStats(impId)
        expect(stats.requestsByMethod!["GET"]).toBe(2)
        expect(stats.requestsByMethod!["POST"]).toBe(1)
      })
    )
  })

  it("tracks requestsByStatusCode", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const metrics = yield* MetricsService
        const impId = "imp-status"
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, status: 200 }))
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, status: 200 }))
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, status: 404 }))
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, status: 500 }))
        const stats = yield* metrics.getStats(impId)
        expect(stats.requestsByStatusCode!["200"]).toBe(2)
        expect(stats.requestsByStatusCode!["404"]).toBe(1)
        expect(stats.requestsByStatusCode!["500"]).toBe(1)
      })
    )
  })

  it("computes errorRate for 4xx and 5xx", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const metrics = yield* MetricsService
        const impId = "imp-error"
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, status: 200 }))
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, status: 200 }))
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, status: 404 }))
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, status: 500 }))
        const stats = yield* metrics.getStats(impId)
        expect(stats.errorRate).toBe(0.5)
      })
    )
  })

  it("computes averageResponseTime", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const metrics = yield* MetricsService
        const impId = "imp-avg"
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, duration: 10 }))
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, duration: 20 }))
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, duration: 30 }))
        const stats = yield* metrics.getStats(impId)
        expect(stats.averageResponseTime).toBe(20)
      })
    )
  })

  it("computes percentiles", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const metrics = yield* MetricsService
        const impId = "imp-pct"
        for (let i = 1; i <= 100; i++) {
          yield* metrics.recordRequest(makeEntry({ imposterId: impId, duration: i }))
        }
        const stats = yield* metrics.getStats(impId)
        expect(stats.p50ResponseTime).toBe(50)
        expect(stats.p95ResponseTime).toBe(95)
        expect(stats.p99ResponseTime).toBe(99)
      })
    )
  })

  it("resetStats clears metrics for imposter", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const metrics = yield* MetricsService
        const impId = "imp-reset"
        yield* metrics.recordRequest(makeEntry({ imposterId: impId }))
        yield* metrics.recordRequest(makeEntry({ imposterId: impId }))
        yield* metrics.resetStats(impId)
        const stats = yield* metrics.getStats(impId)
        expect(stats.totalRequests).toBe(0)
      })
    )
  })

  it("isolates metrics across imposters", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const metrics = yield* MetricsService
        yield* metrics.recordRequest(makeEntry({ imposterId: "imp-a" }))
        yield* metrics.recordRequest(makeEntry({ imposterId: "imp-a" }))
        yield* metrics.recordRequest(makeEntry({ imposterId: "imp-b" }))
        const statsA = yield* metrics.getStats("imp-a")
        const statsB = yield* metrics.getStats("imp-b")
        expect(statsA.totalRequests).toBe(2)
        expect(statsB.totalRequests).toBe(1)
      })
    )
  })

  it("sets lastRequestAt", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const metrics = yield* MetricsService
        const impId = "imp-last"
        yield* metrics.recordRequest(makeEntry({ imposterId: impId }))
        const stats = yield* metrics.getStats(impId)
        expect(stats.lastRequestAt).toBeDefined()
      })
    )
  })
})
