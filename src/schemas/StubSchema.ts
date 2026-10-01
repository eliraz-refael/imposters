import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { NonEmptyString } from "./common.js"

// Proxy Mode
export const ProxyMode = Schema.Literals(["passthrough", "record"])
export type ProxyMode = Schema.Schema.Type<typeof ProxyMode>

// Proxy Configuration
export const ProxyConfig = Schema.Struct({
  targetUrl: Schema.String.check(Schema.isPattern(/^https?:\/\//)),
  mode: ProxyMode.pipe(Schema.withDecodingDefault(Effect.succeed("passthrough" as const))),
  addHeaders: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  removeHeaders: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.sync(() => []))),
  followRedirects: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  timeout: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 60000 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(10000))
  )
})
export type ProxyConfig = Schema.Schema.Type<typeof ProxyConfig>

// Predicate operators for matching incoming requests
export const PredicateOperator = Schema.Literals([
  "equals",
  "contains",
  "startsWith",
  "matches",
  "exists"
])
export type PredicateOperator = Schema.Schema.Type<typeof PredicateOperator>

// Which part of the request to match against
export const PredicateField = Schema.Literals([
  "method",
  "path",
  "headers",
  "query",
  "body"
])
export type PredicateField = Schema.Schema.Type<typeof PredicateField>

// A single predicate matcher
export const Predicate = Schema.Struct({
  field: PredicateField,
  operator: PredicateOperator,
  value: Schema.Unknown,
  caseSensitive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)))
})
export type Predicate = Schema.Schema.Type<typeof Predicate>

// How to cycle through responses
export const ResponseMode = Schema.Literals(["sequential", "random", "repeat"])
export type ResponseMode = Schema.Schema.Type<typeof ResponseMode>

// A single response configuration
export const ResponseConfig = Schema.Struct({
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(200))
  ),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  body: Schema.optional(Schema.Unknown),
  delay: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60000 })))
})
export type ResponseConfig = Schema.Schema.Type<typeof ResponseConfig>

// A stub: predicates (AND-combined) + responses (cycled)
export const Stub = Schema.Struct({
  id: NonEmptyString,
  predicates: Schema.Array(Predicate),
  responses: Schema.NonEmptyArray(ResponseConfig),
  responseMode: ResponseMode.pipe(Schema.withDecodingDefault(Effect.succeed("sequential" as const)))
})
export type Stub = Schema.Schema.Type<typeof Stub>

// API request to create a stub (id is auto-generated)
export const CreateStubRequest = Schema.Struct({
  predicates: Schema.Array(Predicate).pipe(Schema.withDecodingDefault(Effect.sync(() => []))),
  responses: Schema.NonEmptyArray(ResponseConfig),
  responseMode: ResponseMode.pipe(Schema.withDecodingDefault(Effect.succeed("sequential" as const)))
})
export type CreateStubRequest = Schema.Schema.Type<typeof CreateStubRequest>

// API request to update a stub
export const UpdateStubRequest = Schema.Struct({
  predicates: Schema.optional(Schema.Array(Predicate)),
  responses: Schema.optional(Schema.NonEmptyArray(ResponseConfig)),
  responseMode: Schema.optional(ResponseMode)
})
export type UpdateStubRequest = Schema.Schema.Type<typeof UpdateStubRequest>
