import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { CreateStubRequest, Delay, Predicate, ResponseConfig, Stub } from "imposters/schemas/StubSchema"
import { describe, expect } from "vitest"

describe("StubSchema", () => {
  describe("ResponseConfig", () => {
    it.effect("defaults status to 200", () =>
      Effect.gen(function*() {
        const config = yield* Schema.decodeUnknownEffect(ResponseConfig)({})
        expect(config.status).toBe(200)
      }))

    it.effect("accepts custom status", () =>
      Effect.gen(function*() {
        const config = yield* Schema.decodeUnknownEffect(ResponseConfig)({ status: 404 })
        expect(config.status).toBe(404)
      }))

    it.effect("rejects invalid status", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(Schema.decodeUnknownEffect(ResponseConfig)({ status: 999 }))
        expect(result._tag).toBe("SchemaError")
      }))
  })

  describe("Delay", () => {
    const decodeResponse = Schema.decodeUnknownEffect(ResponseConfig)
    // The message the API would put in its 400 body, with the failing path
    const rejection = (delay: unknown) =>
      Effect.flip(decodeResponse({ delay })).pipe(Effect.map((error) => error.message))

    it.effect("leaves delay out when it is not given", () =>
      Effect.gen(function*() {
        const config = yield* decodeResponse({})
        expect(config.delay).toBeUndefined()
      }))

    it.effect("accepts a fixed number of milliseconds", () =>
      Effect.gen(function*() {
        expect((yield* decodeResponse({ delay: 0 })).delay).toBe(0)
        expect((yield* decodeResponse({ delay: 250 })).delay).toBe(250)
        expect((yield* decodeResponse({ delay: 60000 })).delay).toBe(60000)
      }))

    it.effect("accepts a range, and keeps it in the form it was given", () =>
      Effect.gen(function*() {
        expect((yield* decodeResponse({ delay: { min: 100, max: 500 } })).delay).toEqual({ min: 100, max: 500 })
        expect((yield* decodeResponse({ delay: { min: 0, max: 60000 } })).delay).toEqual({ min: 0, max: 60000 })
        expect(yield* Schema.encodeEffect(Delay)({ min: 100, max: 500 })).toEqual({ min: 100, max: 500 })
      }))

    it.effect("accepts a range whose min equals its max", () =>
      Effect.gen(function*() {
        expect((yield* decodeResponse({ delay: { min: 300, max: 300 } })).delay).toEqual({ min: 300, max: 300 })
      }))

    it.effect("rejects a range whose min is above its max, saying why", () =>
      Effect.gen(function*() {
        const message = yield* rejection({ min: 500, max: 100 })
        expect(message).toContain("max (100) must be greater than or equal to min (500)")
        expect(message).toContain(`["delay"]["max"]`)
      }))

    it.effect("rejects out-of-bounds delays, fixed or ranged", () =>
      Effect.gen(function*() {
        expect(yield* rejection(-1)).toContain("Expected a value between 0 and 60000")
        expect(yield* rejection(60001)).toContain("Expected a value between 0 and 60000")
        expect(yield* rejection({ min: -1, max: 10 })).toContain(`["delay"]["min"]`)
        expect(yield* rejection({ min: 10, max: 60001 })).toContain(`["delay"]["max"]`)
      }))

    it.effect("rejects non-integer delays, fixed or ranged", () =>
      Effect.gen(function*() {
        expect(yield* rejection(1.5)).toContain("Expected an integer")
        expect(yield* rejection({ min: 1.5, max: 10 })).toContain("Expected an integer")
        expect(yield* rejection({ min: 1, max: 9.9 })).toContain("Expected an integer")
      }))

    it.effect("rejects a range missing a bound, and other shapes", () =>
      Effect.gen(function*() {
        expect(yield* rejection({ min: 10 })).toContain(`["delay"]["max"]`)
        expect(yield* rejection({ max: 10 })).toContain(`["delay"]["min"]`)
        expect(yield* rejection("100")).toContain(`["delay"]`)
        expect(yield* rejection([100, 200])).toContain(`["delay"]`)
      }))
  })

  describe("Predicate", () => {
    it.effect("decodes valid predicate", () =>
      Effect.gen(function*() {
        const predicate = yield* Schema.decodeUnknownEffect(Predicate)({
          field: "path",
          operator: "equals",
          value: "/test"
        })
        expect(predicate.field).toBe("path")
        expect(predicate.operator).toBe("equals")
        expect(predicate.caseSensitive).toBe(true)
      }))

    it.effect("rejects invalid operator", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(
          Schema.decodeUnknownEffect(Predicate)({
            field: "path",
            operator: "invalid",
            value: "/test"
          })
        )
        expect(result._tag).toBe("SchemaError")
      }))
  })

  describe("Stub", () => {
    it.effect("decodes valid stub", () =>
      Effect.gen(function*() {
        const stub = yield* Schema.decodeUnknownEffect(Stub)({
          id: "stub-1",
          predicates: [{ field: "path", operator: "equals", value: "/test" }],
          responses: [{ status: 200, body: { ok: true } }]
        })
        expect(stub.id).toBe("stub-1")
        expect(stub.predicates).toHaveLength(1)
        expect(stub.responses).toHaveLength(1)
        expect(stub.responseMode).toBe("sequential")
      }))

    it.effect("rejects empty responses array", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(
          Schema.decodeUnknownEffect(Stub)({
            id: "stub-1",
            predicates: [],
            responses: []
          })
        )
        expect(result._tag).toBe("SchemaError")
      }))
  })

  describe("CreateStubRequest", () => {
    it.effect("defaults predicates to empty and responseMode to sequential", () =>
      Effect.gen(function*() {
        const request = yield* Schema.decodeUnknownEffect(CreateStubRequest)({
          responses: [{ body: "hello" }]
        })
        expect(request.predicates).toEqual([])
        expect(request.responseMode).toBe("sequential")
      }))
  })
})
