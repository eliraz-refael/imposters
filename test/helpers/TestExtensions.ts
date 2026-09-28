import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import type { ImposterExtension } from "imposters/extensions/Extension"

// Test-only extensions: the core must work with extensions it has never heard of.

// Echoes the request bytes back, numbering each answer from a per-instance counter.
// The counter lives in the instance `make` builds, so it restarts at 1 on every start.
export const EchoExtension: ImposterExtension = {
  protocol: "ECHO",
  make: ({ id }) =>
    Effect.gen(function*() {
      const answered = yield* Ref.make(0)
      return {
        handle: (ctx) =>
          Ref.updateAndGet(answered, (n) => n + 1).pipe(
            Effect.map((n) =>
              new Response(ctx.rawBody, {
                status: 200,
                headers: {
                  "content-type": ctx.headers["content-type"] ?? "application/octet-stream",
                  "x-echo-count": String(n),
                  "x-echo-imposter": id,
                  "x-echo-route": `${ctx.method} ${ctx.path}`
                }
              })
            )
          )
      }
    })
}

// An extension with a bug: every request is a defect, which the core must turn into a 500
export const BoomExtension: ImposterExtension = {
  protocol: "BOOM",
  make: () => Effect.succeed({ handle: () => Effect.die(new Error("boom")) })
}
