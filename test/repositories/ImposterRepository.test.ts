import { it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ImposterConfig } from "imposters/domain/imposter.js"
import { ImposterRepository, ImposterRepositoryLive } from "imposters/repositories/ImposterRepository.js"
import { Stub } from "imposters/schemas/StubSchema.js"
import { describe, expect } from "vitest"

const makeConfig = (id: string, name: string): ImposterConfig =>
  ImposterConfig({
    id,
    name,
    port: 3000,
    status: "stopped",
    createdAt: DateTime.unsafeNow()
  })

const makeStub = (id: string) =>
  Schema.decodeUnknownSync(Stub)({
    id,
    predicates: [],
    responses: [{ status: 200 }]
  })

describe("ImposterRepository", () => {
  it.effect("create and get imposter", () =>
    Effect.gen(function*() {
      const repo = yield* ImposterRepository
      const config = makeConfig("imp-1", "test")
      const created = yield* repo.create(config)
      expect(created.config.id).toBe("imp-1")
      expect(created.stubs).toEqual([])

      const fetched = yield* repo.get("imp-1")
      expect(fetched.config.name).toBe("test")
    }).pipe(Effect.provide(ImposterRepositoryLive)))

  it.effect("get missing imposter fails", () =>
    Effect.gen(function*() {
      const repo = yield* ImposterRepository
      const error = yield* Effect.flip(repo.get("nonexistent"))
      expect(error._tag).toBe("ImposterNotFoundError")
    }).pipe(Effect.provide(ImposterRepositoryLive)))

  it.effect("update imposter config", () =>
    Effect.gen(function*() {
      const repo = yield* ImposterRepository
      yield* repo.create(makeConfig("imp-1", "test"))
      const updated = yield* repo.update("imp-1", (r) => ({
        ...r,
        config: ImposterConfig({ ...r.config, name: "updated" })
      }))
      expect(updated.config.name).toBe("updated")

      const fetched = yield* repo.get("imp-1")
      expect(fetched.config.name).toBe("updated")
    }).pipe(Effect.provide(ImposterRepositoryLive)))

  it.effect("remove imposter", () =>
    Effect.gen(function*() {
      const repo = yield* ImposterRepository
      yield* repo.create(makeConfig("imp-1", "test"))
      const removed = yield* repo.remove("imp-1")
      expect(removed.config.id).toBe("imp-1")

      const error = yield* Effect.flip(repo.get("imp-1"))
      expect(error._tag).toBe("ImposterNotFoundError")
    }).pipe(Effect.provide(ImposterRepositoryLive)))

  it.effect("getAll returns all imposters", () =>
    Effect.gen(function*() {
      const repo = yield* ImposterRepository
      yield* repo.create(makeConfig("imp-1", "first"))
      yield* repo.create(makeConfig("imp-2", "second"))
      const all = yield* repo.getAll
      expect(all).toHaveLength(2)
    }).pipe(Effect.provide(ImposterRepositoryLive)))

  describe("stub management", () => {
    it.effect("add and get stubs", () =>
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        yield* repo.create(makeConfig("imp-1", "test"))

        const stub = makeStub("stub-1")
        yield* repo.addStub("imp-1", stub)

        const stubs = yield* repo.getStubs("imp-1")
        expect(stubs).toHaveLength(1)
        expect(stubs[0]!.id).toBe("stub-1")
      }).pipe(Effect.provide(ImposterRepositoryLive)))

    it.effect("update stub", () =>
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        yield* repo.create(makeConfig("imp-1", "test"))
        yield* repo.addStub("imp-1", makeStub("stub-1"))

        const updated = yield* repo.updateStub("imp-1", "stub-1", (s) => ({
          ...s,
          responses: [{ status: 404 }]
        }))
        expect(updated.responses[0]!.status).toBe(404)
      }).pipe(Effect.provide(ImposterRepositoryLive)))

    it.effect("remove stub", () =>
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        yield* repo.create(makeConfig("imp-1", "test"))
        yield* repo.addStub("imp-1", makeStub("stub-1"))

        const removed = yield* repo.removeStub("imp-1", "stub-1")
        expect(removed.id).toBe("stub-1")

        const stubs = yield* repo.getStubs("imp-1")
        expect(stubs).toHaveLength(0)
      }).pipe(Effect.provide(ImposterRepositoryLive)))

    it.effect("update missing stub fails", () =>
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        yield* repo.create(makeConfig("imp-1", "test"))

        const error = yield* Effect.flip(
          repo.updateStub("imp-1", "nonexistent", (s) => s)
        )
        expect(error._tag).toBe("StubNotFoundError")
      }).pipe(Effect.provide(ImposterRepositoryLive)))

    it.effect("stub operations on missing imposter fail", () =>
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const error = yield* Effect.flip(repo.getStubs("nonexistent"))
        expect(error._tag).toBe("ImposterNotFoundError")
      }).pipe(Effect.provide(ImposterRepositoryLive)))
  })
})
