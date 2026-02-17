import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { CreateStubRequest, Predicate, ResponseConfig, Stub } from "imposters/schemas/StubSchema"
import { describe, expect } from "vitest"

describe("StubSchema", () => {
  describe("ResponseConfig", () => {
    it.effect("defaults status to 200", () =>
      Effect.gen(function*() {
        const config = yield* Schema.decodeUnknown(ResponseConfig)({})
        expect(config.status).toBe(200)
      }))

    it.effect("accepts custom status", () =>
      Effect.gen(function*() {
        const config = yield* Schema.decodeUnknown(ResponseConfig)({ status: 404 })
        expect(config.status).toBe(404)
      }))

    it.effect("rejects invalid status", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(Schema.decodeUnknown(ResponseConfig)({ status: 999 }))
        expect(result._tag).toBe("ParseError")
      }))
  })

  describe("Predicate", () => {
    it.effect("decodes valid predicate", () =>
      Effect.gen(function*() {
        const predicate = yield* Schema.decodeUnknown(Predicate)({
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
          Schema.decodeUnknown(Predicate)({
            field: "path",
            operator: "invalid",
            value: "/test"
          })
        )
        expect(result._tag).toBe("ParseError")
      }))
  })

  describe("Stub", () => {
    it.effect("decodes valid stub", () =>
      Effect.gen(function*() {
        const stub = yield* Schema.decodeUnknown(Stub)({
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
          Schema.decodeUnknown(Stub)({
            id: "stub-1",
            predicates: [],
            responses: []
          })
        )
        expect(result._tag).toBe("ParseError")
      }))
  })

  describe("CreateStubRequest", () => {
    it.effect("defaults predicates to empty and responseMode to sequential", () =>
      Effect.gen(function*() {
        const request = yield* Schema.decodeUnknown(CreateStubRequest)({
          responses: [{ body: "hello" }]
        })
        expect(request.predicates).toEqual([])
        expect(request.responseMode).toBe("sequential")
      }))
  })
})
