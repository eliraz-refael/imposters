import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { NonEmptyString, NonNegativeInt } from "./common.js"

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

// A delay in milliseconds, up to a minute
export const DelayMs = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60000 }))

// A delay drawn uniformly, in whole milliseconds, from [min, max] (both inclusive) each time the response is served
export const DelayRange = Schema.Struct({ min: DelayMs, max: DelayMs }).check(
  Schema.makeFilter((range) =>
    range.min <= range.max
      ? undefined
      : { path: ["max"], issue: `max (${range.max}) must be greater than or equal to min (${range.min})` }
  )
)
export type DelayRange = Schema.Schema.Type<typeof DelayRange>

// A response's delay: a fixed number of milliseconds, or a range to draw from
export const Delay = Schema.Union([DelayMs, DelayRange])
export type Delay = Schema.Schema.Type<typeof Delay>

// --- Callbacks: the calls a response makes to other services -------------------

// How many callbacks one response may make, `before` and `after` together
export const MAX_CALLBACKS = 10

// A callback's name: what templates call it (`callbacks.<name>`) and what labels its log record.
// No hyphen: JSONata would read `callbacks.my-call` as a subtraction.
export const CALLBACK_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const CallbackName = Schema.String.check(Schema.isPattern(CALLBACK_NAME_PATTERN))

export const CallbackMethod = Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
export type CallbackMethod = Schema.Schema.Type<typeof CallbackMethod>

// What a failed `before` call does to the answer: nothing (its result says it failed), or a 502
export const CallbackOnError = Schema.Literals(["continue", "fail"])
export type CallbackOnError = Schema.Schema.Type<typeof CallbackOnError>

// The scheme is literal: only the rest of the url may be templated
export const CALLBACK_URL_PATTERN = /^https?:\/\//

const callbackFields = {
  name: CallbackName,
  method: CallbackMethod.pipe(Schema.withDecodingDefault(Effect.succeed("GET" as const))),
  url: Schema.String.check(Schema.isPattern(CALLBACK_URL_PATTERN)),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  body: Schema.optional(Schema.Unknown),
  timeout: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 60000 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(5000))
  )
}

// fetch throws on a GET or HEAD with a body, so it is refused here rather than at call time
const noBodyOnGet = Schema.makeFilter((callback: { readonly method: CallbackMethod; readonly body?: unknown }) =>
  callback.body !== undefined && (callback.method === "GET" || callback.method === "HEAD")
    ? { path: ["body"], issue: `a ${callback.method} callback cannot send a body` }
    : undefined
)

// A call made before the response is built; its result feeds the response's templates
export const BeforeCallback = Schema.Struct({
  ...callbackFields,
  onError: CallbackOnError.pipe(Schema.withDecodingDefault(Effect.succeed("continue" as const)))
}).check(noBodyOnGet)
export type BeforeCallback = Schema.Schema.Type<typeof BeforeCallback>

// A call fired once the response is ready. Its failure cannot change an answer already given,
// so it has no `onError`: one is refused rather than silently dropped.
export const AfterCallback = Schema.Struct({
  ...callbackFields,
  onError: Schema.optional(Schema.Never)
}).check(noBodyOnGet)
export type AfterCallback = Schema.Schema.Type<typeof AfterCallback>

export type Callback = BeforeCallback | AfterCallback

// Names are unique across both phases (templates and log records look calls up by name), and
// the two lists hold at most MAX_CALLBACKS in all
export const Callbacks = Schema.Struct({
  before: Schema.Array(BeforeCallback).pipe(Schema.withDecodingDefault(Effect.sync(() => []))),
  after: Schema.Array(AfterCallback).pipe(Schema.withDecodingDefault(Effect.sync(() => []))),
  // Run the `before` calls at once instead of in order (each then sees only the request)
  parallel: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)))
}).check(
  Schema.makeFilter((callbacks) => {
    const total = callbacks.before.length + callbacks.after.length
    if (total > MAX_CALLBACKS) {
      return `a response makes at most ${MAX_CALLBACKS} callbacks, before and after together, not ${total}`
    }
    const issues: Array<Schema.FilterIssue> = []
    const seen = new Set<string>()
    const check = (phase: "before" | "after") => (callback: { readonly name: string }, index: number) => {
      if (seen.has(callback.name)) {
        issues.push({ path: [phase, index, "name"], issue: `the name "${callback.name}" is already used` })
      }
      seen.add(callback.name)
    }
    callbacks.before.forEach(check("before"))
    callbacks.after.forEach(check("after"))
    return issues
  })
)
export type Callbacks = Schema.Schema.Type<typeof Callbacks>

// A single response configuration
export const ResponseConfig = Schema.Struct({
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(200))
  ),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  body: Schema.optional(Schema.Unknown),
  delay: Schema.optional(Delay),
  callbacks: Schema.optional(Callbacks)
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

// POST /imposters/:imposterId/stubs: a stub to create, and where it goes in matching order.
// `index` runs from 0 (first) to the stub count (last, the default); it is not part of the stub.
export const AddStubRequest = Schema.Struct({
  ...CreateStubRequest.fields,
  index: Schema.optional(NonNegativeInt)
})
export type AddStubRequest = Schema.Schema.Type<typeof AddStubRequest>

// API request to update a stub
export const UpdateStubRequest = Schema.Struct({
  predicates: Schema.optional(Schema.Array(Predicate)),
  responses: Schema.optional(Schema.NonEmptyArray(ResponseConfig)),
  responseMode: Schema.optional(ResponseMode)
})
export type UpdateStubRequest = Schema.Schema.Type<typeof UpdateStubRequest>
