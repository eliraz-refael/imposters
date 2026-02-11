import * as Effect from "effect/Effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Ref from "effect/Ref"
import { afterAll, describe, expect, it } from "vitest"
import { FiberManager, FiberManagerLive } from "imposters/server/FiberManager.js"

const runtime = ManagedRuntime.make(FiberManagerLive)
afterAll(() => runtime.dispose())

const run = <A>(effect: Effect.Effect<A, unknown, FiberManager>) =>
  runtime.runPromise(effect)

describe("FiberManager", () => {
  it("start and isRunning", async () => {
    await run(
      Effect.gen(function*() {
        const fm = yield* FiberManager

        yield* fm.start("fiber1", Effect.gen(function*() {
          yield* Ref.make(0)
          return yield* Effect.never
        }))

        yield* Effect.sleep("50 millis")
        const running = yield* fm.isRunning("fiber1")
        expect(running).toBe(true)

        yield* fm.stop("fiber1")
      })
    )
  }, 10000)

  it("stop removes fiber", async () => {
    await run(
      Effect.gen(function*() {
        const fm = yield* FiberManager

        yield* fm.start("fiber2", Effect.never)
        yield* Effect.sleep("10 millis")
        yield* fm.stop("fiber2")
        yield* Effect.sleep("10 millis")
        const running = yield* fm.isRunning("fiber2")
        expect(running).toBe(false)
      })
    )
  }, 10000)

  it("isRunning returns false for unknown id", async () => {
    await run(
      Effect.gen(function*() {
        const fm = yield* FiberManager
        const running = yield* fm.isRunning("nonexistent")
        expect(running).toBe(false)
      })
    )
  }, 10000)

  it("start with same id replaces previous fiber", async () => {
    await run(
      Effect.gen(function*() {
        const fm = yield* FiberManager
        const ref = yield* Ref.make("first")

        yield* fm.start("fiber3", Effect.gen(function*() {
          yield* Ref.set(ref, "first-running")
          return yield* Effect.never
        }))
        yield* Effect.sleep("10 millis")

        yield* fm.start("fiber3", Effect.gen(function*() {
          yield* Ref.set(ref, "second-running")
          return yield* Effect.never
        }))
        yield* Effect.sleep("10 millis")

        const val = yield* Ref.get(ref)
        expect(val).toBe("second-running")

        yield* fm.stop("fiber3")
      })
    )
  }, 10000)
})
