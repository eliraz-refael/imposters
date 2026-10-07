import * as Result from "effect/Result"
import type { CallbackPhase, CallbackRecord } from "../schemas/RequestLogSchema.js"
import type { BeforeCallback, Callback } from "../schemas/StubSchema.js"
import { isLoopAnswer } from "./Hops.js"

// The pure rules behind Callbacks.ts: what a templated url must look like, how an answer
// becomes the result templates see and the record the log keeps, and what a `before` call's
// outcome does to the response.

// A callback's answer is read up to this many bytes; a longer one is a failure
export const MAX_RESPONSE_BYTES = 1_048_576
// How much of each body a log record keeps
export const RECORD_BODY_BYTES = 2048
// Callback calls one imposter run may have in flight at once (before and after together)
export const MAX_IN_FLIGHT = 64
export const TOO_MANY_IN_FLIGHT = "too many callbacks in flight"

// What a response's templates see as `callbacks.<name>`
export interface CallbackResult {
  // true for a 2xx status, false otherwise (and when no response came back)
  readonly ok: boolean
  readonly status?: number
  // Lower-cased names
  readonly headers?: Readonly<Record<string, string>>
  // JSON when the content-type says JSON and it parses, else UTF-8 text; absent when empty or binary
  readonly body?: unknown
  readonly durationMs: number
  // Why no response came back
  readonly error?: string
}

// How one call ended
export type CallOutcome =
  | {
    readonly _tag: "Answered"
    readonly status: number
    readonly headers: Readonly<Record<string, string>>
    readonly body: Uint8Array
    readonly durationMs: number
  }
  | { readonly _tag: "Failed"; readonly error: string; readonly durationMs: number }
  | { readonly _tag: "Skipped"; readonly error: string }

export const answered = (
  status: number,
  headers: Readonly<Record<string, string>>,
  body: Uint8Array,
  durationMs: number
): CallOutcome => ({ _tag: "Answered", status, headers, body, durationMs })

export const failed = (error: string, durationMs: number): CallOutcome => ({ _tag: "Failed", error, durationMs })

export const skipped = (error: string): CallOutcome => ({ _tag: "Skipped", error })

// ---------------------------------------------------------------- the url

const shownUrl = (value: string): string => JSON.stringify(value.length > 80 ? `${value.slice(0, 79)}…` : value)

// The url a callback calls, once templated. It must be text that parses as an http: or https:
// URL with no template left in it, so a half-templated host never leaves the machine.
export const checkCallbackUrl = (templated: unknown): Result.Result<URL, string> => {
  if (typeof templated !== "string") return Result.fail("the url template did not give text")
  if (templated.includes("{{") || templated.includes("${")) {
    return Result.fail(`the url still holds a template after templating: ${shownUrl(templated)}`)
  }
  if (!URL.canParse(templated)) return Result.fail(`invalid url: ${shownUrl(templated)}`)
  const url = new URL(templated)
  return url.protocol === "http:" || url.protocol === "https:"
    ? Result.succeed(url)
    : Result.fail(`the url must use http or https: ${shownUrl(templated)}`)
}

// ---------------------------------------------------------------- bodies

const isJsonType = (contentType: string | undefined): boolean => {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
  return type === "application/json" || type.endsWith("+json")
}

const utf8 = (bytes: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/** An answer's body as templates see it: JSON when declared and valid, else text, else absent */
export const decodeBody = (contentType: string | undefined, bytes: Uint8Array): unknown => {
  if (bytes.length === 0) return undefined
  const text = utf8(bytes)
  if (text === undefined) return undefined
  if (isJsonType(contentType)) {
    try {
      const parsed: unknown = JSON.parse(text)
      return parsed
    } catch {
      return text
    }
  }
  return text
}

/** The first RECORD_BODY_BYTES of a body as text, "…" marking a cut; absent when empty or binary */
export const recordText = (body: Uint8Array | string): string | undefined => {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body
  if (bytes.length === 0) return undefined
  if (bytes.length <= RECORD_BODY_BYTES) return utf8(bytes)
  // Decoded leniently: the cut may fall inside a character, which then reads as U+FFFD and is dropped
  const head = utf8(bytes) === undefined
    ? undefined
    : new TextDecoder("utf-8").decode(bytes.subarray(0, RECORD_BODY_BYTES)).replace(/�+$/, "")
  return head === undefined ? undefined : `${head}…`
}

// ---------------------------------------------------------------- results and records

const isOk = (status: number): boolean => status >= 200 && status < 300

/** What a call's outcome shows the response's templates */
export const resultOf = (outcome: CallOutcome): CallbackResult => {
  switch (outcome._tag) {
    case "Answered": {
      const body = decodeBody(outcome.headers["content-type"], outcome.body)
      return {
        ok: isOk(outcome.status),
        status: outcome.status,
        headers: outcome.headers,
        ...(body !== undefined ? { body } : {}),
        durationMs: outcome.durationMs
      }
    }
    case "Failed":
      return { ok: false, error: outcome.error, durationMs: outcome.durationMs }
    case "Skipped":
      return { ok: false, error: outcome.error, durationMs: 0 }
  }
}

/** The log record of a call: `url` is the templated url (or the template when that failed) */
export const recordOf = (
  callback: Callback,
  phase: CallbackPhase,
  url: string,
  outcome: CallOutcome,
  requestBody?: string
): CallbackRecord => {
  const sent = requestBody === undefined ? undefined : recordText(requestBody)
  const base = { name: callback.name, phase, method: callback.method, url }
  switch (outcome._tag) {
    case "Answered": {
      const responseBody = recordText(outcome.body)
      return {
        ...base,
        state: "answered",
        status: outcome.status,
        durationMs: outcome.durationMs,
        ...(sent !== undefined ? { requestBody: sent } : {}),
        ...(responseBody !== undefined ? { responseBody } : {})
      }
    }
    case "Failed":
      return {
        ...base,
        state: "failed",
        error: outcome.error,
        durationMs: outcome.durationMs,
        ...(sent !== undefined ? { requestBody: sent } : {})
      }
    case "Skipped":
      return { ...base, state: "skipped", error: outcome.error }
  }
}

/** An `after` call logged before it runs; settled later with its real record */
export const pendingRecord = (callback: Callback): CallbackRecord => ({
  name: callback.name,
  phase: "after",
  method: callback.method,
  url: callback.url,
  state: "pending"
})

/** A call that was never sent, with why */
export const skippedRecord = (callback: Callback, phase: CallbackPhase, reason: string): CallbackRecord =>
  recordOf(callback, phase, callback.url, skipped(reason))

// ---------------------------------------------------------------- the failure policy

// What a `before` call's outcome does to the response
export type Verdict =
  | { readonly _tag: "Continue" }
  // The response becomes a 502: an upstream 5xx (`status`) or no response at all (`reason`)
  | { readonly _tag: "Fail"; readonly callback: string; readonly status?: number; readonly reason?: string }
  // The call was answered 508 with the loop header: the loop travels up, whatever onError says
  | { readonly _tag: "Loop"; readonly callback: string }

const CONTINUE: Verdict = { _tag: "Continue" }

export const verdictOf = (callback: BeforeCallback, outcome: CallOutcome): Verdict => {
  if (outcome._tag === "Answered" && isLoopAnswer(outcome.status, outcome.headers)) {
    return { _tag: "Loop", callback: callback.name }
  }
  if (callback.onError === "continue") return CONTINUE
  switch (outcome._tag) {
    case "Answered":
      return outcome.status >= 500 ? { _tag: "Fail", callback: callback.name, status: outcome.status } : CONTINUE
    case "Failed":
    case "Skipped":
      return { _tag: "Fail", callback: callback.name, reason: outcome.error }
  }
}

/** Why the calls a stopping verdict left unsent were skipped */
export const stopReason = (verdict: Exclude<Verdict, { readonly _tag: "Continue" }>): string =>
  verdict._tag === "Loop"
    ? `not sent: callback "${verdict.callback}" detected a loop`
    : `not sent: callback "${verdict.callback}" failed`

/** The 502 a failed `before` call with `onError: "fail"` answers */
export const failResponse = (verdict: Extract<Verdict, { readonly _tag: "Fail" }>): Response =>
  new Response(
    JSON.stringify({
      error: "Callback failed",
      callback: verdict.callback,
      ...(verdict.status !== undefined ? { status: verdict.status } : {}),
      ...(verdict.reason !== undefined ? { reason: verdict.reason } : {})
    }),
    { status: 502, headers: { "content-type": "application/json" } }
  )
