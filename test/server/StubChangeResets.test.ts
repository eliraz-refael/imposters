import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { ImposterConfig } from "imposters/domain/imposter"
import { MainLayer } from "imposters/layers/MainLayer"
import { ImposterRepository } from "imposters/repositories/ImposterRepository"
import { Stub } from "imposters/schemas/StubSchema"
import { ImposterServer } from "imposters/server/ImposterServer"
import { StubChange } from "imposters/server/StubChange"
import { MetricsService } from "imposters/services/MetricsService"
import { httpGet } from "imposters/test/helpers/net"
import { afterAll, describe, expect, it } from "vitest"

// Port 9349 belongs to this file (9341-9348 to test/e2e/stats-timeline.test.ts).
// The admin API and the /_admin UI both call applyStubChange; this checks what it resets
// in the services themselves, including what the API cannot show (a deleted stub's counters).

const runtime = ManagedRuntime.make(MainLayer)
afterAll(async () => {
  await runtime.dispose()
})

const stub = (id: string, path: string) =>
  Schema.decodeUnknownSync(Stub)({
    id,
    predicates: [{ field: "path", operator: "equals", value: path }],
    responses: [{ status: 200 }, { status: 201 }]
  })

describe("ImposterServer.applyStubChange resets", () => {
  it("removing a stub drops its hit counters and response cycle; other stubs keep theirs", async () => {
    const id = "imp-stub-resets"
    await runtime.runPromise(
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const server = yield* ImposterServer
        yield* repo.create(
          ImposterConfig({
            id,
            name: id,
            port: 9349,
            protocol: "HTTP",
            status: "stopped",
            createdAt: DateTime.nowUnsafe()
          })
        )
        yield* server.applyStubChange(id, StubChange.Add({ stub: stub("gone", "/gone") }))
        yield* server.applyStubChange(id, StubChange.Add({ stub: stub("kept", "/kept") }))
        yield* server.start(id)
      })
    )
    try {
      await httpGet(9349, "/gone")
      await httpGet(9349, "/kept")

      const result = await runtime.runPromise(
        Effect.gen(function*() {
          const server = yield* ImposterServer
          const metrics = yield* MetricsService
          const before = yield* metrics.getStats(id)
          const nextBefore = yield* server.nextResponseIndex(id, "gone")
          yield* server.applyStubChange(id, StubChange.Remove({ stubId: "gone" }))
          const after = yield* metrics.getStats(id)
          return {
            before,
            nextBefore,
            after,
            nextGone: yield* server.nextResponseIndex(id, "gone"),
            nextKept: yield* server.nextResponseIndex(id, "kept")
          }
        })
      )
      expect(result.before.stubs.get("gone")?.hits).toBe(1)
      expect(result.nextBefore).toEqual(Option.some(1))
      expect(result.after.stubs.has("gone")).toBe(false)
      expect(result.after.stubs.get("kept")?.hits).toBe(1)
      expect(result.nextGone).toEqual(Option.none())
      expect(result.nextKept).toEqual(Option.some(1))

      // Re-adding a stub under the same id starts it from scratch
      const readded = await runtime.runPromise(
        Effect.gen(function*() {
          const server = yield* ImposterServer
          yield* server.applyStubChange(id, StubChange.Add({ stub: stub("gone", "/gone") }))
          return yield* server.nextResponseIndex(id, "gone")
        })
      )
      expect(readded).toEqual(Option.some(0))
      expect((await httpGet(9349, "/gone")).status).toBe(200)
    } finally {
      await runtime.runPromise(Effect.gen(function*() {
        yield* (yield* ImposterServer).stop(id)
      }))
    }
  })
})
