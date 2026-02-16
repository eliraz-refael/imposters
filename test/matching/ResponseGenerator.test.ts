import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type { RequestContext } from "imposters/matching/RequestMatcher.js"
import { buildResponse, makeResponseState } from "imposters/matching/ResponseGenerator.js"
import type { ResponseConfig } from "imposters/schemas/StubSchema.js"
import { describe, expect } from "vitest"

const makeCtx = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  method: "GET",
  path: "/test",
  headers: {},
  query: {},
  body: undefined,
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
})

describe("buildResponse", () => {
  it("builds response with status and JSON body", async () => {
    const config = makeResponse({ status: 201, body: { message: "Created" } })
    const resp = await buildResponse(config, makeCtx())
    expect(resp.status).toBe(201)
    expect(resp.headers.get("content-type")).toBe("application/json")
  })

  it("builds response with string body", async () => {
    const config = makeResponse({ body: "hello" })
    const resp = await buildResponse(config, makeCtx())
    expect(resp.headers.get("content-type")).toBe("text/plain")
  })

  it("builds response with custom headers", async () => {
    const config = makeResponse({ headers: { "x-custom": "value", "x-id": "123" } })
    const resp = await buildResponse(config, makeCtx())
    expect(resp.headers.get("x-custom")).toBe("value")
    expect(resp.headers.get("x-id")).toBe("123")
  })

  it("builds response with no body", async () => {
    const config = makeResponse({ status: 204 })
    const resp = await buildResponse(config, makeCtx())
    expect(resp.status).toBe(204)
  })

  it("applies templates to body", async () => {
    const config = makeResponse({ body: { greeting: "Hello {{request.query.name}}" } })
    const ctx = makeCtx({ query: { name: "Alice" } })
    const resp = await buildResponse(config, ctx)
    expect(resp.status).toBe(200)
    const text = await resp.text()
    const parsed = JSON.parse(text)
    expect(parsed.greeting).toBe("Hello Alice")
  })

  it("applies templates to header values", async () => {
    const config = makeResponse({ headers: { "x-method": "{{request.method}}" } })
    const ctx = makeCtx({ method: "POST" })
    const resp = await buildResponse(config, ctx)
    expect(resp.headers.get("x-method")).toBe("POST")
  })
})
