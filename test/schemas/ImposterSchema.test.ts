import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  CreateImposterRequest,
  CreateRouteRequest,
  DeleteImposterQuery,
  UpdateImposterRequest
} from "imposters/schemas/ImposterSchema"
import { describe, expect } from "vitest"

describe("ImposterSchema", () => {
  describe("CreateImposterRequest", () => {
    it.effect("decodes with defaults", () =>
      Effect.gen(function*() {
        const request = yield* Schema.decodeUnknownEffect(CreateImposterRequest)({})
        expect(request.protocol).toBe("HTTP")
        expect(request.adminPath).toBe("/_admin")
      }))

    it.effect("accepts custom values", () =>
      Effect.gen(function*() {
        const request = yield* Schema.decodeUnknownEffect(CreateImposterRequest)({
          name: "test-imposter",
          port: 3000,
          adminPath: "/custom"
        })
        expect(request.name).toBe("test-imposter")
        expect(request.port).toBe(3000)
        expect(request.adminPath).toBe("/custom")
      }))
  })

  describe("UpdateImposterRequest", () => {
    it.effect("decodes partial updates", () =>
      Effect.gen(function*() {
        const request = yield* Schema.decodeUnknownEffect(UpdateImposterRequest)({
          name: "new-name"
        })
        expect(request.name).toBe("new-name")
      }))

    it.effect("accepts port and adminPath", () =>
      Effect.gen(function*() {
        const request = yield* Schema.decodeUnknownEffect(UpdateImposterRequest)({
          port: 4000,
          adminPath: "/new-admin"
        })
        expect(request.port).toBe(4000)
        expect(request.adminPath).toBe("/new-admin")
      }))
  })

  describe("CreateRouteRequest", () => {
    it.effect("decodes with defaults", () =>
      Effect.gen(function*() {
        const request = yield* Schema.decodeUnknownEffect(CreateRouteRequest)({
          path: "/test",
          response: { body: { ok: true } }
        })
        expect(request.method).toBe("GET")
        expect(request.response.status).toBe(200)
      }))

    it.effect("rejects path without leading slash", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(
          Schema.decodeUnknownEffect(CreateRouteRequest)({
            path: "no-slash",
            response: { body: null }
          })
        )
        expect(result._tag).toBe("SchemaError")
      }))
  })

  describe("DeleteImposterQuery", () => {
    it.effect("defaults force to false", () =>
      Effect.gen(function*() {
        const query = yield* Schema.decodeUnknownEffect(DeleteImposterQuery)({})
        expect(query.force).toBe(false)
      }))
  })
})
