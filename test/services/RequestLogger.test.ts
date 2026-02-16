import { Effect, ManagedRuntime, Queue } from "effect"
import * as DateTime from "effect/DateTime"
import { NonEmptyString } from "imposters/schemas/common.js"
import type { RequestLogEntry } from "imposters/schemas/RequestLogSchema.js"
import { RequestLogger, RequestLoggerLive } from "imposters/services/RequestLogger.js"
import { afterAll, describe, expect, it } from "vitest"

const runtime = ManagedRuntime.make(RequestLoggerLive)
afterAll(async () => {
  await runtime.dispose()
})

const makeEntry = (overrides: {
  id?: string
  imposterId?: string
  method?: string
  path?: string
  status?: number
  matchedStubId?: string
  duration?: number
} = {}): RequestLogEntry => ({
  id: NonEmptyString.make(overrides.id ?? "req-1"),
  imposterId: NonEmptyString.make(overrides.imposterId ?? "imp-1"),
  timestamp: DateTime.unsafeNow(),
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
    proxied: false,
    ...(overrides.matchedStubId !== undefined
      ? { matchedStubId: NonEmptyString.make(overrides.matchedStubId) }
      : {})
  },
  duration: overrides.duration ?? 5
})

describe("RequestLogger", () => {
  it("log + getEntries returns logged entry", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const logger = yield* RequestLogger
        const entry = makeEntry({ id: "r1", imposterId: "i-get" })
        yield* logger.log(entry)
        const entries = yield* logger.getEntries("i-get")
        expect(entries.length).toBeGreaterThanOrEqual(1)
        const found = entries.find((e) => e.id === "r1")
        expect(found).toBeDefined()
        expect(found!.request.method).toBe("GET")
        expect(found!.request.path).toBe("/test")
      })
    )
  })

  it("bounded buffer: log 101 entries returns 100 (oldest dropped)", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const logger = yield* RequestLogger
        const impId = "i-bounded"
        for (let i = 0; i < 101; i++) {
          yield* logger.log(makeEntry({ id: `b-${i}`, imposterId: impId }))
        }
        const entries = yield* logger.getEntries(impId, { limit: 200 })
        expect(entries.length).toBe(100)
        // Oldest (b-0) should be dropped
        expect(entries.find((e) => e.id === "b-0")).toBeUndefined()
        expect(entries.find((e) => e.id === "b-1")).toBeDefined()
      })
    )
  })

  it("getEntries filters by method", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const logger = yield* RequestLogger
        const impId = "i-method"
        yield* logger.log(makeEntry({ id: "m1", imposterId: impId, method: "GET" }))
        yield* logger.log(makeEntry({ id: "m2", imposterId: impId, method: "POST" }))
        yield* logger.log(makeEntry({ id: "m3", imposterId: impId, method: "GET" }))
        const entries = yield* logger.getEntries(impId, { method: "POST" })
        expect(entries.length).toBe(1)
        expect(entries[0]!.id).toBe("m2")
      })
    )
  })

  it("getEntries filters by path", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const logger = yield* RequestLogger
        const impId = "i-path"
        yield* logger.log(makeEntry({ id: "p1", imposterId: impId, path: "/api/users" }))
        yield* logger.log(makeEntry({ id: "p2", imposterId: impId, path: "/api/orders" }))
        const entries = yield* logger.getEntries(impId, { path: "/api/users" })
        expect(entries.length).toBe(1)
        expect(entries[0]!.id).toBe("p1")
      })
    )
  })

  it("getEntries filters by status", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const logger = yield* RequestLogger
        const impId = "i-status"
        yield* logger.log(makeEntry({ id: "s1", imposterId: impId, status: 200 }))
        yield* logger.log(makeEntry({ id: "s2", imposterId: impId, status: 404 }))
        yield* logger.log(makeEntry({ id: "s3", imposterId: impId, status: 200 }))
        const entries = yield* logger.getEntries(impId, { status: 404 })
        expect(entries.length).toBe(1)
        expect(entries[0]!.id).toBe("s2")
      })
    )
  })

  it("getCount returns correct number", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const logger = yield* RequestLogger
        const impId = "i-count"
        yield* logger.log(makeEntry({ id: "c1", imposterId: impId }))
        yield* logger.log(makeEntry({ id: "c2", imposterId: impId }))
        yield* logger.log(makeEntry({ id: "c3", imposterId: impId }))
        const count = yield* logger.getCount(impId)
        expect(count).toBe(3)
      })
    )
  })

  it("clear removes all entries for imposter", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const logger = yield* RequestLogger
        const impId = "i-clear"
        yield* logger.log(makeEntry({ id: "cl1", imposterId: impId }))
        yield* logger.log(makeEntry({ id: "cl2", imposterId: impId }))
        yield* logger.clear(impId)
        const entries = yield* logger.getEntries(impId)
        expect(entries.length).toBe(0)
        const count = yield* logger.getCount(impId)
        expect(count).toBe(0)
      })
    )
  })

  it("PubSub: subscribe then log receives entry", async () => {
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const logger = yield* RequestLogger
          const dequeue = yield* logger.subscribe
          const entry = makeEntry({ id: "ps1", imposterId: "i-pubsub" })
          yield* logger.log(entry)
          const received = yield* Queue.take(dequeue)
          expect(received.id).toBe("ps1")
        })
      )
    )
  })

  it("removeImposter cleans up state", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const logger = yield* RequestLogger
        const impId = "i-remove"
        yield* logger.log(makeEntry({ id: "rm1", imposterId: impId }))
        yield* logger.removeImposter(impId)
        const entries = yield* logger.getEntries(impId)
        expect(entries.length).toBe(0)
        const count = yield* logger.getCount(impId)
        expect(count).toBe(0)
      })
    )
  })

  it("getEntryById returns entry when found", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const logger = yield* RequestLogger
        const impId = "i-byid"
        yield* logger.log(makeEntry({ id: "byid-1", imposterId: impId }))
        yield* logger.log(makeEntry({ id: "byid-2", imposterId: impId }))
        const found = yield* logger.getEntryById(impId, "byid-1")
        expect(found).not.toBeNull()
        expect(found!.id).toBe("byid-1")
      })
    )
  })

  it("getEntryById returns null when not found", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const logger = yield* RequestLogger
        const found = yield* logger.getEntryById("i-nope", "nonexistent")
        expect(found).toBeNull()
      })
    )
  })

  it("multiple imposters are isolated", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const logger = yield* RequestLogger
        yield* logger.log(makeEntry({ id: "iso1", imposterId: "i-iso-a" }))
        yield* logger.log(makeEntry({ id: "iso2", imposterId: "i-iso-b" }))
        yield* logger.log(makeEntry({ id: "iso3", imposterId: "i-iso-a" }))

        const entriesA = yield* logger.getEntries("i-iso-a")
        const entriesB = yield* logger.getEntries("i-iso-b")
        expect(entriesA.filter((e) => e.id === "iso1" || e.id === "iso3").length).toBe(2)
        expect(entriesB.filter((e) => e.id === "iso2").length).toBe(1)
      })
    )
  })
})
