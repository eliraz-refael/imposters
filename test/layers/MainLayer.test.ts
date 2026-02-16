import { it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ImposterConfig } from "imposters/domain/imposter"
import { MainLayer } from "imposters/layers/MainLayer"
import { ImposterRepository } from "imposters/repositories/ImposterRepository"
import { Stub } from "imposters/schemas/StubSchema"
import { AppConfig } from "imposters/services/AppConfig"
import { PortAllocator } from "imposters/services/PortAllocator"
import { Uuid } from "imposters/services/Uuid"
import { describe, expect } from "vitest"

describe("MainLayer", () => {
  it.effect("all services resolve", () =>
    Effect.gen(function*() {
      const uuid = yield* Uuid
      const config = yield* AppConfig
      const allocator = yield* PortAllocator
      const repo = yield* ImposterRepository

      expect(uuid).toBeDefined()
      expect(config.adminPort).toBe(2525)
      expect(allocator).toBeDefined()
      expect(repo).toBeDefined()
    }).pipe(Effect.provide(MainLayer)))

  it.effect("integration: create imposter, allocate port, store in repo, add stub, retrieve", () =>
    Effect.gen(function*() {
      const uuid = yield* Uuid
      const allocator = yield* PortAllocator
      const repo = yield* ImposterRepository

      // Generate ID
      const id = yield* uuid.generateShort

      // Allocate port
      const port = yield* allocator.allocate()

      // Create and store imposter
      const config = ImposterConfig({
        id,
        name: "integration-test",
        port,
        status: "running",
        createdAt: DateTime.unsafeNow()
      })
      yield* repo.create(config)

      // Add a stub
      const stub = Schema.decodeUnknownSync(Stub)({
        id: "stub-1",
        predicates: [],
        responses: [{ status: 200 }]
      })
      yield* repo.addStub(id, stub)

      // Retrieve
      const record = yield* repo.get(id)
      expect(record.config.name).toBe("integration-test")
      expect(record.config.port).toBe(port)
      expect(record.stubs).toHaveLength(1)
    }).pipe(Effect.provide(MainLayer)))
})
