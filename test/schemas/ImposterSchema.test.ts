import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect } from "vitest"
import {
  CreateImposterRequest,
  CreateRouteRequest,
  DeleteImposterQuery,
  UpdateImposterRequest
} from "imposters/schemas/ImposterSchema.js"

describe("ImposterSchema", () => {
  describe("CreateImposterRequest", () => {
    it.effect("decodes with defaults", () =>
      Effect.gen(function*() {
        const request = yield* Schema.decodeUnknown(CreateImposterRequest)({})
        expect(request.protocol).toBe("HTTP")
        expect(request.adminPath).toBe("/admin")
      })
    )

    it.effect("accepts custom values", () =>
      Effect.gen(function*() {
        const request = yield* Schema.decodeUnknown(CreateImposterRequest)({
          name: "test-imposter",
          port: 3000,
          adminPath: "/custom"
        })
        expect(request.name).toBe("test-imposter")
        expect(request.port).toBe(3000)
        expect(request.adminPath).toBe("/custom")
      })
    )
  })

  describe("UpdateImposterRequest", () => {
    it.effect("decodes partial updates", () =>
      Effect.gen(function*() {
        const request = yield* Schema.decodeUnknown(UpdateImposterRequest)({
          name: "new-name"
        })
        expect(request.name).toBe("new-name")
      })
    )

    it.effect("accepts port and adminPath", () =>
      Effect.gen(function*() {
        const request = yield* Schema.decodeUnknown(UpdateImposterRequest)({
          port: 4000,
          adminPath: "/new-admin"
        })
        expect(request.port).toBe(4000)
        expect(request.adminPath).toBe("/new-admin")
      })
    )
  })

  describe("CreateRouteRequest", () => {
    it.effect("decodes with defaults", () =>
      Effect.gen(function*() {
        const request = yield* Schema.decodeUnknown(CreateRouteRequest)({
          path: "/test",
          response: { body: { ok: true } }
        })
        expect(request.method).toBe("GET")
        expect(request.response.status).toBe(200)
      })
    )

    it.effect("rejects path without leading slash", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(
          Schema.decodeUnknown(CreateRouteRequest)({
            path: "no-slash",
            response: { body: null }
          })
        )
        expect(result._tag).toBe("ParseError")
      })
    )
  })

  describe("DeleteImposterQuery", () => {
    it.effect("defaults force to false", () =>
      Effect.gen(function*() {
        const query = yield* Schema.decodeUnknown(DeleteImposterQuery)({})
        expect(query.force).toBe(false)
      })
    )
  })
})
