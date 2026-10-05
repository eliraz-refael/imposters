import type { Scope } from "effect"
import { Context, Effect, HashMap, Layer, Option, PubSub, Ref, Stream } from "effect"
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
  readonly subscribe: Effect.Effect<PubSub.Subscription<RequestLogEntry>, never, Scope.Scope>
  // The imposter's entries as they are logged, from the moment this runs: it subscribes at once
  // (so nothing logged after it returns is missed, however late the stream is first pulled) and
  // unsubscribes when the scope closes. The pubsub slides, so a slow reader loses its oldest
  // entries rather than holding up the imposter.
  readonly follow: (imposterId: string) => Effect.Effect<Stream.Stream<RequestLogEntry>, never, Scope.Scope>
  // How many `follow` subscriptions to the imposter are open
  readonly followers: (imposterId: string) => Effect.Effect<number>
  readonly getEntryById: (imposterId: string, entryId: string) => Effect.Effect<RequestLogEntry | null>
  readonly removeImposter: (imposterId: string) => Effect.Effect<void>
}

export class RequestLogger extends Context.Service<RequestLogger, RequestLoggerShape>()("RequestLogger") {}

export const RequestLoggerLive = Layer.effect(
  RequestLogger,
  Effect.gen(function*() {
    const storeRef = yield* Ref.make(HashMap.empty<string, Array<RequestLogEntry>>())
    const pubsub = yield* PubSub.sliding<RequestLogEntry>(256)
    const followersRef = yield* Ref.make(HashMap.empty<string, number>())

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

    const subscribe: Effect.Effect<PubSub.Subscription<RequestLogEntry>, never, Scope.Scope> = PubSub.subscribe(pubsub)

    const followers = (imposterId: string): Effect.Effect<number> =>
      Ref.get(followersRef).pipe(Effect.map((counts) => Option.getOrElse(HashMap.get(counts, imposterId), () => 0)))

    const countFollower = (imposterId: string, delta: number): Effect.Effect<void> =>
      Ref.update(followersRef, (counts) => {
        const next = Option.getOrElse(HashMap.get(counts, imposterId), () => 0) + delta
        return next > 0 ? HashMap.set(counts, imposterId, next) : HashMap.remove(counts, imposterId)
      })

    const follow = (imposterId: string): Effect.Effect<Stream.Stream<RequestLogEntry>, never, Scope.Scope> =>
      Effect.gen(function*() {
        yield* Effect.acquireRelease(countFollower(imposterId, 1), () => countFollower(imposterId, -1))
        const subscription = yield* PubSub.subscribe(pubsub)
        return Stream.fromSubscription(subscription).pipe(Stream.filter((entry) => entry.imposterId === imposterId))
      })

    const getEntryById = (imposterId: string, entryId: string): Effect.Effect<RequestLogEntry | null> =>
      Ref.get(storeRef).pipe(
        Effect.map((store) => {
          const existing = HashMap.get(store, imposterId)
          if (existing._tag === "None") return null
          return existing.value.find((e) => e.id === entryId) ?? null
        })
      )

    const removeImposter = (imposterId: string): Effect.Effect<void> => Ref.update(storeRef, HashMap.remove(imposterId))

    return {
      log,
      getEntries,
      getCount,
      clear,
      subscribe,
      follow,
      followers,
      getEntryById,
      removeImposter
    } satisfies RequestLoggerShape
  })
)
