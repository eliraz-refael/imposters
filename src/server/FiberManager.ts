import { Context, Effect, FiberMap, Layer } from "effect"

export interface FiberManagerShape {
  readonly start: (id: string, effect: Effect.Effect<never, unknown>) => Effect.Effect<void>
  readonly stop: (id: string) => Effect.Effect<void>
  readonly isRunning: (id: string) => Effect.Effect<boolean>
}

export class FiberManager extends Context.Tag("FiberManager")<FiberManager, FiberManagerShape>() {}

export const FiberManagerLive = Layer.scoped(
  FiberManager,
  Effect.gen(function*() {
    const fiberMap = yield* FiberMap.make<string>()

    const start = (id: string, effect: Effect.Effect<never, unknown>): Effect.Effect<void> =>
      FiberMap.run(fiberMap, id, effect)

    const stop = (id: string): Effect.Effect<void> =>
      FiberMap.remove(fiberMap, id)

    const isRunning = (id: string): Effect.Effect<boolean> =>
      FiberMap.has(fiberMap, id)

    return { start, stop, isRunning }
  })
)
