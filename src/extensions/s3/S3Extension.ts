/**
 * An in-memory S3 emulator, served as the "S3" imposter protocol.
 *
 * Path-style requests only (`/<bucket>/<key>`); SigV4 signatures are not checked.
 * `x-amz-expected-bucket-owner` is: it must equal the requester's access key id. The store lives in the instance `make`
 * builds, so every bucket and object is gone after the imposter stops or restarts: it is
 * a test double, never a source of truth.
 *
 * Stubs are matched before the extension, so a stub can inject faults (a 503 SlowDown for
 * one key, a delayed answer to trip a client timeout) while everything else reaches S3.
 */
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Random from "effect/Random"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import type { RequestContext } from "../../matching/RequestMatcher"
import type { ImposterExtension } from "../Extension"
import { apply, emptyStore, type S3Reply, type Store } from "./Kernel"
import { parseOperation } from "./Operation"
import { render } from "./Render"
import type { S3Error } from "./S3Error"

// 16 upper-case hex digits, the shape of a real x-amz-request-id
const nextRequestId: Effect.Effect<string> = Effect.map(
  Effect.all([Random.nextIntBetween(0, 0xffffffff), Random.nextIntBetween(0, 0xffffffff)]),
  (parts) => parts.map((n) => n.toString(16).padStart(8, "0")).join("").toUpperCase()
)

/** Answers one request against `store`: parse, apply atomically, render */
export const handleS3 = (store: Ref.Ref<Store>, ctx: RequestContext): Effect.Effect<Response> =>
  Effect.gen(function*() {
    const requestId = yield* nextRequestId
    const now = yield* DateTime.now
    const result = yield* Result.match(parseOperation(ctx), {
      onFailure: (error) => Effect.succeed<Result.Result<S3Reply, S3Error>>(Result.fail(error)),
      onSuccess: (op) => Ref.modify(store, (current) => apply(current, op, now))
    })
    return render(result, { requestId, head: ctx.method === "HEAD" })
  })

export const S3Extension: ImposterExtension = {
  protocol: "S3",
  make: () =>
    Effect.map(Ref.make(emptyStore), (store) => ({
      handle: (ctx: RequestContext) => handleS3(store, ctx)
    }))
}
