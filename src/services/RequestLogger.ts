import type { Scope } from "effect"
import { Context, Effect, HashMap, Layer, Option, PubSub, Ref, Stream } from "effect"
import type { RequestLogEntry } from "../schemas/RequestLogSchema.js"

const MAX_ENTRIES = 100

// A logged request with its place in the log: `seq` increases with every entry logged, across
// all imposters and restarts, so a page can order rows that reach it out of order (an event
// still in flight when a re-fetch answered) and tell an old row from a new one
export interface LoggedEntry {
  readonly entry: RequestLogEntry
  readonly seq: number
}

export interface RequestLoggerShape {
  readonly log: (entry: RequestLogEntry) => Effect.Effect<void>
  readonly getEntries: (
    imposterId: string,
    opts?: { limit?: number; method?: string; path?: string; status?: number }
  ) => Effect.Effect<ReadonlyArray<RequestLogEntry>>
  // The latest `limit` entries with their sequence numbers, oldest first
  readonly getRecent: (imposterId: string, limit: number) => Effect.Effect<ReadonlyArray<LoggedEntry>>
  readonly getCount: (imposterId: string) => Effect.Effect<number>
  readonly clear: (imposterId: string) => Effect.Effect<void>
  // The imposter's entries as they are logged, from the moment this runs: it subscribes at once
  // (so nothing logged after it returns is missed, however late the stream is first pulled) and
  // unsubscribes when the scope closes. The pubsub slides, so a slow reader loses its oldest
  // entries rather than holding up the imposter. Entries logged concurrently can arrive out of
  // `seq` order.
  readonly follow: (imposterId: string) => Effect.Effect<Stream.Stream<LoggedEntry>, never, Scope.Scope>
  // How many `follow` subscriptions to the imposter are open
  readonly followers: (imposterId: string) => Effect.Effect<number>
  readonly getEntryById: (imposterId: string, entryId: string) => Effect.Effect<RequestLogEntry | null>
  readonly removeImposter: (imposterId: string) => Effect.Effect<void>
}

export class RequestLogger extends Context.Service<RequestLogger, RequestLoggerShape>()("RequestLogger") {}

interface Store {
  readonly entries: HashMap.HashMap<string, ReadonlyArray<LoggedEntry>>
  readonly nextSeq: number
}

export const RequestLoggerLive = Layer.effect(
  RequestLogger,
  Effect.gen(function*() {
    const storeRef = yield* Ref.make<Store>({ entries: HashMap.empty(), nextSeq: 1 })
    const pubsub = yield* PubSub.sliding<LoggedEntry>(256)
    const followersRef = yield* Ref.make(HashMap.empty<string, number>())

    const logged = (store: Store, imposterId: string): ReadonlyArray<LoggedEntry> =>
      Option.getOrElse(HashMap.get(store.entries, imposterId), () => [])

    const log = (entry: RequestLogEntry): Effect.Effect<void> =>
      Ref.modify(storeRef, (store): readonly [LoggedEntry, Store] => {
        const next: LoggedEntry = { entry, seq: store.nextSeq }
        const updated = [...logged(store, entry.imposterId), next].slice(-MAX_ENTRIES)
        return [next, { entries: HashMap.set(store.entries, entry.imposterId, updated), nextSeq: store.nextSeq + 1 }]
      }).pipe(Effect.flatMap((next) => PubSub.publish(pubsub, next)), Effect.asVoid)

    const getEntries = (
      imposterId: string,
      opts?: { limit?: number; method?: string; path?: string; status?: number }
    ): Effect.Effect<ReadonlyArray<RequestLogEntry>> =>
      Ref.get(storeRef).pipe(
        Effect.map((store) => {
          let entries = logged(store, imposterId).map((item) => item.entry)
          const method = opts?.method?.toUpperCase()
          if (method !== undefined) entries = entries.filter((e) => e.request.method.toUpperCase() === method)
          const path = opts?.path
          if (path !== undefined) entries = entries.filter((e) => e.request.path === path)
          const status = opts?.status
          if (status !== undefined) entries = entries.filter((e) => e.response.status === status)
          return entries.slice(-(opts?.limit ?? 50))
        })
      )

    const getRecent = (imposterId: string, limit: number): Effect.Effect<ReadonlyArray<LoggedEntry>> =>
      Ref.get(storeRef).pipe(Effect.map((store) => logged(store, imposterId).slice(-limit)))

    const getCount = (imposterId: string): Effect.Effect<number> =>
      Ref.get(storeRef).pipe(Effect.map((store) => logged(store, imposterId).length))

    const clear = (imposterId: string): Effect.Effect<void> =>
      Ref.update(storeRef, (store) => ({ ...store, entries: HashMap.set(store.entries, imposterId, []) }))

    const followers = (imposterId: string): Effect.Effect<number> =>
      Ref.get(followersRef).pipe(Effect.map((counts) => Option.getOrElse(HashMap.get(counts, imposterId), () => 0)))

    const countFollower = (imposterId: string, delta: number): Effect.Effect<void> =>
      Ref.update(followersRef, (counts) => {
        const next = Option.getOrElse(HashMap.get(counts, imposterId), () => 0) + delta
        return next > 0 ? HashMap.set(counts, imposterId, next) : HashMap.remove(counts, imposterId)
      })

    const follow = (imposterId: string): Effect.Effect<Stream.Stream<LoggedEntry>, never, Scope.Scope> =>
      Effect.gen(function*() {
        yield* Effect.acquireRelease(countFollower(imposterId, 1), () => countFollower(imposterId, -1))
        const subscription = yield* PubSub.subscribe(pubsub)
        return Stream.fromSubscription(subscription).pipe(
          Stream.filter((item) => item.entry.imposterId === imposterId)
        )
      })

    const getEntryById = (imposterId: string, entryId: string): Effect.Effect<RequestLogEntry | null> =>
      Ref.get(storeRef).pipe(
        Effect.map((store) => logged(store, imposterId).find((item) => item.entry.id === entryId)?.entry ?? null)
      )

    const removeImposter = (imposterId: string): Effect.Effect<void> =>
      Ref.update(storeRef, (store) => ({ ...store, entries: HashMap.remove(store.entries, imposterId) }))

    return {
      log,
      getEntries,
      getRecent,
      getCount,
      clear,
      follow,
      followers,
      getEntryById,
      removeImposter
    } satisfies RequestLoggerShape
  })
)
