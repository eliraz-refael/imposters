import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Random from "effect/Random"
import * as Ref from "effect/Ref"
import type { Delay, ResponseConfig, ResponseMode } from "../schemas/StubSchema.js"
import type { RequestContext } from "./RequestMatcher.js"
import { applyTemplates } from "./TemplateEngine.js"

type CounterMap = HashMap.HashMap<string, number>
type CounterResult = readonly [Effect.Effect<number, never>, CounterMap]

// `counter` is how many times the stub has answered in sequential/repeat mode
const indexFor = (counter: number, count: number, mode: "sequential" | "repeat"): number =>
  mode === "sequential" ? counter % count : Math.min(counter, count - 1)

/** The response the next request will get, or None when `mode` is random (it cannot be known) */
export const peekIndex = (counter: number, count: number, mode: ResponseMode): Option.Option<number> =>
  mode === "random" || count <= 0 ? Option.none() : Option.some(indexFor(counter, count, mode))

const counterKey = (imposterId: string, stubId: string) => `${imposterId}:${stubId}`

export const makeResponseState = () =>
  Effect.gen(function*() {
    const countersRef = yield* Ref.make<CounterMap>(HashMap.empty())

    const getNextIndex = (
      imposterId: string,
      stubId: string,
      count: number,
      mode: ResponseMode
    ): Effect.Effect<number> => {
      const key = counterKey(imposterId, stubId)
      return Ref.modify(countersRef, (counters): CounterResult => {
        const current = HashMap.get(counters, key)
        const index = current._tag === "Some" ? current.value : 0
        if (mode === "random") {
          return [Random.nextIntBetween(0, count - 1), counters]
        }
        return [Effect.succeed(indexFor(index, count, mode)), HashMap.set(counters, key, index + 1)]
      }).pipe(Effect.flatten)
    }

    /** What `getNextIndex` would answer next, without consuming it; None for random */
    const peekNextIndex = (
      imposterId: string,
      stubId: string,
      count: number,
      mode: ResponseMode
    ): Effect.Effect<Option.Option<number>> =>
      Ref.get(countersRef).pipe(
        Effect.map((counters) =>
          peekIndex(Option.getOrElse(HashMap.get(counters, counterKey(imposterId, stubId)), () => 0), count, mode)
        )
      )

    /** Restarts one stub's cycle at its first response */
    const resetStub = (imposterId: string, stubId: string): Effect.Effect<void> =>
      Ref.update(countersRef, HashMap.remove(counterKey(imposterId, stubId)))

    const reset = (imposterId: string): Effect.Effect<void> =>
      Ref.update(countersRef, (counters) => {
        let updated = counters
        for (const key of HashMap.keys(counters)) {
          if (key.startsWith(`${imposterId}:`)) {
            updated = HashMap.remove(updated, key)
          }
        }
        return updated
      })

    return { getNextIndex, peekNextIndex, resetStub, reset }
  })

export type ResponseState = Effect.Success<ReturnType<typeof makeResponseState>>

// The Fetch spec forbids a body on these statuses: `new Response("", { status: 204 })` throws
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304])

export const isNullBodyStatus = (status: number): boolean => NULL_BODY_STATUSES.has(status)

export const buildResponse = async (config: ResponseConfig, ctx: RequestContext): Promise<Response> => {
  const headers = new Headers()
  const responseHeaders = config.headers
  if (responseHeaders !== undefined) {
    for (const [key, val] of Object.entries(responseHeaders)) {
      const templated = await applyTemplates(ctx, val)
      headers.set(key, typeof templated === "string" ? templated : String(templated))
    }
  }

  let bodyStr: string | null = null
  if (config.body !== undefined) {
    const templated = await applyTemplates(ctx, config.body)
    if (typeof templated === "string") {
      bodyStr = templated
      if (!headers.has("content-type")) {
        headers.set("content-type", "text/plain")
      }
    } else {
      bodyStr = JSON.stringify(templated)
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json")
      }
    }
  }

  return new Response(isNullBodyStatus(config.status) ? null : bodyStr, {
    status: config.status,
    headers
  })
}

// The milliseconds to wait before answering: none, the fixed delay, or a whole number drawn
// uniformly from the range's [min, max] (both inclusive) through `Random`, afresh on every call.
// (A line comment: the index codegen would take a multi-line doc comment as this module's.)
export const resolveDelay = (delay: Delay | undefined): Effect.Effect<number> => {
  if (delay === undefined) return Effect.succeed(0)
  if (typeof delay === "number") return Effect.succeed(delay)
  return delay.min === delay.max ? Effect.succeed(delay.min) : Random.nextIntBetween(delay.min, delay.max)
}

/** Waits out the response's delay on the `Clock`, then builds it: what a stub answers when it matches */
export const serveResponse = (config: ResponseConfig, ctx: RequestContext): Effect.Effect<Response> =>
  resolveDelay(config.delay).pipe(
    Effect.flatMap((ms) => ms > 0 ? Effect.sleep(Duration.millis(ms)) : Effect.void),
    Effect.flatMap(() => Effect.promise(() => buildResponse(config, ctx)))
  )
