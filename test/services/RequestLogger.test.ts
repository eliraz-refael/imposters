import { Effect, Exit, Fiber, ManagedRuntime, Scope, Stream } from "effect"
import * as DateTime from "effect/DateTime"
import { NonEmptyString } from "imposters/schemas/common"
import type { RequestLogEntry } from "imposters/schemas/RequestLogSchema"
import { RequestLogger, RequestLoggerLive } from "imposters/services/RequestLogger"
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
  timestamp: DateTime.nowUnsafe(),
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
    outcome: overrides.matchedStubId !== undefined ? "stub" : "unmatched",
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

  it("numbers every entry in log order, across imposters, and getRecent returns the latest with their numbers", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const logger = yield* RequestLogger
        for (const [id, imposterId] of [["q1", "i-seq-a"], ["q2", "i-seq-b"], ["q3", "i-seq-a"], ["q4", "i-seq-a"]]) {
          yield* logger.log(makeEntry({ id, imposterId }))
        }
        const recent = yield* logger.getRecent("i-seq-a", 2)
        expect(recent.map((row) => row.entry.id)).toEqual(["q3", "q4"])
        const all = yield* logger.getRecent("i-seq-a", 10)
        const seqs = all.map((row) => row.seq)
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
        expect(new Set(seqs).size).toBe(3)
        // Numbered across imposters: q2 sits between q1 and q3
        const [b] = yield* logger.getRecent("i-seq-b", 1)
        expect(b !== undefined && seqs[0] !== undefined && seqs[1] !== undefined && b.seq > seqs[0] && b.seq < seqs[1])
          .toBe(true)
        // Clearing the log does not restart the numbering
        yield* logger.clear("i-seq-a")
        yield* logger.log(makeEntry({ id: "q5", imposterId: "i-seq-a" }))
        const [after] = yield* logger.getRecent("i-seq-a", 1)
        expect((after?.seq ?? 0) > (seqs.at(-1) ?? Infinity)).toBe(true)
      })
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

  it("follow: from the moment it returns, the imposter's entries and no other's", async () => {
    await runtime.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const logger = yield* RequestLogger
        yield* logger.log(makeEntry({ id: "before", imposterId: "i-follow" }))
        const entries = yield* logger.follow("i-follow")
        // Logged before the stream is first pulled, but after follow returned: not missed
        yield* logger.log(makeEntry({ id: "f1", imposterId: "i-follow" }))
        yield* logger.log(makeEntry({ id: "other", imposterId: "i-follow-other" }))
        yield* logger.log(makeEntry({ id: "f2", imposterId: "i-follow" }))
        const received = yield* entries.pipe(Stream.take(2), Stream.runCollect)
        expect(Array.from(received, (row) => row.entry.id)).toEqual(["f1", "f2"])
      }))
    )
  })

  it("followers: counts open follows, and closing the scope releases one", async () => {
    await runtime.runPromise(
      Effect.gen(function*() {
        const logger = yield* RequestLogger
        expect(yield* logger.followers("i-count")).toBe(0)
        const scope = yield* Scope.make()
        const entries = yield* logger.follow("i-count").pipe(Scope.provide(scope))
        const reader = yield* Effect.forkChild(Stream.runDrain(entries))
        expect(yield* logger.followers("i-count")).toBe(1)
        expect(yield* logger.followers("i-other")).toBe(0)
        yield* Fiber.interrupt(reader)
        yield* Scope.close(scope, Exit.void)
        expect(yield* logger.followers("i-count")).toBe(0)
      })
    )
  })
})
