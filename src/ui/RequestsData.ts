import * as DateTime from "effect/DateTime"
import type { ImposterConfig } from "../domain/imposter.js"
import { RECORD_BODY_BYTES } from "../matching/CallbackRules.js"
import { contextFromCaptured, explainStubs } from "../matching/Explain.js"
import { isNullBodyStatus } from "../matching/ResponseGenerator.js"
import type { PredicateExplanation, StubExplanation } from "../schemas/ExplainSchema.js"
import type { CallbackPhase, CallbackRecord, CallbackState, RequestLogEntry } from "../schemas/RequestLogSchema.js"
import type { Stub } from "../schemas/StubSchema.js"
import { LOG_BODY_LIMIT_BYTES } from "../server/ResponseCapture.js"
import { count } from "./components/format.js"
import { stubLabel } from "./LiveData.js"
import { hasUnloggedBody, requestTarget, toCurl } from "./resend.js"
import { draftStubUrl } from "./stubDraft.js"

/**
 * What the requests list (`/_admin/requests`) and a request's page (`/_admin/requests/:id`)
 * show, built by pure functions, so the templates only format: the list's filters, and for one
 * request what was asked and answered, what answered it, and why the stubs match it or not.
 */

// ---------------------------------------------------------------- the list's filters

/** What the request log can be narrowed to */
export interface RequestFilters {
  readonly method?: string
  readonly path?: string
  readonly status?: number
}

/** The filters a list URL asks for, the fields as typed (to show them again), and a filter that is not one */
export interface ParsedFilters {
  readonly filters: RequestFilters
  readonly fields: { readonly method: string; readonly path: string; readonly status: string }
  readonly error?: string
}

/** `?method=POST&path=/orders&status=201`; blanks are no filter, and a status that is not a number is an error */
export const parseFilters = (params: URLSearchParams): ParsedFilters => {
  const method = params.get("method")?.trim() ?? ""
  const path = params.get("path")?.trim() ?? ""
  const status = params.get("status")?.trim() ?? ""
  const statusNumber = Number(status)
  const statusOk = status === "" || (/^\d+$/.test(status) && Number.isInteger(statusNumber))
  return {
    filters: {
      ...(method !== "" ? { method: method.toUpperCase() } : {}),
      ...(path !== "" ? { path } : {}),
      ...(status !== "" && statusOk ? { status: statusNumber } : {})
    },
    fields: { method: method.toUpperCase(), path, status },
    ...(statusOk ? {} : { error: `Status filter must be a number, got "${status}".` })
  }
}

export const isFiltered = (filters: RequestFilters): boolean =>
  filters.method !== undefined || filters.path !== undefined || filters.status !== undefined

// ---------------------------------------------------------------- one request

export interface KeyValue {
  readonly key: string
  readonly value: string
}

/** A body as the page shows it */
export type BodyView =
  | { readonly kind: "none" }
  // `cut`: only its first 10 KiB were kept
  | { readonly kind: "text"; readonly text: string; readonly cut: boolean }
  // Not text, so the log has no copy; `bytes` when the message said how long it was
  | { readonly kind: "binary"; readonly bytes: number | undefined }

/** A stub as the page names it: its place in matching order (from 1) and its label */
export interface StubRef {
  readonly id: string
  readonly position: number
  readonly label: string
}

/** What answered the request when it arrived */
export type Answered =
  | {
    readonly kind: "stub"
    readonly stubId: string
    // The stub as it is now; undefined once it has been removed
    readonly stub: StubRef | undefined
    // Which of its responses, from 0, and how many it has now
    readonly responseIndex: number | undefined
    readonly responseCount: number | undefined
  }
  | { readonly kind: "extension"; readonly protocol: string }
  | { readonly kind: "proxy"; readonly target: string | undefined }
  | { readonly kind: "unmatched" }

/** One predicate checked against the request */
export interface VerdictRow {
  readonly ok: boolean
  // `path equals "/orders"`
  readonly predicate: string
  readonly ignoresCase: boolean
  // What the request had, shown when it adds something (not for an equals that held)
  readonly actual?: string
  // Why the predicate could not be checked (an invalid regex)
  readonly error?: string
}

export interface StubVerdicts {
  readonly stub: StubRef
  readonly matched: boolean
  readonly error?: string
  readonly rows: ReadonlyArray<VerdictRow>
}

/** Why the current stubs match the request or not */
export interface Explanation {
  // The stub the matcher picks now
  readonly match?: StubVerdicts
  // Every other stub, in matching order: none matched, or (after the match) it matches too but comes later
  readonly others: ReadonlyArray<StubVerdicts>
  // Matching would fail before any stub matched (so the imposter would answer 500)
  readonly error?: string
  // The current stubs pick the stub that answered (or none, as then)
  readonly agrees: boolean
}

/** A callback's body as the log kept it */
export interface CallBody {
  readonly text: string
  // Only its first 2 KiB were kept
  readonly cut: boolean
}

/** One call the response made to another service, as the Outbound calls panel shows it */
export interface OutboundCall {
  readonly name: string
  readonly phase: CallbackPhase
  readonly method: string
  readonly url: string
  readonly state: CallbackState
  // ✓ answered with a 2xx or 3xx, ✗ answered with a 4xx or 5xx or not at all, – never sent, … not settled yet
  readonly mark: string
  readonly tone: "ok" | "caution" | "error" | "muted"
  // "200 OK", the error of a failed call ("timed out after 5000 ms"), "skipped: …", "pending"
  readonly result: string
  readonly durationMs?: number
  readonly requestBody?: CallBody
  readonly responseBody?: CallBody
}

export interface RequestDetail {
  readonly id: string
  readonly method: string
  readonly path: string
  // Path and query string, as sent
  readonly target: string
  // The query as it reads, decoded: "status=open&page=2"; empty when there is none
  readonly queryText: string
  readonly epochMs: number
  readonly iso: string
  readonly duration: number
  readonly query: ReadonlyArray<KeyValue>
  readonly headers: ReadonlyArray<KeyValue>
  readonly body: BodyView
  readonly response: {
    readonly status: number
    // "Service Unavailable"; empty for a status without a common name
    readonly reason: string
    readonly headers: ReadonlyArray<KeyValue>
    readonly body: BodyView
  }
  readonly answered: Answered
  // The calls its response made, `before` first; empty when it made none
  readonly calls: ReadonlyArray<OutboundCall>
  // "sequential: answered #2 of 2, next is #1": when the logged stub answers now too and has a choice
  readonly responseLine?: string
  readonly explanation: Explanation
  // Set when today's stubs would answer differently from the logged answer
  readonly differs?: string
  // What answers a request no stub matches: "404", "the S3 extension", "the proxy"
  readonly fallback: string
  readonly curl: string
  // The stubs page with the editor prefilled for this method and path
  readonly draftUrl: string
}

const REASONS: Readonly<Record<number, string>> = {
  100: "Continue",
  101: "Switching Protocols",
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  206: "Partial Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  418: "I'm a teapot",
  422: "Unprocessable Content",
  425: "Too Early",
  428: "Precondition Required",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout"
}

/** A status's common name: 503 → "Service Unavailable"; "" for one without */
export const reasonPhrase = (status: number): string => REASONS[status] ?? ""

const keyValues = (record: Readonly<Record<string, string>>): ReadonlyArray<KeyValue> =>
  Object.entries(record).map(([key, value]) => ({ key, value }))

const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// JSON objects and arrays are indented; any other text is shown as it came
const pretty = (text: string): string => {
  const parsed = parsedJson(text)
  return typeof parsed === "object" && parsed !== null ? JSON.stringify(parsed, null, 2) : text
}

const declaredLength = (headers: Readonly<Record<string, string>>): number | undefined => {
  const value = headers["content-length"]?.trim()
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined
}

const requestBody = (request: RequestLogEntry["request"]): BodyView => {
  if (hasUnloggedBody(request)) return { kind: "binary", bytes: declaredLength(request.headers) }
  const body = request.body
  if (body === undefined) return { kind: "none" }
  const text = typeof body === "string" ? pretty(body) : JSON.stringify(body, null, 2)
  return { kind: "text", text, cut: false }
}

const encoder = new TextEncoder()

const responseBody = (method: string, response: RequestLogEntry["response"]): BodyView => {
  const length = declaredLength(response.headers)
  if (response.body === undefined) {
    // A HEAD answer, a 204 or a 304 declares the length of a body it never carries
    const bodiless = method.toUpperCase() === "HEAD" || isNullBodyStatus(response.status)
    return !bodiless && length !== undefined && length > 0 ? { kind: "binary", bytes: length } : { kind: "none" }
  }
  // The log keeps the first 10 KiB; without a declared length, a body that fills them was probably cut
  const cut = length !== undefined
    ? length > LOG_BODY_LIMIT_BYTES
    : encoder.encode(response.body).byteLength >= LOG_BODY_LIMIT_BYTES - 3
  return { kind: "text", text: cut ? response.body : pretty(response.body), cut }
}

const refOf = (stubs: ReadonlyArray<Stub>, id: string | undefined): StubRef | undefined => {
  if (id === undefined) return undefined
  const position = stubs.findIndex((stub) => stub.id === id)
  const stub = stubs[position]
  return stub === undefined ? undefined : { id: stub.id, position: position + 1, label: stubLabel(stub) }
}

const answeredBy = (entry: RequestLogEntry, config: ImposterConfig, stubs: ReadonlyArray<Stub>): Answered => {
  const { response } = entry
  switch (response.outcome) {
    case "stub": {
      const stubId = response.matchedStubId ?? ""
      const current = stubs.find((stub) => stub.id === stubId)
      return {
        kind: "stub",
        stubId,
        stub: refOf(stubs, stubId),
        responseIndex: response.responseIndex,
        responseCount: current?.responses.length
      }
    }
    case "extension":
      return { kind: "extension", protocol: config.protocol }
    case "proxy":
      return { kind: "proxy", target: config.proxy?.targetUrl }
    case "unmatched":
      return { kind: "unmatched" }
  }
}

// ---------------------------------------------------------------- explain

const ACTUAL_MAX = 240

const shorten = (text: string): string => text.length > ACTUAL_MAX ? `${text.slice(0, ACTUAL_MAX - 1)}…` : text

const isEmptyRecord = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0

// What the request had for the predicate's field, as the row shows it
const actualText = (p: PredicateExplanation): string => {
  if (p.actual === undefined) return p.field === "body" ? "no body" : "nothing"
  if ((p.field === "headers" || p.field === "query") && isEmptyRecord(p.actual)) {
    return p.field === "headers" ? "no such header" : "no such parameter"
  }
  return shorten(JSON.stringify(p.actual))
}

/** One predicate's row: `path equals "/orders"`, ✓ or ✗, and what the request had */
export const verdictRow = (p: PredicateExplanation): VerdictRow => {
  const predicate = p.expected === undefined
    ? `${p.field} ${p.operator}`
    : `${p.field} ${p.operator} ${shorten(JSON.stringify(p.expected))}`
  // A held equals says what the request had already
  const showActual = !(p.matched && p.operator === "equals")
  return {
    ok: p.matched,
    predicate,
    ignoresCase: !p.caseSensitive,
    ...(showActual ? { actual: actualText(p) } : {}),
    ...(p.error !== undefined ? { error: p.error } : {})
  }
}

const verdictsOf = (explained: StubExplanation, stubs: ReadonlyArray<Stub>): StubVerdicts => ({
  stub: refOf(stubs, explained.stubId) ?? { id: explained.stubId, position: 0, label: explained.stubId },
  matched: explained.matched,
  ...(explained.error !== undefined ? { error: explained.error } : {}),
  rows: explained.predicates.map(verdictRow)
})

/**
 * The request against the current stubs, as the admin API's explain endpoint answers it: every
 * stub's verdicts, the one the matcher picks, and whether that agrees with what answered then
 */
export const explainEntry = (entry: RequestLogEntry, stubs: ReadonlyArray<Stub>): Explanation => {
  const result = explainStubs(contextFromCaptured(entry.request), stubs)
  const verdicts = result.stubs.map((s) => verdictsOf(s, stubs))
  const matchId = result.match?.id
  const match = verdicts.find((v) => v.stub.id === matchId)
  const logged = entry.response.matchedStubId
  return {
    ...(match !== undefined ? { match } : {}),
    others: verdicts.filter((v) => v.stub.id !== matchId),
    ...(result.error !== undefined ? { error: result.error } : {}),
    // A request that would now fail to match was answered when it arrived, so that disagrees too
    agrees: result.error === undefined && matchId === logged
  }
}

const stubName = (ref: StubRef): string => `#${String(ref.position)} ${ref.label}`

const answeredText = (answered: Answered): string => {
  switch (answered.kind) {
    case "stub":
      return answered.stub === undefined
        ? `stub ${answered.stubId.slice(0, 8)} answered it (since removed)`
        : `${stubName(answered.stub)} answered it`
    case "extension":
      return `the ${answered.protocol} extension answered it`
    case "proxy":
      return "the proxy answered it"
    case "unmatched":
      return "no stub matched it"
  }
}

/** Why today's stubs would answer differently, or undefined when they would not */
export const differsText = (answered: Answered, explanation: Explanation): string | undefined => {
  if (explanation.agrees) return undefined
  const then = answeredText(answered)
  if (explanation.error !== undefined) {
    return `When it arrived, ${then}; now matching fails before any stub matches (${explanation.error}), so the imposter would answer 500.`
  }
  const now = explanation.match === undefined
    ? "now no stub matches"
    : `now ${stubName(explanation.match.stub)} matches`
  return `Today's stubs would answer this differently: when it arrived, ${then}; ${now}.`
}

/**
 * The logged response among the stub's: "sequential: answered #2 of 2, next is #1", "random:
 * answered #1 of 3". Only for a stub that is still there and has more than one response.
 */
export const responseLine = (
  stub: Stub,
  answeredIndex: number | undefined,
  nextIndex: number | undefined
): string | undefined => {
  const total = stub.responses.length
  if (total < 2 || answeredIndex === undefined) return undefined
  const answered = `answered #${String(answeredIndex + 1)} of ${String(total)}`
  if (stub.responseMode === "random" || nextIndex === undefined) return `${stub.responseMode}: ${answered}`
  return `${stub.responseMode}: ${answered}, next is #${String(nextIndex + 1)}`
}

const fallbackOf = (config: ImposterConfig): string =>
  config.protocol !== "HTTP" ? `the ${config.protocol} extension` : config.proxy !== undefined ? "the proxy" : "404"

// ---------------------------------------------------------------- outbound calls

const utf8Bytes = (text: string): number => encoder.encode(text).byteLength

/**
 * A record's body. The log keeps a body of up to 2 KiB whole, and of a longer one its first
 * 2 KiB (less a character the cut split) followed by "…", which is then 2 KiB or more. So a text
 * that ends with "…" and is that long was cut. JSON is indented unless it was cut.
 */
export const callBody = (text: string | undefined): CallBody | undefined => {
  if (text === undefined) return undefined
  const cut = text.endsWith("…") && utf8Bytes(text) >= RECORD_BODY_BYTES
  return { text: cut ? text : pretty(text), cut }
}

const callResult = (record: CallbackRecord): Pick<OutboundCall, "mark" | "tone" | "result"> => {
  switch (record.state) {
    case "answered": {
      const status = record.status ?? 0
      const reason = reasonPhrase(status)
      const tone = status >= 500 ? "error" : status >= 400 ? "caution" : "ok"
      return { mark: status >= 400 ? "✗" : "✓", tone, result: reason === "" ? String(status) : `${status} ${reason}` }
    }
    case "failed":
      // The ✗ says it failed; the error says why ("connection failed: …", "timed out after 2000 ms")
      return { mark: "✗", tone: "error", result: record.error ?? "no answer" }
    case "skipped":
      return { mark: "–", tone: "muted", result: `skipped: ${record.error ?? "not sent"}` }
    case "pending":
      return { mark: "…", tone: "muted", result: "pending" }
  }
}

export const outboundCall = (record: CallbackRecord): OutboundCall => {
  const requestBody = callBody(record.requestBody)
  const responseBody = callBody(record.responseBody)
  return {
    name: record.name,
    phase: record.phase,
    method: record.method.toUpperCase(),
    url: record.url,
    state: record.state,
    ...callResult(record),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(requestBody !== undefined ? { requestBody } : {}),
    ...(responseBody !== undefined ? { responseBody } : {})
  }
}

const PHASE_ORDER: Readonly<Record<CallbackPhase, number>> = { before: 0, after: 1 }

/** The entry's callback records, `before` first (the log keeps them so already), each in its own order */
export const outboundCalls = (records: ReadonlyArray<CallbackRecord> | undefined): ReadonlyArray<OutboundCall> =>
  // map makes a fresh array, so sorting it in place (a stable sort) changes nothing else
  (records ?? []).map(outboundCall).sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase])

export interface DetailInput {
  readonly entry: RequestLogEntry
  readonly config: ImposterConfig
  readonly stubs: ReadonlyArray<Stub>
  // The response the logged stub gives next, when it is still there (none in random mode)
  readonly nextIndex: number | undefined
  // The imposter's address as the browser reached it, for the curl command
  readonly origin: string
}

export const buildRequestDetail = (input: DetailInput): RequestDetail => {
  const { config, entry, stubs } = input
  const { request, response } = entry
  const answered = answeredBy(entry, config, stubs)
  const explanation = explainEntry(entry, stubs)
  const loggedStub = answered.kind === "stub" ? stubs.find((stub) => stub.id === answered.stubId) : undefined
  const line = loggedStub === undefined ? undefined : responseLine(loggedStub, response.responseIndex, input.nextIndex)
  const differs = differsText(answered, explanation)
  const epochMs = DateTime.toEpochMillis(entry.timestamp)
  return {
    id: entry.id,
    method: request.method.toUpperCase(),
    path: request.path,
    target: requestTarget(request),
    queryText: Object.entries(request.query).map(([key, value]) => `${key}=${value}`).join("&"),
    epochMs,
    iso: DateTime.formatIso(entry.timestamp),
    duration: entry.duration,
    query: keyValues(request.query),
    headers: keyValues(request.headers),
    body: requestBody(request),
    response: {
      status: response.status,
      reason: reasonPhrase(response.status),
      headers: keyValues(response.headers),
      body: responseBody(request.method, response)
    },
    answered,
    calls: outboundCalls(entry.callbacks),
    ...(line !== undefined ? { responseLine: line } : {}),
    explanation,
    ...(differs !== undefined ? { differs } : {}),
    fallback: fallbackOf(config),
    curl: toCurl(entry, input.origin),
    draftUrl: draftStubUrl(request.method, request.path)
  }
}

/** "1,024 bytes", or "" when the length is not known */
export const bytesText = (bytes: number | undefined): string => bytes === undefined ? "" : `${count(bytes)} bytes`
