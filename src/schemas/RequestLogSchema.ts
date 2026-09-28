import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { NonEmptyString } from "./common"

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
    proxied: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)))
  }),
  duration: Schema.Number
})
export type RequestLogEntry = Schema.Schema.Type<typeof RequestLogEntry>

export const ListRequestsUrlParams = Schema.Struct({
  limit: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.withDecodingDefault(Effect.succeed(50))),
  method: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number)
})
export type ListRequestsUrlParams = Schema.Schema.Type<typeof ListRequestsUrlParams>
