import { Clock, Effect, Ref } from "effect"
import * as Result from "effect/Result"
import type { CallbackPhase, CallbackRecord } from "../schemas/RequestLogSchema.js"
import type { AfterCallback, BeforeCallback, Callback, Callbacks } from "../schemas/StubSchema.js"
import { alwaysCurrent, callOut, OutboundHttp } from "../services/OutboundHttp.js"
import {
  answered,
  type CallbackResult,
  type CallOutcome,
  checkCallbackUrl,
  failed,
  failResponse,
  MAX_IN_FLIGHT,
  MAX_RESPONSE_BYTES,
  recordOf,
  resultOf,
  skipped,
  skippedRecord,
  stopReason,
  TOO_MANY_IN_FLIGHT,
  type Verdict,
  verdictOf
} from "./CallbackRules.js"
import { hopLimitReason, loopResponse, mayCallOut, nextHop } from "./Hops.js"
import type { RequestContext } from "./RequestMatcher.js"
import { renderBody, renderHeaders } from "./ResponseGenerator.js"
import { applyTemplates, requestOnly, type TemplateContext } from "./TemplateEngine.js"

// Runs a response's callbacks. The rules (url checks, results, records, the failure policy)
// are pure, in CallbackRules.ts; this is the part that templates, sends and times. Every call
// goes through OutboundHttp, so a test can answer them without a network.

// How many callback calls a run has in flight; over MAX_IN_FLIGHT a call fails at once
export interface InFlight {
  // Takes a slot, or answers false when none is free (it never waits)
  readonly acquire: Effect.Effect<boolean>
  readonly release: Effect.Effect<void>
}

export const makeInFlight = (cap: number = MAX_IN_FLIGHT): Effect.Effect<InFlight> =>
  Ref.make(0).pipe(Effect.map((count) => ({
    acquire: Ref.modify(count, (n): readonly [boolean, number] => n < cap ? [true, n + 1] : [false, n]),
    release: Ref.update(count, (n) => Math.max(0, n - 1))
  })))

// The request the callbacks are made for
export interface CallbackRun {
  readonly imposterId: string
  // Whether the run is still the imposter's current one; its calls count in the stats only then
  readonly isCurrent?: Effect.Effect<boolean>
  // The hop the request arrived with
  readonly hop: number
  readonly inFlight: InFlight
}

interface Ran {
  readonly outcome: CallOutcome
  readonly record: CallbackRecord
}

interface Answer {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
}

const TOO_LARGE = "response body over 1 MiB"

// Reads the body up to MAX_RESPONSE_BYTES, cancelling the stream as soon as it is over
const readAnswer = async (response: Response): Promise<Result.Result<Answer, string>> => {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })
  const chunks: Array<Uint8Array> = []
  let size = 0
  const reader = response.body?.getReader()
  if (reader !== undefined) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        return Result.fail(TOO_LARGE)
      }
      chunks.push(value)
    }
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.length
  }
  return Result.succeed({ status: response.status, headers, body })
}

// One call: template it, check its url, send it within its timeout, and say how it went
const runCall = (
  callback: Callback,
  phase: CallbackPhase,
  tctx: TemplateContext,
  run: CallbackRun
): Effect.Effect<Ran, never, OutboundHttp> =>
  Effect.gen(function*() {
    const outbound = yield* OutboundHttp
    // A template that throws (a callback body too deeply nested to flatten) fails this call
    // rather than dying, which would leave the rest of the run unsent and its records pending
    const templatedUrl = yield* Effect.tryPromise({
      try: () => applyTemplates(tctx, callback.url),
      catch: (err) => `the url template failed: ${err instanceof Error ? err.message : String(err)}`
    }).pipe(Effect.result)
    if (Result.isFailure(templatedUrl)) {
      const outcome = failed(templatedUrl.failure, 0)
      return { outcome, record: recordOf(callback, phase, callback.url, outcome) }
    }
    const templated = templatedUrl.success
    const url = typeof templated === "string" ? templated : callback.url
    const checked = checkCallbackUrl(templated)
    if (Result.isFailure(checked)) {
      const outcome = failed(checked.failure, 0)
      return { outcome, record: recordOf(callback, phase, url, outcome) }
    }

    // A header name or templated value fetch cannot send (a space, a line break) throws: that
    // fails this call, rather than dying and leaving the rest of the run unsent
    const prepared = yield* Effect.tryPromise({
      try: async () => {
        const headers = new Headers()
        await renderHeaders(tctx, callback.headers, headers)
        if (callback.body === undefined) return { headers, body: undefined }
        const rendered = await renderBody(tctx, callback.body)
        if (!headers.has("content-type")) headers.set("content-type", rendered.contentType)
        return { headers, body: rendered.text }
      },
      catch: (err) => `invalid headers: ${err instanceof Error ? err.message : String(err)}`
    }).pipe(Effect.result)
    if (Result.isFailure(prepared)) {
      const outcome = failed(prepared.failure, 0)
      return { outcome, record: recordOf(callback, phase, url, outcome) }
    }
    const { body, headers } = prepared.success

    const start = yield* Clock.currentTimeMillis
    const elapsed = Clock.currentTimeMillis.pipe(Effect.map((now) => now - start))
    const send = callOut({
      imposterId: run.imposterId,
      ...(run.isCurrent !== undefined ? { isCurrent: run.isCurrent } : {}),
      via: "callback",
      request: {
        url: checked.success,
        method: callback.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        hop: nextHop(run.hop)
      },
      timeoutMs: callback.timeout,
      read: readAnswer,
      statusOf: (answer) => answer.status
    }).pipe(
      Effect.flatMap((answer) =>
        elapsed.pipe(Effect.map((ms) => answered(answer.status, answer.headers, answer.body, ms)))
      ),
      Effect.catchTag("HopLimitError", (err) => Effect.succeed(skipped(hopLimitReason(err.limit)))),
      Effect.catchTag("OutboundError", (err) => elapsed.pipe(Effect.map((ms) => failed(err.reason, ms))))
    )
    // Over the cap the call fails at once, and still counts as a failed call to its host
    const refuse = Effect.flatMap(run.isCurrent ?? alwaysCurrent, (current) =>
      current
        ? outbound.record(run.imposterId, {
          host: checked.success.host.toLowerCase(),
          via: "callback",
          atMs: start,
          durationMs: 0
        })
        : Effect.void).pipe(Effect.as(failed(TOO_MANY_IN_FLIGHT, 0)))
    const outcome = yield* Effect.acquireUseRelease(
      run.inFlight.acquire,
      (slot) => slot ? send : refuse,
      (slot) => slot ? run.inFlight.release : Effect.void
    )
    return { outcome, record: recordOf(callback, phase, url, outcome, body) }
  })

// ---------------------------------------------------------------- before

export type BeforePhase =
  // Every call ran (or failed, under onError: continue): the results feed the templates
  | {
    readonly _tag: "Continue"
    readonly results: Readonly<Record<string, CallbackResult>>
    readonly records: ReadonlyArray<CallbackRecord>
  }
  // The response is `response` (a 502 or a 508) instead of the stub's; `reason` is why the
  // `after` calls are not sent
  | {
    readonly _tag: "Stop"
    readonly response: Response
    readonly records: ReadonlyArray<CallbackRecord>
    readonly reason: string
  }

type Stopping = Exclude<Verdict, { readonly _tag: "Continue" }>

const stopResponse = (verdict: Stopping, run: CallbackRun, maxHops: number): Response =>
  verdict._tag === "Fail" ? failResponse(verdict) : loopResponse(run.hop, maxHops)

const resultsOf = (ran: ReadonlyArray<readonly [BeforeCallback, Ran]>): Record<string, CallbackResult> =>
  Object.fromEntries(ran.map(([callback, r]) => [callback.name, resultOf(r.outcome)]))

const runSequential = (
  before: ReadonlyArray<BeforeCallback>,
  request: RequestContext,
  run: CallbackRun,
  maxHops: number
): Effect.Effect<BeforePhase, never, OutboundHttp> =>
  Effect.gen(function*() {
    const ran: Array<readonly [BeforeCallback, Ran]> = []
    for (const [index, callback] of before.entries()) {
      // Each call sees the request and every call before it
      const r = yield* runCall(callback, "before", { request, callbacks: resultsOf(ran) }, run)
      ran.push([callback, r])
      const verdict = verdictOf(callback, r.outcome)
      if (verdict._tag !== "Continue") {
        const reason = stopReason(verdict)
        const rest = before.slice(index + 1).map((c) => skippedRecord(c, "before", reason))
        return {
          _tag: "Stop",
          response: stopResponse(verdict, run, maxHops),
          records: [...ran.map(([, x]) => x.record), ...rest],
          reason
        }
      }
    }
    return { _tag: "Continue", results: resultsOf(ran), records: ran.map(([, r]) => r.record) }
  })

const runParallel = (
  before: ReadonlyArray<BeforeCallback>,
  request: RequestContext,
  run: CallbackRun,
  maxHops: number
): Effect.Effect<BeforePhase, never, OutboundHttp> =>
  Effect.gen(function*() {
    const done = yield* Ref.make<ReadonlyMap<string, Ran>>(new Map())
    // Each call sees only the request. The first to stop the response interrupts the others.
    const all = yield* Effect.forEach(before, (callback) =>
      runCall(callback, "before", requestOnly(request), run).pipe(
        Effect.tap((r) => Ref.update(done, (m) => new Map(m).set(callback.name, r))),
        Effect.flatMap((r) => {
          const verdict = verdictOf(callback, r.outcome)
          return verdict._tag === "Continue" ? Effect.succeed([callback, r] as const) : Effect.fail(verdict)
        })
      ), { concurrency: "unbounded" }).pipe(Effect.result)
    if (Result.isSuccess(all)) {
      return { _tag: "Continue", results: resultsOf(all.success), records: all.success.map(([, r]) => r.record) }
    }
    const verdict = all.failure
    const finished = yield* Ref.get(done)
    const interrupted = `interrupted: callback "${verdict.callback}" ${
      verdict._tag === "Loop" ? "detected a loop" : "failed"
    }`
    const records = before.map((callback) =>
      finished.get(callback.name)?.record ??
        recordOf(callback, "before", callback.url, failed(interrupted, 0))
    )
    return { _tag: "Stop", response: stopResponse(verdict, run, maxHops), records, reason: stopReason(verdict) }
  })

// The `before` phase. A request at the hop limit sends none of them: it is answered 508.
export const runBefore = (
  callbacks: Callbacks,
  request: RequestContext,
  run: CallbackRun
): Effect.Effect<BeforePhase, never, OutboundHttp> =>
  Effect.gen(function*() {
    const { maxHops } = yield* OutboundHttp
    if (callbacks.before.length === 0) return { _tag: "Continue", results: {}, records: [] }
    if (!mayCallOut(run.hop, maxHops)) {
      const reason = hopLimitReason(maxHops)
      return {
        _tag: "Stop",
        response: loopResponse(run.hop, maxHops),
        records: callbacks.before.map((callback) => skippedRecord(callback, "before", reason)),
        reason
      }
    }
    return yield* callbacks.parallel
      ? runParallel(callbacks.before, request, run, maxHops)
      : runSequential(callbacks.before, request, run, maxHops)
  })

// ---------------------------------------------------------------- after

// The `after` calls in order, each settled with its record as it ends. They see the request and
// every `before` result. Past the hop limit each is recorded skipped.
export const runAfter = (
  after: ReadonlyArray<AfterCallback>,
  tctx: TemplateContext,
  run: CallbackRun,
  settle: (record: CallbackRecord) => Effect.Effect<void>
): Effect.Effect<void, never, OutboundHttp> =>
  Effect.forEach(
    after,
    (callback) => runCall(callback, "after", tctx, run).pipe(Effect.flatMap((r) => settle(r.record))),
    {
      discard: true
    }
  )
