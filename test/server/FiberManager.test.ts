import * as Effect from "effect/Effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Ref from "effect/Ref"
import { FiberManager, FiberManagerLive } from "imposters/server/FiberManager"
import { afterAll, describe, expect, it } from "vitest"

const runtime = ManagedRuntime.make(FiberManagerLive)
afterAll(() => runtime.dispose())

const run = <A>(effect: Effect.Effect<A, unknown, FiberManager>) => runtime.runPromise(effect)

describe("FiberManager", () => {
  it("start and isRunning", async () => {
    await run(
      Effect.gen(function*() {
        const fm = yield* FiberManager

        yield* fm.start(
          "fiber1",
          Effect.gen(function*() {
            yield* Ref.make(0)
            return yield* Effect.never
          })
        )

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
        yield* fm.stop("fiber2")
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

        yield* fm.start(
          "fiber3",
          Effect.gen(function*() {
            yield* Ref.set(ref, "first-running")
            return yield* Effect.never
          })
        )

        yield* fm.start(
          "fiber3",
          Effect.gen(function*() {
            yield* Ref.set(ref, "second-running")
            return yield* Effect.never
          })
        )

        const val = yield* Ref.get(ref)
        expect(val).toBe("second-running")

        yield* fm.stop("fiber3")
      })
    )
  }, 10000)

  // A finalizer that takes a while, like a server releasing its port
  const slowFinalizer = (log: Ref.Ref<ReadonlyArray<string>>, name: string) =>
    Effect.acquireRelease(
      Ref.update(log, (l) => [...l, `${name}:acquired`]),
      () =>
        Effect.sleep("50 millis").pipe(
          Effect.andThen(Ref.update(log, (l) => [...l, `${name}:released`]))
        )
    ).pipe(Effect.andThen(Effect.never), Effect.scoped)

  it("stop completes only after the fiber's finalizers have run", async () => {
    await run(
      Effect.gen(function*() {
        const fm = yield* FiberManager
        const log = yield* Ref.make<ReadonlyArray<string>>([])

        yield* fm.start("fiber4", slowFinalizer(log, "a"))
        yield* fm.stop("fiber4")

        expect(yield* Ref.get(log)).toEqual(["a:acquired", "a:released"])
        expect(yield* fm.isRunning("fiber4")).toBe(false)
      })
    )
  }, 10000)

  it("start with the same id waits for the previous fiber's finalizers before forking", async () => {
    await run(
      Effect.gen(function*() {
        const fm = yield* FiberManager
        const log = yield* Ref.make<ReadonlyArray<string>>([])

        yield* fm.start("fiber5", slowFinalizer(log, "a"))
        yield* fm.start("fiber5", slowFinalizer(log, "b"))

        // FiberMap.run alone would fork "b" before "a" had released
        expect(yield* Ref.get(log)).toEqual(["a:acquired", "a:released", "b:acquired"])

        yield* fm.stop("fiber5")
      })
    )
  }, 10000)
})
