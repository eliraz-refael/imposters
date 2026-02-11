import { Context, Data, Effect, HashSet, Layer, Ref } from "effect"
import { AppConfig } from "./AppConfig.js"

export class PortAllocatorError extends Data.TaggedError("PortAllocatorError")<{
  readonly reason: string
  readonly port?: number
}> {}

export class PortExhaustedError extends Data.TaggedError("PortExhaustedError")<{
  readonly rangeMin: number
  readonly rangeMax: number
}> {}

export interface PortAllocatorShape {
  readonly allocate: (preferred?: number) => Effect.Effect<number, PortAllocatorError | PortExhaustedError>
  readonly release: (port: number) => Effect.Effect<void>
  readonly isAvailable: (port: number) => Effect.Effect<boolean>
}

export class PortAllocator extends Context.Tag("PortAllocator")<PortAllocator, PortAllocatorShape>() {}

export const PortAllocatorLive = Layer.effect(
  PortAllocator,
  Effect.gen(function*() {
    const config = yield* AppConfig
    const portsRef = yield* Ref.make(HashSet.empty<number>())

    type AllocateResult = readonly [Effect.Effect<number, PortAllocatorError | PortExhaustedError>, HashSet.HashSet<number>]

    const allocate = (preferred?: number): Effect.Effect<number, PortAllocatorError | PortExhaustedError> => {
      if (preferred !== undefined) {
        return Ref.modify(portsRef, (ports): AllocateResult => {
          if (HashSet.has(ports, preferred)) {
            return [Effect.fail(new PortAllocatorError({ reason: `Port ${preferred} is already allocated`, port: preferred })), ports]
          }
          return [Effect.succeed(preferred), HashSet.add(ports, preferred)]
        }).pipe(Effect.flatten)
      }

      return Ref.modify(portsRef, (ports): AllocateResult => {
        for (let port = config.portRangeMin; port <= config.portRangeMax; port++) {
          if (!HashSet.has(ports, port)) {
            return [Effect.succeed(port), HashSet.add(ports, port)]
          }
        }
        return [Effect.fail(new PortExhaustedError({ rangeMin: config.portRangeMin, rangeMax: config.portRangeMax })), ports]
      }).pipe(Effect.flatten)
    }

    const release = (port: number): Effect.Effect<void> =>
      Ref.update(portsRef, HashSet.remove(port))

    const isAvailable = (port: number): Effect.Effect<boolean> =>
      Ref.get(portsRef).pipe(Effect.map((ports) => !HashSet.has(ports, port)))

    return { allocate, release, isAvailable }
  })
)
