import { Context, Effect, type Fiber, FiberMap, Layer, Semaphore } from "effect"

export interface FiberManagerShape {
  // Forks `effect` under `id`. Any fiber already running under `id` is interrupted
  // and awaited (finalizers included) before the new one is forked.
  readonly start: <E>(id: string, effect: Effect.Effect<never, E>) => Effect.Effect<Fiber.Fiber<never, E>>
  // Interrupts the fiber under `id` and completes once its finalizers have run.
  readonly stop: (id: string) => Effect.Effect<void>
  readonly isRunning: (id: string) => Effect.Effect<boolean>
}

export class FiberManager extends Context.Service<FiberManager, FiberManagerShape>()("FiberManager") {}

export const FiberManagerLive = Layer.effect(
  FiberManager,
  Effect.gen(function*() {
    const fiberMap = yield* FiberMap.make<string>()
    // Serialises start/stop so a concurrent start cannot re-key a fiber without
    // awaiting it. Only the interrupt-and-fork step is held, never the lifetime
    // of a fiber, so this does not serialise the imposters themselves.
    const lock = yield* Semaphore.make(1)

    // FiberMap.run re-keying interrupts the previous fiber *without* awaiting it
    // (setUnsafe calls interruptUnsafe), so the old server could still hold the
    // port while the new one binds. FiberMap.remove does await (Fiber.interruptAs
    // waits for the fiber to exit), so remove first, then run.
    const start = <E>(id: string, effect: Effect.Effect<never, E>): Effect.Effect<Fiber.Fiber<never, E>> =>
      lock.withPermit(
        FiberMap.remove(fiberMap, id).pipe(
          Effect.andThen(FiberMap.run(fiberMap, id, effect))
        )
      )

    const stop = (id: string): Effect.Effect<void> => lock.withPermit(FiberMap.remove(fiberMap, id))

    const isRunning = (id: string): Effect.Effect<boolean> => FiberMap.has(fiberMap, id)

    return { start, stop, isRunning }
  })
)
