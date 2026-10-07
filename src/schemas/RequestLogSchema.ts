import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { NonEmptyString, NonNegativeInt } from "./common.js"

// What answered a request: a stub, the imposter's extension, its proxy, or nothing (the 404)
export const RequestOutcome = Schema.Literals(["stub", "extension", "proxy", "unmatched"])
export type RequestOutcome = Schema.Schema.Type<typeof RequestOutcome>

// Which phase a callback ran in: before the response was built, or after it was ready
export const CallbackPhase = Schema.Literals(["before", "after"])
export type CallbackPhase = Schema.Schema.Type<typeof CallbackPhase>

// pending: an `after` call not settled yet; answered: a response came back (any status);
// failed: none did (timeout, connection, invalid url, too many in flight); skipped: never sent
export const CallbackState = Schema.Literals(["pending", "answered", "failed", "skipped"])
export type CallbackState = Schema.Schema.Type<typeof CallbackState>

// One callback a response made, as the request log keeps it. Bodies are the first 2 KiB as
// text; no headers are kept.
export const CallbackRecord = Schema.Struct({
  name: Schema.String,
  phase: CallbackPhase,
  method: Schema.String,
  // After templating, or the template itself when templating failed
  url: Schema.String,
  state: CallbackState,
  status: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
  requestBody: Schema.optional(Schema.String),
  responseBody: Schema.optional(Schema.String)
})
export type CallbackRecord = Schema.Schema.Type<typeof CallbackRecord>

export const RequestLogEntry = Schema.Struct({
  id: NonEmptyString,
  imposterId: NonEmptyString,
  timestamp: Schema.DateTimeUtc,
  request: Schema.Struct({
    method: Schema.String,
    path: Schema.String,
    headers: Schema.Record(Schema.String, Schema.String),
    query: Schema.Record(Schema.String, Schema.String),
    body: Schema.optional(Schema.Unknown)
  }),
  response: Schema.Struct({
    status: Schema.Number,
    headers: Schema.Record(Schema.String, Schema.String).pipe(Schema.withDecodingDefault(Effect.sync(() => ({})))),
    body: Schema.optional(Schema.String),
    matchedStubId: Schema.optional(NonEmptyString),
    proxied: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    outcome: RequestOutcome,
    // Which of the matched stub's responses answered (only when `outcome` is "stub")
    responseIndex: Schema.optional(NonNegativeInt)
  }),
  duration: Schema.Number,
  // The response's callbacks, in order (`before`, then `after`); absent when it made none
  callbacks: Schema.optional(Schema.Array(CallbackRecord))
})
export type RequestLogEntry = Schema.Schema.Type<typeof RequestLogEntry>

export const ListRequestsUrlParams = Schema.Struct({
  limit: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.withDecodingDefault(Effect.succeed(50))),
  method: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number)
})
export type ListRequestsUrlParams = Schema.Schema.Type<typeof ListRequestsUrlParams>
