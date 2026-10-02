import * as Schema from "effect/Schema"
import { NonEmptyString, NonNegativeInt } from "./common.js"
import { PredicateField, PredicateOperator } from "./StubSchema.js"

// One predicate checked against one request. `matched` is exactly what the matcher decides;
// `error` is set when the matcher would throw instead (an invalid regex), and `matched` is then false.
export const PredicateExplanation = Schema.Struct({
  field: PredicateField,
  operator: PredicateOperator,
  caseSensitive: Schema.Boolean,
  // The predicate's value (absent when it has none)
  expected: Schema.optional(Schema.Unknown),
  // The request's value for the field; for headers and query, only the keys the predicate names
  actual: Schema.optional(Schema.Unknown),
  matched: Schema.Boolean,
  error: Schema.optional(Schema.String)
})
export type PredicateExplanation = Schema.Schema.Type<typeof PredicateExplanation>

// One stub checked against one request: every predicate is explained, even past the first that fails
export const StubExplanation = Schema.Struct({
  stubId: NonEmptyString,
  matched: Schema.Boolean,
  // The error the matcher stops on, walking the predicates in order (a failed predicate before it hides it)
  error: Schema.optional(Schema.String),
  predicates: Schema.Array(PredicateExplanation)
})
export type StubExplanation = Schema.Schema.Type<typeof StubExplanation>

// GET /imposters/:id/requests/:requestId/explain — a logged request against the current stubs
export const ExplainResponse = Schema.Struct({
  requestId: NonEmptyString,
  // Every current stub, in matching order
  stubs: Schema.Array(StubExplanation),
  // The first stub that matches now
  matchedStubId: Schema.optional(NonEmptyString),
  // The stub that answered when the request arrived
  loggedMatchedStubId: Schema.optional(NonEmptyString),
  // False when the current stubs pick a different stub (or none) than the one that answered
  agreesWithLog: Schema.Boolean,
  // Set when matching would fail before any stub matched, so the imposter would answer 500
  error: Schema.optional(Schema.String)
})
export type ExplainResponse = Schema.Schema.Type<typeof ExplainResponse>

// A candidate stub's first response to one unmatched request
export const PreviewSample = Schema.Struct({
  request: Schema.Struct({ method: Schema.String, path: Schema.String }),
  response: Schema.Struct({
    status: Schema.Number,
    headers: Schema.Record(Schema.String, Schema.String),
    body: Schema.optional(Schema.String)
  })
})
export type PreviewSample = Schema.Schema.Type<typeof PreviewSample>

// POST /imposters/:imposterId/stubs/preview — what a candidate stub would catch of the unmatched traffic
export const PreviewResponse = Schema.Struct({
  // Unmatched requests the candidate would answer
  matched: NonNegativeInt,
  // All unmatched requests counted
  total: NonNegativeInt,
  // The candidate answering the most recently seen request it matches
  sample: Schema.optional(PreviewSample),
  // Why the candidate would fail at runtime (an invalid regex, a response that cannot be built)
  error: Schema.optional(Schema.String)
})
export type PreviewResponse = Schema.Schema.Type<typeof PreviewResponse>
