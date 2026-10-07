import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Random from "effect/Random"
import { TestClock } from "effect/testing"
import type { RequestContext } from "imposters/matching/RequestMatcher"
import {
  buildResponse,
  makeResponseState,
  peekIndex,
  resolveDelay,
  serveResponse
} from "imposters/matching/ResponseGenerator"
import { requestOnly } from "imposters/matching/TemplateEngine"
import type { ResponseConfig } from "imposters/schemas/StubSchema"
import { describe, expect } from "vitest"

const makeCtx = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  method: "GET",
  path: "/test",
  headers: {},
  query: {},
  body: undefined,
  rawBody: new Uint8Array(0),
  ...overrides
})

const makeResponse = (overrides: Partial<ResponseConfig> = {}): ResponseConfig => ({
  status: 200,
  ...overrides
})

describe("makeResponseState", () => {
  it.effect("sequential mode cycles through indices", () =>
    Effect.gen(function*() {
      const state = yield* makeResponseState()
      const i0 = yield* state.getNextIndex("imp1", "stub1", 3, "sequential")
      const i1 = yield* state.getNextIndex("imp1", "stub1", 3, "sequential")
      const i2 = yield* state.getNextIndex("imp1", "stub1", 3, "sequential")
      const i3 = yield* state.getNextIndex("imp1", "stub1", 3, "sequential")
      expect(i0).toBe(0)
      expect(i1).toBe(1)
      expect(i2).toBe(2)
      expect(i3).toBe(0) // wraps around
    }))

  it.effect("repeat mode sticks to last response", () =>
    Effect.gen(function*() {
      const state = yield* makeResponseState()
      const i0 = yield* state.getNextIndex("imp1", "stub1", 2, "repeat")
      const i1 = yield* state.getNextIndex("imp1", "stub1", 2, "repeat")
      const i2 = yield* state.getNextIndex("imp1", "stub1", 2, "repeat")
      const i3 = yield* state.getNextIndex("imp1", "stub1", 2, "repeat")
      expect(i0).toBe(0)
      expect(i1).toBe(1)
      expect(i2).toBe(1) // sticks to last
      expect(i3).toBe(1)
    }))

  it.effect("random mode returns valid indices", () =>
    Effect.gen(function*() {
      const state = yield* makeResponseState()
      for (let i = 0; i < 20; i++) {
        const idx = yield* state.getNextIndex("imp1", "stub1", 3, "random")
        expect(idx).toBeGreaterThanOrEqual(0)
        expect(idx).toBeLessThan(3)
      }
    }))

  it.effect("random mode draws through Effect's Random, so a test can pick the index", () =>
    Effect.gen(function*() {
      const state = yield* makeResponseState()
      expect(yield* state.getNextIndex("imp1", "stub1", 3, "random").pipe(withRandom(0))).toBe(0)
      expect(yield* state.getNextIndex("imp1", "stub1", 3, "random").pipe(withRandom(0.5))).toBe(1)
      expect(yield* state.getNextIndex("imp1", "stub1", 3, "random").pipe(withRandom(TOP))).toBe(2)
    }))

  it.effect("different stubs have independent counters", () =>
    Effect.gen(function*() {
      const state = yield* makeResponseState()
      const a0 = yield* state.getNextIndex("imp1", "stubA", 3, "sequential")
      const b0 = yield* state.getNextIndex("imp1", "stubB", 3, "sequential")
      expect(a0).toBe(0)
      expect(b0).toBe(0)
    }))

  it.effect("reset clears counters for an imposter", () =>
    Effect.gen(function*() {
      const state = yield* makeResponseState()
      yield* state.getNextIndex("imp1", "stub1", 3, "sequential")
      yield* state.getNextIndex("imp1", "stub1", 3, "sequential")
      yield* state.reset("imp1")
      const afterReset = yield* state.getNextIndex("imp1", "stub1", 3, "sequential")
      expect(afterReset).toBe(0)
    }))

  it.effect("peekNextIndex tells the sequential answer to come without consuming it", () =>
    Effect.gen(function*() {
      const state = yield* makeResponseState()
      const peeks: Array<Option.Option<number>> = []
      for (let i = 0; i < 4; i++) {
        const peeked = yield* state.peekNextIndex("imp1", "s", 3, "sequential")
        // Peeking twice changes nothing
        expect(yield* state.peekNextIndex("imp1", "s", 3, "sequential")).toEqual(peeked)
        peeks.push(peeked)
        expect(Option.some(yield* state.getNextIndex("imp1", "s", 3, "sequential"))).toEqual(peeked)
      }
      expect(peeks).toEqual([0, 1, 2, 0].map(Option.some))
    }))

  it.effect("peekNextIndex stays on the last response in repeat mode", () =>
    Effect.gen(function*() {
      const state = yield* makeResponseState()
      const peeks: Array<Option.Option<number>> = []
      for (let i = 0; i < 4; i++) {
        peeks.push(yield* state.peekNextIndex("imp1", "s", 2, "repeat"))
        yield* state.getNextIndex("imp1", "s", 2, "repeat")
      }
      expect(peeks).toEqual([0, 1, 1, 1].map(Option.some))
    }))

  it.effect("peekNextIndex is None in random mode", () =>
    Effect.gen(function*() {
      const state = yield* makeResponseState()
      expect(yield* state.peekNextIndex("imp1", "s", 3, "random")).toEqual(Option.none())
      yield* state.getNextIndex("imp1", "s", 3, "random")
      expect(yield* state.peekNextIndex("imp1", "s", 3, "random")).toEqual(Option.none())
    }))

  it.effect("resetStub restarts one stub's cycle and leaves the others", () =>
    Effect.gen(function*() {
      const state = yield* makeResponseState()
      yield* state.getNextIndex("imp1", "a", 3, "sequential")
      yield* state.getNextIndex("imp1", "a", 3, "sequential")
      yield* state.getNextIndex("imp1", "b", 3, "sequential")
      yield* state.resetStub("imp1", "a")
      expect(yield* state.peekNextIndex("imp1", "a", 3, "sequential")).toEqual(Option.some(0))
      expect(yield* state.peekNextIndex("imp1", "b", 3, "sequential")).toEqual(Option.some(1))
    }))
})

describe("peekIndex", () => {
  it("maps a counter to the next index for each mode", () => {
    expect(peekIndex(4, 3, "sequential")).toEqual(Option.some(1))
    expect(peekIndex(4, 3, "repeat")).toEqual(Option.some(2))
    expect(peekIndex(0, 3, "random")).toEqual(Option.none())
  })
})

describe("buildResponse", () => {
  it("builds response with status and JSON body", async () => {
    const config = makeResponse({ status: 201, body: { message: "Created" } })
    const resp = await buildResponse(config, requestOnly(makeCtx()))
    expect(resp.status).toBe(201)
    expect(resp.headers.get("content-type")).toBe("application/json")
  })

  it("builds response with string body", async () => {
    const config = makeResponse({ body: "hello" })
    const resp = await buildResponse(config, requestOnly(makeCtx()))
    expect(resp.headers.get("content-type")).toBe("text/plain")
  })

  it("builds response with custom headers", async () => {
    const config = makeResponse({ headers: { "x-custom": "value", "x-id": "123" } })
    const resp = await buildResponse(config, requestOnly(makeCtx()))
    expect(resp.headers.get("x-custom")).toBe("value")
    expect(resp.headers.get("x-id")).toBe("123")
  })

  it("builds response with no body", async () => {
    const config = makeResponse({ status: 204 })
    const resp = await buildResponse(config, requestOnly(makeCtx()))
    expect(resp.status).toBe(204)
  })

  it.each([204, 205, 304])("drops a configured body for null-body status %i instead of throwing", async (status) => {
    const config = makeResponse({ status, body: { ignored: true } })
    const resp = await buildResponse(config, requestOnly(makeCtx()))
    expect(resp.status).toBe(status)
    expect(resp.body).toBeNull()
  })

  it("applies templates to body", async () => {
    const config = makeResponse({ body: { greeting: "Hello {{request.query.name}}" } })
    const ctx = makeCtx({ query: { name: "Alice" } })
    const resp = await buildResponse(config, requestOnly(ctx))
    expect(resp.status).toBe(200)
    const text = await resp.text()
    const parsed = JSON.parse(text)
    expect(parsed.greeting).toBe("Hello Alice")
  })

  it("applies templates to header values", async () => {
    const config = makeResponse({ headers: { "x-method": "{{request.method}}" } })
    const ctx = makeCtx({ method: "POST" })
    const resp = await buildResponse(config, requestOnly(ctx))
    expect(resp.headers.get("x-method")).toBe("POST")
  })
})

// A Random whose every draw is `double` (in [0, 1)), so the delay it picks is known in advance
const fixedRandom = (double: number): Random.Random => ({
  nextDoubleUnsafe: () => double,
  nextIntUnsafe: () => 0
})
const withRandom = (double: number) => Effect.provideService(Random.Random, fixedRandom(double))
// The largest double below 1, the top of a draw
const TOP = 1 - Number.EPSILON

describe("resolveDelay", () => {
  it.effect("is 0 without a delay, and the number itself for a fixed one", () =>
    Effect.gen(function*() {
      expect(yield* resolveDelay(undefined)).toBe(0)
      expect(yield* resolveDelay(0)).toBe(0)
      expect(yield* resolveDelay(250).pipe(withRandom(TOP))).toBe(250)
    }))

  it.effect("draws a whole number in [min, max], both ends included", () =>
    Effect.gen(function*() {
      const range = { min: 100, max: 200 }
      expect(yield* resolveDelay(range).pipe(withRandom(0))).toBe(100)
      expect(yield* resolveDelay(range).pipe(withRandom(0.5))).toBe(150)
      expect(yield* resolveDelay(range).pipe(withRandom(TOP))).toBe(200)
    }))

  it.effect("covers the whole range uniformly and never leaves it, draw after draw", () =>
    Effect.gen(function*() {
      const counts = new Map<number, number>()
      for (let i = 0; i < 2000; i++) {
        const ms = yield* resolveDelay({ min: 3, max: 7 })
        counts.set(ms, (counts.get(ms) ?? 0) + 1)
      }
      expect([...counts.keys()].sort()).toEqual([3, 4, 5, 6, 7])
      // 400 expected per value; a seeded run is deterministic, the bound only guards against a skew
      for (const count of counts.values()) expect(count).toBeGreaterThan(300)
    }).pipe(Random.withSeed("delay-ranges")))

  it.effect("is fixed when min equals max, whatever the draw", () =>
    Effect.gen(function*() {
      expect(yield* resolveDelay({ min: 300, max: 300 }).pipe(withRandom(0))).toBe(300)
      expect(yield* resolveDelay({ min: 300, max: 300 }).pipe(withRandom(TOP))).toBe(300)
      expect(yield* resolveDelay({ min: 0, max: 0 }).pipe(withRandom(TOP))).toBe(0)
    }))
})

// it.effect runs on a TestClock, so these waits are virtual: nothing really sleeps
describe("serveResponse", () => {
  const ctx = makeCtx()

  // Forks the answer, then moves the clock: still waiting 1ms short of `ms`, answered at `ms`
  const expectWaits = (config: ResponseConfig, ms: number) =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(serveResponse(config, requestOnly(ctx)), { startImmediately: true })
      if (ms > 0) {
        yield* TestClock.adjust(ms - 1)
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust(1)
      }
      const response = yield* Fiber.join(fiber)
      expect(response.status).toBe(config.status)
    })

  it.effect("answers at once without a delay", () => expectWaits(makeResponse({ status: 201 }), 0))

  it.effect("waits exactly a fixed delay", () => expectWaits(makeResponse({ delay: 250 }), 250))

  it.effect("waits exactly the delay drawn from a range", () =>
    // 0.5 of [100, 200] draws 150
    expectWaits(makeResponse({ delay: { min: 100, max: 200 } }), 150).pipe(withRandom(0.5)))

  it.effect("waits the range's max on the top draw", () =>
    expectWaits(makeResponse({ delay: { min: 100, max: 200 } }), 200).pipe(withRandom(TOP)))

  it.effect("draws afresh for every answer", () =>
    Effect.gen(function*() {
      const config = makeResponse({ delay: { min: 10, max: 20 } })
      yield* expectWaits(config, 10).pipe(withRandom(0))
      yield* expectWaits(config, 20).pipe(withRandom(TOP))
    }))

  it.effect("waits exactly n for a range of n to n", () =>
    expectWaits(makeResponse({ delay: { min: 75, max: 75 } }), 75).pipe(withRandom(TOP)))

  it.effect("builds the response after the wait", () =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(
        serveResponse(makeResponse({ status: 202, body: { ok: true }, delay: 40 }), requestOnly(ctx)),
        { startImmediately: true }
      )
      yield* TestClock.adjust(40)
      const response = yield* Fiber.join(fiber)
      expect(response.status).toBe(202)
      expect(yield* Effect.promise(() => response.json())).toEqual({ ok: true })
    }))
})
