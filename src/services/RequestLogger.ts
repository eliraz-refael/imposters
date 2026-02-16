import type { Queue, Scope } from "effect"
import { Context, Effect, HashMap, Layer, PubSub, Ref } from "effect"
import type { RequestLogEntry } from "../schemas/RequestLogSchema.js"

const MAX_ENTRIES = 100

export interface RequestLoggerShape {
  readonly log: (entry: RequestLogEntry) => Effect.Effect<void>
  readonly getEntries: (
    imposterId: string,
    opts?: { limit?: number; method?: string; path?: string; status?: number }
  ) => Effect.Effect<ReadonlyArray<RequestLogEntry>>
  readonly getCount: (imposterId: string) => Effect.Effect<number>
  readonly clear: (imposterId: string) => Effect.Effect<void>
  readonly subscribe: Effect.Effect<Queue.Dequeue<RequestLogEntry>, never, Scope.Scope>
  readonly getEntryById: (imposterId: string, entryId: string) => Effect.Effect<RequestLogEntry | null>
  readonly removeImposter: (imposterId: string) => Effect.Effect<void>
}

export class RequestLogger extends Context.Tag("RequestLogger")<RequestLogger, RequestLoggerShape>() {}

export const RequestLoggerLive = Layer.scoped(
  RequestLogger,
  Effect.gen(function*() {
    const storeRef = yield* Ref.make(HashMap.empty<string, Array<RequestLogEntry>>())
    const pubsub = yield* PubSub.sliding<RequestLogEntry>(256)

    const log = (entry: RequestLogEntry): Effect.Effect<void> =>
      Effect.gen(function*() {
        yield* Ref.update(storeRef, (store) => {
          const existing = HashMap.get(store, entry.imposterId)
          const entries = existing._tag === "Some" ? existing.value : []
          const updated = [...entries, entry].slice(-MAX_ENTRIES)
          return HashMap.set(store, entry.imposterId, updated)
        })
        yield* PubSub.publish(pubsub, entry)
      })

    const getEntries = (
      imposterId: string,
      opts?: { limit?: number; method?: string; path?: string; status?: number }
    ): Effect.Effect<ReadonlyArray<RequestLogEntry>> =>
      Ref.get(storeRef).pipe(
        Effect.map((store) => {
          const existing = HashMap.get(store, imposterId)
          let entries = existing._tag === "Some" ? existing.value : []
          if (opts?.method !== undefined) {
            entries = entries.filter((e) => e.request.method.toUpperCase() === opts.method!.toUpperCase())
          }
          if (opts?.path !== undefined) {
            entries = entries.filter((e) => e.request.path === opts.path)
          }
          if (opts?.status !== undefined) {
            entries = entries.filter((e) => e.response.status === opts.status)
          }
          const limit = opts?.limit ?? 50
          return entries.slice(-limit)
        })
      )

    const getCount = (imposterId: string): Effect.Effect<number> =>
      Ref.get(storeRef).pipe(
        Effect.map((store) => {
          const existing = HashMap.get(store, imposterId)
          return existing._tag === "Some" ? existing.value.length : 0
        })
      )

    const clear = (imposterId: string): Effect.Effect<void> =>
      Ref.update(storeRef, (store) => HashMap.set(store, imposterId, []))

    const subscribe: Effect.Effect<Queue.Dequeue<RequestLogEntry>, never, Scope.Scope> = PubSub.subscribe(pubsub)

    const getEntryById = (imposterId: string, entryId: string): Effect.Effect<RequestLogEntry | null> =>
      Ref.get(storeRef).pipe(
        Effect.map((store) => {
          const existing = HashMap.get(store, imposterId)
          if (existing._tag === "None") return null
          return existing.value.find((e) => e.id === entryId) ?? null
        })
      )

    const removeImposter = (imposterId: string): Effect.Effect<void> => Ref.update(storeRef, HashMap.remove(imposterId))

    return { log, getEntries, getCount, clear, subscribe, getEntryById, removeImposter } satisfies RequestLoggerShape
  })
)
