import * as Schema from "effect/Schema"
import { NonEmptyString } from "./common.js"

export const RequestLogEntry = Schema.Struct({
  id: NonEmptyString,
  imposterId: NonEmptyString,
  timestamp: Schema.DateTimeUtc,
  request: Schema.Struct({
    method: Schema.String,
    path: Schema.String,
    headers: Schema.Record({ key: Schema.String, value: Schema.String }),
    query: Schema.Record({ key: Schema.String, value: Schema.String }),
    body: Schema.optional(Schema.Unknown)
  }),
  response: Schema.Struct({
    status: Schema.Number,
    headers: Schema.optionalWith(
      Schema.Record({ key: Schema.String, value: Schema.String }),
      { default: () => ({}) }
    ),
    body: Schema.optional(Schema.String),
    matchedStubId: Schema.optional(NonEmptyString),
    proxied: Schema.optionalWith(Schema.Boolean, { default: () => false })
  }),
  duration: Schema.Number
})
export type RequestLogEntry = Schema.Schema.Type<typeof RequestLogEntry>

export const ListRequestsUrlParams = Schema.Struct({
  limit: Schema.optionalWith(
    Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
    { default: () => 50 }
  ),
  method: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  status: Schema.optional(Schema.NumberFromString)
})
export type ListRequestsUrlParams = Schema.Schema.Type<typeof ListRequestsUrlParams>
