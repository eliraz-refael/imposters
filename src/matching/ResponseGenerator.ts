import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Ref from "effect/Ref"
import type { ResponseConfig, ResponseMode } from "../schemas/StubSchema.js"
import type { RequestContext } from "./RequestMatcher.js"
import { applyTemplates } from "./TemplateEngine.js"

type CounterMap = HashMap.HashMap<string, number>
type CounterResult = readonly [Effect.Effect<number, never>, CounterMap]

export const makeResponseState = () =>
  Effect.gen(function*() {
    const countersRef = yield* Ref.make<CounterMap>(HashMap.empty())

    const getNextIndex = (imposterId: string, stubId: string, count: number, mode: ResponseMode): Effect.Effect<number> => {
      const key = `${imposterId}:${stubId}`
      return Ref.modify(countersRef, (counters): CounterResult => {
        const current = HashMap.get(counters, key)
        const index = current._tag === "Some" ? current.value : 0
        let result: number
        switch (mode) {
          case "sequential":
            result = index % count
            break
          case "random":
            result = Math.floor(Math.random() * count)
            break
          case "repeat":
            result = Math.min(index, count - 1)
            break
        }
        const nextIndex = mode === "random" ? index : index + 1
        return [Effect.succeed(result), HashMap.set(counters, key, nextIndex)]
      }).pipe(Effect.flatten)
    }

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

    return { getNextIndex, reset }
  })

export const buildResponse = (config: ResponseConfig, ctx: RequestContext): Response => {
  const headers = new Headers()
  const responseHeaders = config.headers
  if (responseHeaders !== undefined) {
    for (const [key, val] of Object.entries(responseHeaders)) {
      const templated = applyTemplates(ctx, val)
      headers.set(key, typeof templated === "string" ? templated : String(templated))
    }
  }

  let bodyStr: string | null = null
  if (config.body !== undefined) {
    const templated = applyTemplates(ctx, config.body)
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

  return new Response(bodyStr, {
    status: config.status,
    headers
  })
}
