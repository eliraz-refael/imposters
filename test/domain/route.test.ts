import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  createResponseWithParams,
  createRoute,
  newRoute,
  Response,
  RouteError,
  RouteNotFoundError,
  substituteParams,
  updateRoute
} from "imposters/domain/route.js"
import { Uuid } from "imposters/services/Uuid.js"
import { describe, expect } from "vitest"

const TestUuid = Layer.succeed(Uuid, {
  generate: Effect.succeed("test-uuid-full"),
  generateShort: Effect.succeed("test1234")
})

describe("route domain", () => {
  describe("createRoute", () => {
    it.effect("creates route from validated input", () =>
      Effect.gen(function*() {
        const route = yield* createRoute({
          path: "/test",
          method: "GET",
          response: { status: 200, body: { ok: true } }
        })
        expect(route._tag).toBe("Route")
        expect(route.path).toBe("/test")
        expect(route.method).toBe("GET")
        expect(route.response.status).toBe(200)
        expect(route.id).toBe("test-uuid-full")
      }).pipe(Effect.provide(TestUuid)))

    it.effect("uses provided id when given", () =>
      Effect.gen(function*() {
        const route = yield* createRoute({
          id: "custom-id",
          path: "/test",
          method: "POST",
          response: { status: 201, body: null }
        })
        expect(route.id).toBe("custom-id")
      }).pipe(Effect.provide(TestUuid)))
  })

  describe("newRoute", () => {
    it.effect("parses and creates route from raw input", () =>
      Effect.gen(function*() {
        const route = yield* newRoute({
          path: "/api/users",
          method: "GET",
          response: { body: [{ id: 1 }] }
        })
        expect(route.path).toBe("/api/users")
        expect(route.response.status).toBe(200)
      }).pipe(Effect.provide(TestUuid)))

    it.effect("fails with ParseError for invalid input", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(newRoute({ path: "no-slash", response: { body: null } }))
        expect(result._tag).toBe("ParseError")
      }).pipe(Effect.provide(TestUuid)))
  })

  describe("updateRoute", () => {
    it.effect("preserves original createdAt", () =>
      Effect.gen(function*() {
        const original = yield* createRoute({
          path: "/original",
          method: "GET",
          response: { status: 200, body: null }
        })
        const updated = yield* updateRoute({ path: "/updated" })(original)
        expect(updated.path).toBe("/updated")
        expect(updated.createdAt).toEqual(original.createdAt)
      }).pipe(Effect.provide(TestUuid)))
  })

  describe("substituteParams", () => {
    it("substitutes in strings", () => {
      const result = substituteParams({ userId: "42" })("Hello {{userId}}")
      expect(result).toBe("Hello 42")
    })

    it("substitutes in nested objects", () => {
      const result = substituteParams({ name: "Alice" })({
        greeting: "Hello {{name}}",
        nested: { msg: "Hi {{name}}" }
      })
      expect(result).toEqual({
        greeting: "Hello Alice",
        nested: { msg: "Hi Alice" }
      })
    })

    it("substitutes in arrays", () => {
      const result = substituteParams({ x: "1" })(["{{x}}", "{{x}}"])
      expect(result).toEqual(["1", "1"])
    })

    it("returns non-string primitives unchanged", () => {
      expect(substituteParams({ x: "1" })(42)).toBe(42)
      expect(substituteParams({ x: "1" })(true)).toBe(true)
      expect(substituteParams({ x: "1" })(null)).toBe(null)
    })
  })

  describe("createResponseWithParams", () => {
    it("substitutes params in response body", () => {
      const response = Response({
        status: 200,
        headers: Option.none(),
        body: { message: "Hello {{name}}" }
      })
      const result = createResponseWithParams({ name: "World" })(response)
      expect(result.body).toEqual({ message: "Hello World" })
      expect(result.status).toBe(200)
    })
  })

  describe("errors", () => {
    it("RouteError is a proper tagged error", () => {
      const err = new RouteError({ reason: "bad route" })
      expect(err._tag).toBe("RouteError")
      expect(err instanceof Error).toBe(true)
    })

    it("RouteNotFoundError is a proper tagged error", () => {
      const err = new RouteNotFoundError({ id: "abc" })
      expect(err._tag).toBe("RouteNotFoundError")
      expect(err instanceof Error).toBe(true)
    })
  })
})
