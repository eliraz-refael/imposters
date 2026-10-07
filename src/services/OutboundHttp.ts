import { Clock, Context, Data, Duration, Effect, Layer } from "effect"
import * as Result from "effect/Result"
import { HOP_HEADER } from "../matching/Hops.js"
import { MaxHops } from "../server/MaxHops.js"
import { MetricsService } from "./MetricsService.js"
import type { OutboundSample, OutboundVia } from "./OutboundEdges.js"

// Every request an imposter sends out (its callbacks and its proxy forwards) goes through here:
// the hop header, the hop limit, the timeout and the outbound edge in the stats are the same
// for both. `exchange` is the only part that touches the network, so a test can replace it.

export class OutboundError extends Data.TaggedError("OutboundError")<{
  // timeout: no answer in time; connection: fetch failed; read: the answer could not be read as asked
  readonly kind: "timeout" | "connection" | "read"
  readonly reason: string
  readonly cause?: unknown
}> {}

// A call refused because the request that wanted it arrived at the hop limit
export class HopLimitError extends Data.TaggedError("HopLimitError")<{
  // The hop the request arrived with
  readonly hop: number
  readonly limit: number
}> {}

export interface OutboundRequest {
  readonly url: URL
  readonly method: string
  readonly headers: Headers
  readonly body?: string | Uint8Array<ArrayBuffer>
  // The hop to send: the incoming hop plus one
  readonly hop: number
  readonly redirect?: "follow" | "manual"
}

// Reads the answer while the request is still live (an interruption aborts both); a failure
// is a reason, such as a body over the size limit
export type ReadAnswer<A> = (response: Response) => Promise<Result.Result<A, string>>

export interface OutboundHttpShape {
  readonly maxHops: number
  // One exchange, with no timeout and no recording (see `callOut`). Interrupting it aborts the request.
  readonly exchange: <A>(request: OutboundRequest, read: ReadAnswer<A>) => Effect.Effect<A, OutboundError>
  // Counts one call into the imposter's outbound edge for its host
  readonly record: (imposterId: string, sample: OutboundSample) => Effect.Effect<void>
}

export class OutboundHttp extends Context.Service<OutboundHttp, OutboundHttpShape>()("OutboundHttp") {}

// What fetch's error says went wrong: undici puts the system error (ECONNREFUSED…) in `cause`
export const describeFetchError = (err: unknown): string => {
  if (err instanceof Error) {
    if (err.cause instanceof Error && err.cause.message !== "") return err.cause.message
    return err.message
  }
  return String(err)
}

export const OutboundHttpLive = Layer.effect(
  OutboundHttp,
  Effect.gen(function*() {
    const metrics = yield* MetricsService
    const maxHops = yield* MaxHops

    const exchange = <A>(request: OutboundRequest, read: ReadAnswer<A>): Effect.Effect<A, OutboundError> =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            ...(request.body !== undefined ? { body: request.body } : {}),
            redirect: request.redirect ?? "follow",
            signal
          })
          return read(response)
        },
        catch: (err) =>
          new OutboundError({ kind: "connection", reason: `connection failed: ${describeFetchError(err)}`, cause: err })
      }).pipe(
        Effect.flatMap(Result.match({
          onFailure: (reason) => Effect.fail(new OutboundError({ kind: "read", reason })),
          onSuccess: (value) => Effect.succeed(value)
        }))
      )

    const record = (imposterId: string, sample: OutboundSample): Effect.Effect<void> =>
      metrics.recordOutbound(imposterId, sample)

    return { maxHops, exchange, record } satisfies OutboundHttpShape
  })
)

// Records an outbound sample only while it holds: a call still in flight from a stopped run
// must not land in the next run's edges (ImposterServer passes its isCurrentRun)
export const alwaysCurrent: Effect.Effect<boolean> = Effect.succeed(true)

export interface CallOutOptions<A> {
  readonly imposterId: string
  // Whether the run that made the call is still current when it ends (default: always)
  readonly isCurrent?: Effect.Effect<boolean>
  readonly via: OutboundVia
  readonly request: OutboundRequest
  readonly timeoutMs: number
  readonly read: ReadAnswer<A>
  // The status of what `read` gave, for the edge's counters
  readonly statusOf: (answer: A) => number
}

// One outbound call: refused past the hop limit, sent with `x-imposters-hop`, given up on after
// `timeoutMs` (on the Clock), and counted into the imposter's outbound edge however it ends
// (unless it is interrupted, or its run is no longer current).
export const callOut = <A>(options: CallOutOptions<A>): Effect.Effect<A, OutboundError | HopLimitError, OutboundHttp> =>
  Effect.gen(function*() {
    const outbound = yield* OutboundHttp
    const { imposterId, request, timeoutMs, via } = options
    const atMs = yield* Clock.currentTimeMillis
    const host = request.url.host.toLowerCase()
    const record = (status: number | undefined) =>
      Effect.all([options.isCurrent ?? alwaysCurrent, Clock.currentTimeMillis]).pipe(
        Effect.flatMap(([current, end]) =>
          current
            ? outbound.record(imposterId, {
              host,
              via,
              atMs,
              durationMs: end - atMs,
              ...(status !== undefined ? { status } : {})
            })
            : Effect.void
        )
      )
    if (request.hop > outbound.maxHops) {
      yield* record(undefined)
      return yield* Effect.fail(new HopLimitError({ hop: request.hop - 1, limit: outbound.maxHops }))
    }
    const headers = new Headers(request.headers)
    headers.set(HOP_HEADER, String(request.hop))
    return yield* outbound.exchange({ ...request, headers }, options.read).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () => Effect.fail(new OutboundError({ kind: "timeout", reason: `timed out after ${timeoutMs} ms` }))
      }),
      Effect.tap((answer) => record(options.statusOf(answer))),
      Effect.tapError(() => record(undefined))
    )
  })
