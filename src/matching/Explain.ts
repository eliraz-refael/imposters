import type { PredicateExplanation, StubExplanation } from "../schemas/ExplainSchema.js"
import type { RequestLogEntry } from "../schemas/RequestLogSchema.js"
import type { Predicate, Stub } from "../schemas/StubSchema.js"
import { evaluatePredicate, type RequestContext } from "./RequestMatcher.js"

/** Why a request did or did not match: every stub explained, and the one the matcher picks */
export interface ExplainResult {
  readonly stubs: ReadonlyArray<StubExplanation>
  /** The first stub that matches, as `findMatchingStub` finds it */
  readonly match?: Stub
  /** Set instead of `match` when the matcher would throw before any stub matched */
  readonly error?: string
}

const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e)

// For display only: the request's entries for the keys the predicate names, found case-insensitively
// so a near miss ("X-Id" asked, "x-id" sent) is visible. Whether it matched is the matcher's call.
const pickEntries = (actual: Record<string, string>, expected: unknown): Record<string, string> => {
  if (typeof expected !== "object" || expected === null) return actual
  const entries = Object.entries(actual)
  const picked: Record<string, string> = {}
  for (const key of Object.keys(expected)) {
    const entry = entries.find(([k]) => k === key) ?? entries.find(([k]) => k.toLowerCase() === key.toLowerCase())
    if (entry !== undefined) picked[entry[0]] = entry[1]
  }
  return picked
}

const actualValue = (ctx: RequestContext, predicate: Predicate): unknown => {
  switch (predicate.field) {
    case "method":
      return ctx.method
    case "path":
      return ctx.path
    case "headers":
      return pickEntries(ctx.headers, predicate.value)
    case "query":
      return pickEntries(ctx.query, predicate.value)
    case "body":
      return ctx.body
  }
}

/** One predicate against one request. `matched` is `evaluatePredicate`'s answer; a throw becomes `error` */
export const explainPredicate = (ctx: RequestContext, predicate: Predicate): PredicateExplanation => {
  const { caseSensitive, field, operator, value } = predicate
  const actual = actualValue(ctx, predicate)
  const base = {
    field,
    operator,
    caseSensitive,
    ...(value !== undefined ? { expected: value } : {}),
    ...(actual !== undefined ? { actual } : {})
  }
  try {
    return { ...base, matched: evaluatePredicate(ctx, predicate) }
  } catch (e) {
    return { ...base, matched: false, error: errorMessage(e) }
  }
}

// The matcher walks the predicates in order and stops at the first that fails or throws
const firstError = (predicates: ReadonlyArray<PredicateExplanation>): string | undefined => {
  for (const p of predicates) {
    if (p.error !== undefined) return p.error
    if (!p.matched) return undefined
  }
  return undefined
}

/** A predicate list against one request (AND-combined, like a stub's), every predicate explained */
export const explainPredicates = (
  ctx: RequestContext,
  predicates: ReadonlyArray<Predicate>
): Omit<StubExplanation, "stubId"> => {
  const explained = predicates.map((p) => explainPredicate(ctx, p))
  const error = firstError(explained)
  return {
    matched: explained.every((p) => p.matched),
    ...(error !== undefined ? { error } : {}),
    predicates: explained
  }
}

/** One stub against one request, with all of its predicates explained */
export const explainStub = (ctx: RequestContext, stub: Stub): StubExplanation => ({
  stubId: stub.id,
  ...explainPredicates(ctx, stub.predicates)
})

/** Every stub against one request, in matching order. `match` is the stub `findMatchingStub` returns */
export const explainStubs = (ctx: RequestContext, stubs: ReadonlyArray<Stub>): ExplainResult => {
  const explained = stubs.map((stub) => explainStub(ctx, stub))
  // The first stub the matcher settles on: a match, or a predicate that throws
  const decisive = explained.findIndex((s) => s.matched || s.error !== undefined)
  const stub = stubs[decisive]
  const explanation = explained[decisive]
  if (stub === undefined || explanation === undefined) return { stubs: explained }
  return explanation.error !== undefined
    ? { stubs: explained, error: explanation.error }
    : { stubs: explained, match: stub }
}

const encoder = new TextEncoder()

// The bytes are rebuilt from the parsed body; the log does not keep a binary body, so it comes back empty
const rawBodyOf = (body: unknown): Uint8Array<ArrayBuffer> =>
  body === undefined
    ? new Uint8Array(0)
    : encoder.encode(typeof body === "string" ? body : JSON.stringify(body))

/** The request context a logged request was matched with (its body as parsed then) */
export const contextFromCaptured = (request: RequestLogEntry["request"]): RequestContext => ({
  method: request.method,
  path: request.path,
  headers: request.headers,
  query: request.query,
  body: request.body,
  rawBody: rawBodyOf(request.body)
})
