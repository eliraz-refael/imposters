import { it as effectIt } from "@effect/vitest"
import { Effect, ManagedRuntime } from "effect"
import * as DateTime from "effect/DateTime"
import { TestClock } from "effect/testing"
import { NonEmptyString } from "imposters/schemas/common"
import type { RequestLogEntry, RequestOutcome } from "imposters/schemas/RequestLogSchema"
import { TIMELINE_BUCKET_MS, TIMELINE_BUCKETS } from "imposters/services/MetricsAggregates"
import { MetricsService, MetricsServiceLive } from "imposters/services/MetricsService"
import { afterAll, describe, expect, it } from "vitest"

const runtime = ManagedRuntime.make(MetricsServiceLive)
afterAll(async () => {
  await runtime.dispose()
})

const makeEntry = (overrides: {
  imposterId?: string
  method?: string
  path?: string
  status?: number
  duration?: number
  outcome?: RequestOutcome
  matchedStubId?: string
  responseIndex?: number
  atMs?: number
} = {}): RequestLogEntry => ({
  id: NonEmptyString.make(crypto.randomUUID()),
  imposterId: NonEmptyString.make(overrides.imposterId ?? "imp-1"),
  timestamp: overrides.atMs !== undefined ? DateTime.makeUnsafe(overrides.atMs) : DateTime.nowUnsafe(),
  request: {
    method: overrides.method ?? "GET",
    path: overrides.path ?? "/test",
    headers: {},
    query: {},
    body: undefined
  },
  response: {
    status: overrides.status ?? 200,
    headers: {},
    proxied: overrides.outcome === "proxy",
    outcome: overrides.outcome ?? (overrides.matchedStubId !== undefined ? "stub" : "unmatched"),
    ...(overrides.matchedStubId !== undefined ? { matchedStubId: NonEmptyString.make(overrides.matchedStubId) } : {}),
    ...(overrides.responseIndex !== undefined ? { responseIndex: overrides.responseIndex } : {})
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

describe("MetricsService: requests recorded out of order", () => {
  // Requests are recorded when they finish, so a slow one can be recorded after a later one
  it("keeps lastRequestAt the latest and firstRequestAt the earliest", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const metrics = yield* MetricsService
        const impId = "imp-out-of-order"
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, atMs: 120_000 }))
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, atMs: 60_000 }))
        const stats = yield* metrics.getStats(impId)
        expect(stats.lastRequestAt).toEqual(DateTime.makeUnsafe(120_000))
        // Two requests over the minute between them
        expect(stats.requestsPerMinute).toBe(2)
      })
    )
  })
})

describe("MetricsService: per-stub, unmatched and timeline", () => {
  it("computes serverErrorRate from 5xx only, beside errorRate", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const metrics = yield* MetricsService
        const impId = "imp-5xx"
        for (const status of [200, 404, 500, 503]) {
          yield* metrics.recordRequest(makeEntry({ imposterId: impId, status }))
        }
        const stats = yield* metrics.getStats(impId)
        expect(stats.errorRate).toBe(0.75)
        expect(stats.serverErrorRate).toBe(0.5)
      })
    )
  })

  it("counts stub hits per response, with the latest hit time", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const metrics = yield* MetricsService
        const impId = "imp-stub-hits"
        const hit = (stubId: string, responseIndex: number, atMs: number) =>
          metrics.recordRequest(makeEntry({ imposterId: impId, matchedStubId: stubId, responseIndex, atMs }))
        yield* hit("s1", 0, 1_000)
        yield* hit("s1", 1, 2_000)
        yield* hit("s1", 0, 3_000)
        yield* hit("s2", 0, 1_500)
        const stats = yield* metrics.getStats(impId)
        expect(stats.stubs.get("s1")).toEqual({ hits: 3, byResponse: [2, 1], lastHitAt: 3_000 })
        expect(stats.stubs.get("s2")).toEqual({ hits: 1, byResponse: [1], lastHitAt: 1_500 })
      })
    )
  })

  it("groups unmatched requests only, not extension or proxy answers", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const metrics = yield* MetricsService
        const impId = "imp-unmatched"
        const send = (method: string, path: string, outcome: RequestOutcome, atMs: number) =>
          metrics.recordRequest(makeEntry({ imposterId: impId, method, path, outcome, atMs, status: 404 }))
        yield* send("GET", "/missing", "unmatched", 1_000)
        yield* send("GET", "/missing", "unmatched", 3_000)
        yield* send("POST", "/missing", "unmatched", 2_000)
        yield* send("GET", "/ext", "extension", 4_000)
        yield* send("GET", "/proxied", "proxy", 5_000)
        const stats = yield* metrics.getStats(impId)
        expect(stats.unmatched).toEqual([
          { method: "GET", path: "/missing", count: 2, lastSeenAt: 3_000 },
          { method: "POST", path: "/missing", count: 1, lastSeenAt: 2_000 }
        ])

        // The internal view keeps the latest request of each group
        const groups = yield* metrics.getUnmatched(impId)
        expect(groups[0]?.sample.timestamp).toEqual(DateTime.makeUnsafe(3_000))
      })
    )
  })

  it("resetStub forgets one stub's counters and keeps the rest", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const metrics = yield* MetricsService
        const impId = "imp-reset-stub"
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, matchedStubId: "keep", responseIndex: 0 }))
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, matchedStubId: "drop", responseIndex: 0 }))
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, path: "/nope" }))
        yield* metrics.resetStub(impId, "drop")
        const stats = yield* metrics.getStats(impId)
        expect(stats.stubs.has("drop")).toBe(false)
        expect(stats.stubs.get("keep")?.hits).toBe(1)
        expect(stats.totalRequests).toBe(3)
        expect(stats.unmatched).toHaveLength(1)
      })
    )
  })

  it("resetStats forgets stub counters, unmatched groups and the timeline too", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const metrics = yield* MetricsService
        const impId = "imp-reset-all"
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, matchedStubId: "s", responseIndex: 0 }))
        yield* metrics.recordRequest(makeEntry({ imposterId: impId, path: "/nope" }))
        yield* metrics.resetStats(impId)
        const stats = yield* metrics.getStats(impId)
        expect(stats.stubs.size).toBe(0)
        expect(stats.unmatched).toEqual([])
        expect(stats.last15Minutes).toEqual({ requests: 0, serverErrors: 0, unmatched: 0 })
      })
    )
  })

  effectIt.effect("buckets traffic into a 15-minute timeline that slides with the Clock", () =>
    Effect.gen(function*() {
      const metrics = yield* MetricsService
      const impId = "imp-timeline"
      const S = TIMELINE_BUCKET_MS
      yield* TestClock.setTime(100 * S)
      const at = (offsetMs: number, status: number, outcome: RequestOutcome) =>
        metrics.recordRequest(
          makeEntry({ imposterId: impId, atMs: 100 * S + offsetMs, status, outcome, matchedStubId: "s" })
        )
      yield* at(0, 200, "stub")
      yield* at(10, 503, "stub")
      yield* at(S + 5, 404, "unmatched")

      // One bucket later the first two requests sit in the second-to-last point
      yield* TestClock.adjust(S)
      let stats = yield* metrics.getStats(impId)
      expect(stats.timeline).toHaveLength(TIMELINE_BUCKETS)
      expect(stats.timeline[TIMELINE_BUCKETS - 2]).toEqual({
        start: 100 * S,
        requests: 2,
        serverErrors: 1,
        unmatched: 0
      })
      expect(stats.timeline[TIMELINE_BUCKETS - 1]).toEqual({
        start: 101 * S,
        requests: 1,
        serverErrors: 0,
        unmatched: 1
      })
      expect(stats.last15Minutes).toEqual({ requests: 3, serverErrors: 1, unmatched: 1 })

      // 15 minutes on, the first bucket has slid out of the window
      yield* TestClock.adjust((TIMELINE_BUCKETS - 1) * S)
      stats = yield* metrics.getStats(impId)
      expect(stats.timeline[0]?.start).toBe(101 * S)
      expect(stats.last15Minutes).toEqual({ requests: 1, serverErrors: 0, unmatched: 1 })
      // Totals since start are not windowed
      expect(stats.totalRequests).toBe(3)
    }).pipe(Effect.provide(MetricsServiceLive)))
})
