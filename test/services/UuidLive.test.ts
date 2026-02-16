import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Uuid } from "imposters/services/Uuid.js"
import { UuidLive } from "imposters/services/UuidLive.js"
import { describe, expect } from "vitest"

describe("UuidLive", () => {
  it.effect("generate returns valid UUID v4 format", () =>
    Effect.gen(function*() {
      const uuid = yield* Uuid
      const id = yield* uuid.generate
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }).pipe(Effect.provide(UuidLive)))

  it.effect("generateShort returns 8-char hex string", () =>
    Effect.gen(function*() {
      const uuid = yield* Uuid
      const id = yield* uuid.generateShort
      expect(id).toHaveLength(8)
      expect(id).toMatch(/^[0-9a-f]{8}$/)
    }).pipe(Effect.provide(UuidLive)))

  it.effect("two calls produce different IDs", () =>
    Effect.gen(function*() {
      const uuid = yield* Uuid
      const id1 = yield* uuid.generate
      const id2 = yield* uuid.generate
      expect(id1).not.toBe(id2)
    }).pipe(Effect.provide(UuidLive)))
})
