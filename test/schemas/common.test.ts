import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { NonEmptyString, PaginationQuery, PortNumber, PositiveInteger } from "imposters/schemas/common"
import { describe, expect } from "vitest"

describe("common schemas", () => {
  describe("PortNumber", () => {
    it.effect("accepts valid port numbers", () =>
      Effect.gen(function*() {
        const port = yield* Schema.decodeUnknownEffect(PortNumber)(3000)
        expect(port).toBe(3000)
      }))

    it.effect("rejects port below 1024", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(Schema.decodeUnknownEffect(PortNumber)(80))
        expect(result._tag).toBe("SchemaError")
      }))

    it.effect("rejects port above 65535", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(Schema.decodeUnknownEffect(PortNumber)(70000))
        expect(result._tag).toBe("SchemaError")
      }))

    it.effect("rejects non-integer port", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(Schema.decodeUnknownEffect(PortNumber)(3000.5))
        expect(result._tag).toBe("SchemaError")
      }))
  })

  describe("NonEmptyString", () => {
    it.effect("accepts non-empty strings", () =>
      Effect.gen(function*() {
        const s = yield* Schema.decodeUnknownEffect(NonEmptyString)("hello")
        expect(s).toBe("hello")
      }))

    it.effect("rejects empty strings", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(Schema.decodeUnknownEffect(NonEmptyString)(""))
        expect(result._tag).toBe("SchemaError")
      }))
  })

  describe("PositiveInteger", () => {
    it.effect("accepts positive integers", () =>
      Effect.gen(function*() {
        const n = yield* Schema.decodeUnknownEffect(PositiveInteger)(5)
        expect(n).toBe(5)
      }))

    it.effect("rejects zero", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(Schema.decodeUnknownEffect(PositiveInteger)(0))
        expect(result._tag).toBe("SchemaError")
      }))

    it.effect("rejects negative numbers", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(Schema.decodeUnknownEffect(PositiveInteger)(-1))
        expect(result._tag).toBe("SchemaError")
      }))
  })

  describe("PaginationQuery", () => {
    it.effect("applies default limit of 50", () =>
      Effect.gen(function*() {
        const pagination = yield* Schema.decodeUnknownEffect(PaginationQuery)({})
        expect(pagination.limit).toBe(50)
        expect(pagination.offset).toBe(0)
      }))

    it.effect("accepts custom values", () =>
      Effect.gen(function*() {
        const pagination = yield* Schema.decodeUnknownEffect(PaginationQuery)({ limit: 10, offset: 20 })
        expect(pagination.limit).toBe(10)
        expect(pagination.offset).toBe(20)
      }))
  })
})
