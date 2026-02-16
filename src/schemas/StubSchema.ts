import * as Schema from "effect/Schema"
import { NonEmptyString } from "./common.js"

// Proxy Mode
export const ProxyMode = Schema.Literal("passthrough", "record")
export type ProxyMode = Schema.Schema.Type<typeof ProxyMode>

// Proxy Configuration
export const ProxyConfig = Schema.Struct({
  targetUrl: Schema.String.pipe(Schema.pattern(/^https?:\/\//)),
  mode: Schema.optionalWith(ProxyMode, { default: () => "passthrough" as const }),
  addHeaders: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  removeHeaders: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] as const }),
  followRedirects: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  timeout: Schema.optionalWith(
    Schema.Number.pipe(Schema.int(), Schema.between(100, 60000)),
    { default: () => 10000 }
  )
})
export type ProxyConfig = Schema.Schema.Type<typeof ProxyConfig>

// Predicate operators for matching incoming requests
export const PredicateOperator = Schema.Literal(
  "equals",
  "contains",
  "startsWith",
  "matches",
  "exists"
)
export type PredicateOperator = Schema.Schema.Type<typeof PredicateOperator>

// Which part of the request to match against
export const PredicateField = Schema.Literal(
  "method",
  "path",
  "headers",
  "query",
  "body"
)
export type PredicateField = Schema.Schema.Type<typeof PredicateField>

// A single predicate matcher
export const Predicate = Schema.Struct({
  field: PredicateField,
  operator: PredicateOperator,
  value: Schema.Unknown,
  caseSensitive: Schema.optionalWith(Schema.Boolean, { default: () => true })
})
export type Predicate = Schema.Schema.Type<typeof Predicate>

// How to cycle through responses
export const ResponseMode = Schema.Literal("sequential", "random", "repeat")
export type ResponseMode = Schema.Schema.Type<typeof ResponseMode>

// A single response configuration
export const ResponseConfig = Schema.Struct({
  status: Schema.optionalWith(
    Schema.Number.pipe(Schema.int(), Schema.between(100, 599)),
    { default: () => 200 }
  ),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  body: Schema.optional(Schema.Unknown),
  delay: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(0, 60000)))
})
export type ResponseConfig = Schema.Schema.Type<typeof ResponseConfig>

// A stub: predicates (AND-combined) + responses (cycled)
export const Stub = Schema.Struct({
  id: NonEmptyString,
  predicates: Schema.Array(Predicate),
  responses: Schema.NonEmptyArray(ResponseConfig),
  responseMode: Schema.optionalWith(ResponseMode, { default: () => "sequential" as const })
})
export type Stub = Schema.Schema.Type<typeof Stub>

// API request to create a stub (id is auto-generated)
export const CreateStubRequest = Schema.Struct({
  predicates: Schema.optionalWith(Schema.Array(Predicate), { default: () => [] as const }),
  responses: Schema.NonEmptyArray(ResponseConfig),
  responseMode: Schema.optionalWith(ResponseMode, { default: () => "sequential" as const })
})
export type CreateStubRequest = Schema.Schema.Type<typeof CreateStubRequest>

// API request to update a stub
export const UpdateStubRequest = Schema.Struct({
  predicates: Schema.optional(Schema.Array(Predicate)),
  responses: Schema.optional(Schema.NonEmptyArray(ResponseConfig)),
  responseMode: Schema.optional(ResponseMode)
})
export type UpdateStubRequest = Schema.Schema.Type<typeof UpdateStubRequest>
