import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import type { PreviewResponse, PreviewSample } from "../schemas/ExplainSchema.js"
import type { RequestLogEntry } from "../schemas/RequestLogSchema.js"
import type { CreateStubRequest } from "../schemas/StubSchema.js"
import { contextFromCaptured, explainPredicates } from "./Explain.js"
import type { RequestContext } from "./RequestMatcher.js"
import { buildResponse, isNullBodyStatus } from "./ResponseGenerator.js"

/** A group of like requests (the unmatched `METHOD path` groups): how many, and the latest one */
export interface RequestSample {
  readonly count: number
  readonly sample: RequestLogEntry
}

/** A stub not yet added: what it matches on and what it answers */
export type CandidateStub = Pick<CreateStubRequest, "predicates" | "responses">

const sampleResponse = (
  candidate: CandidateStub,
  ctx: RequestContext,
  request: RequestLogEntry["request"]
): Effect.Effect<PreviewSample, string> =>
  Effect.tryPromise({
    // The first response is the one a new stub gives first; its delay is not waited out
    try: async () => {
      const response = await buildResponse(candidate.responses[0], ctx)
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headers[key] = value
      })
      const body = isNullBodyStatus(response.status) ? undefined : await response.text()
      return {
        request: { method: request.method, path: request.path },
        response: { status: response.status, headers, ...(body !== undefined ? { body } : {}) }
      }
    },
    catch: (e) => `Response could not be built: ${e instanceof Error ? e.message : String(e)}`
  })

/**
 * What a candidate stub would catch of the given request groups: `matched` and `total` sum the
 * groups' counts, and `sample` is the candidate answering the first group it matches. A predicate
 * that would throw at runtime (an invalid regex) counts as no match and is reported in `error`.
 */
export const previewStub = (
  candidate: CandidateStub,
  samples: ReadonlyArray<RequestSample>
): Effect.Effect<PreviewResponse> =>
  Effect.gen(function*() {
    let matched = 0
    let total = 0
    let first: RequestSample | undefined
    let error: string | undefined
    for (const group of samples) {
      total += group.count
      const explained = explainPredicates(contextFromCaptured(group.sample.request), candidate.predicates)
      error ??= explained.error
      if (!explained.matched) continue
      matched += group.count
      first ??= group
    }
    if (first === undefined) return { matched, total, ...(error !== undefined ? { error } : {}) }
    const built = yield* Effect.result(
      sampleResponse(candidate, contextFromCaptured(first.sample.request), first.sample.request)
    )
    if (Result.isFailure(built)) return { matched, total, error: error ?? built.failure }
    return { matched, total, sample: built.success, ...(error !== undefined ? { error } : {}) }
  })
