import * as Clock from "effect/Clock"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Sse from "effect/unstable/encoding/Sse"
import type { ImposterConfig, ImposterNotFoundError } from "../domain/imposter.js"
import type {
  ImposterRepositoryShape,
  StubIndexOutOfRangeError,
  StubNotFoundError
} from "../repositories/ImposterRepository.js"
import { NonEmptyString } from "../schemas/common.js"
import type { RequestLogEntry } from "../schemas/RequestLogSchema.js"
import { Predicate, ResponseConfig, ResponseMode, type Stub } from "../schemas/StubSchema.js"
import { StubChange } from "../server/StubChange.js"
import type { MetricsServiceShape } from "../services/MetricsService.js"
import type { RequestLoggerShape } from "../services/RequestLogger.js"
import { assetRoute } from "./assets/serve.js"
import { browserHost, crossSiteRefusal, isCrossSite } from "./crossSite.js"
import { faviconResponse } from "./favicon.js"
import { html, type SafeHtml } from "./html.js"
import { errorBox, errorResponse, formString, htmlResponse } from "./htmx.js"
import { buildLiveData, type LiveData } from "./LiveData.js"
import {
  liveFragment,
  livePage,
  RECENT_ROWS,
  REQUEST_EVENT,
  requestRow,
  requestRows,
  type RowContext
} from "./pages/live.js"
import { requestDetailPage, requestNotFoundPage } from "./pages/request-detail.js"
import { requestsPage, testResultPartial } from "./pages/requests.js"
import { stubsPage } from "./pages/stubs.js"
import { requestTablePartial, stubListPartial } from "./partials.js"
import { draftFromQuery } from "./stubDraft.js"
import { themeFromCookie } from "./theme.js"

export interface UiDeps {
  readonly id: string
  // The config at start; pages read the current one from the repository and fall back to this
  readonly config: ImposterConfig
  readonly stubsRef: Ref.Ref<ReadonlyArray<Stub>>
  readonly repo: ImposterRepositoryShape
  // Every stub write goes through here, as the admin API's do, so both reset the same counters
  readonly applyStubChange: (
    change: StubChange
  ) => Effect.Effect<Stub, ImposterNotFoundError | StubNotFoundError | StubIndexOutOfRangeError>
  readonly requestLogger: RequestLoggerShape
  // Counts since the imposter started; the request log keeps only the latest entries
  readonly metrics: MetricsServiceShape
  // The index of the response the stub gives next in this run; None in random mode
  readonly nextResponseIndex: (stub: Stub) => Effect.Effect<Option.Option<number>>
  // Completes when this run's server is released: every event stream ends with it
  readonly shutdown: Effect.Effect<void>
  // The admin server's port, for the link back to the admin UI
  readonly adminPort?: number
  readonly runPromise: <A>(effect: Effect.Effect<A>) => Promise<A>
  // The imposter's own handler, so a test request does not depend on the address it binds
  readonly fetchSelf: (request: Request) => Promise<Response>
}

const ADMIN_PREFIX = "/_admin"

// The browser reconnects this long after a dropped stream; a comment line every HEARTBEAT keeps
// proxies and idle timeouts from closing a quiet one
const RECONNECT = Duration.seconds(2)
const HEARTBEAT = Duration.seconds(15)

const NO_STORE = { "cache-control": "no-store" }

// The redesigned pages and their fragments are never cached: they are live
const pageResponse = (body: SafeHtml, status = 200): Response =>
  new Response(body.value, { status, headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE } })

const EVENT_STREAM_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  ...NO_STORE,
  // nginx and the like buffer a response unless told not to, which would hold every event back
  "x-accel-buffering": "no"
}

// A failed UI action: the message the user sees and the status it is sent with
class UiError extends Data.TaggedError("UiError")<{ readonly message: string; readonly status: number }> {}

// The add/edit stub form: JSON text fields, decoded exactly as the admin API decodes a stub
const PredicatesJson = Schema.fromJsonString(Schema.Array(Predicate))
const ResponsesJson = Schema.fromJsonString(Schema.NonEmptyArray(ResponseConfig))
const StubForm = Schema.Struct({ predicates: PredicatesJson, responses: ResponsesJson, responseMode: ResponseMode })
const StubPatchForm = Schema.Struct({
  predicates: Schema.optional(PredicatesJson),
  responses: Schema.optional(ResponsesJson),
  responseMode: Schema.optional(ResponseMode)
})

const decodeForm = <A>(decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>, input: unknown) =>
  decode(input).pipe(
    Effect.mapError((err) =>
      new UiError({ message: `Invalid stub: ${err.message.replaceAll("\n", " ")}`, status: 400 })
    )
  )

const readForm = (request: Request): Effect.Effect<FormData, UiError> =>
  Effect.tryPromise({
    try: () => request.formData(),
    catch: () => new UiError({ message: "Expected a form submission.", status: 400 })
  })

// The form's text fields with blank ones left out, so a blank field means "not given"
const nonBlankFields = (form: FormData, names: ReadonlyArray<string>): Record<string, string> => {
  const fields: Record<string, string> = {}
  for (const name of names) {
    const value = formString(form, name)?.trim()
    if (value !== undefined && value !== "") fields[name] = value
  }
  return fields
}

const parseStubIdFromPath = (path: string): string | null => {
  const match = /^\/stubs\/([^/]+)$/.exec(path)
  return match?.[1] ?? null
}

const stubListOob = (stubs: ReadonlyArray<Stub>) =>
  html`<div id="stub-list" hx-swap-oob="innerHTML">${stubListPartial(stubs)}</div>`

export const makeUiRouter = (deps: UiDeps) => {
  const currentConfig: Effect.Effect<ImposterConfig> = deps.repo.get(deps.id).pipe(
    Effect.map((record) => record.config),
    Effect.catch(() => Effect.succeed(deps.config))
  )

  // The stubs to render after a change. Read only: applyStubChange has already hot-reloaded the
  // server under its lock, and writing the Ref here would bypass that lock
  const reloadStubs: Effect.Effect<ReadonlyArray<Stub>> = deps.repo.getStubs(deps.id).pipe(
    Effect.catch(() => Ref.get(deps.stubsRef))
  )

  const imposterGone = () => new UiError({ message: "This imposter no longer exists.", status: 404 })

  const addStub = (request: Request): Effect.Effect<Response, UiError> =>
    Effect.gen(function*() {
      const form = yield* readForm(request)
      const fields = nonBlankFields(form, ["predicates", "responses", "responseMode"])
      if (fields.responses === undefined) {
        return yield* new UiError({ message: "Responses field is required.", status: 400 })
      }
      // The schema's own wording for this one ("Missing key at [0]") reads as a puzzle
      if (fields.responses.replaceAll(/\s/g, "") === "[]") {
        return yield* new UiError({ message: "Responses must be a non-empty array.", status: 400 })
      }
      const decoded = yield* decodeForm(Schema.decodeUnknownEffect(StubForm), {
        predicates: "[]",
        responseMode: "sequential",
        ...fields
      })
      const stub: Stub = { id: NonEmptyString.make(crypto.randomUUID().slice(0, 8)), ...decoded }
      yield* deps.applyStubChange(StubChange.Add({ stub })).pipe(Effect.mapError(imposterGone))
      return htmlResponse(stubListPartial(yield* reloadStubs))
    })

  const updateStub = (request: Request, stubId: string): Effect.Effect<Response, UiError> =>
    Effect.gen(function*() {
      const form = yield* readForm(request)
      const patch = yield* decodeForm(
        Schema.decodeUnknownEffect(StubPatchForm),
        nonBlankFields(form, ["predicates", "responses", "responseMode"])
      )
      yield* deps.applyStubChange(StubChange.Update({ stubId, patch })).pipe(
        Effect.catchTags({
          StubNotFoundError: () => Effect.fail(new UiError({ message: "Stub not found.", status: 404 })),
          ImposterNotFoundError: () => Effect.fail(imposterGone()),
          // Only an insert has a position, so an edit cannot fail with one
          StubIndexOutOfRangeError: (e) => Effect.die(e)
        })
      )
      return htmlResponse(stubListPartial(yield* reloadStubs))
    })

  const deleteStub = (stubId: string): Effect.Effect<Response> =>
    deps.applyStubChange(StubChange.Remove({ stubId })).pipe(
      Effect.andThen(reloadStubs),
      Effect.map((stubs) => htmlResponse(stubListPartial(stubs))),
      // Already gone (deleted elsewhere): say so, and refresh the list the user is looking at
      Effect.catch(() =>
        reloadStubs.pipe(
          Effect.map((stubs) => errorResponse(`Stub ${stubId} no longer exists.`, 404, stubListOob(stubs)))
        )
      )
    )

  const listRequests = (params: URLSearchParams): Effect.Effect<Response, UiError> =>
    Effect.gen(function*() {
      const opts: { limit?: number; method?: string; path?: string; status?: number } = { limit: 100 }
      const methodFilter = params.get("method")?.trim()
      if (methodFilter) opts.method = methodFilter
      const pathFilter = params.get("path")?.trim()
      if (pathFilter) opts.path = pathFilter
      const statusFilter = params.get("status")?.trim()
      if (statusFilter) {
        const status = Number(statusFilter)
        if (!Number.isInteger(status)) {
          return yield* new UiError({ message: `Status filter must be a number, got "${statusFilter}".`, status: 400 })
        }
        opts.status = status
      }
      const entries = yield* deps.requestLogger.getEntries(deps.id, opts)
      return htmlResponse(requestTablePartial(entries.slice().reverse()))
    })

  // Errors here stay in #test-result (no retarget): that is where the user looks for the answer
  const sendTestRequest = (request: Request): Effect.Effect<Response> =>
    Effect.gen(function*() {
      const form = yield* readForm(request)
      const testMethod = formString(form, "method") || "GET"
      const rawPath = formString(form, "path")?.trim() || "/"
      const testPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`
      const testBody = formString(form, "body") || undefined
      const testContentType = formString(form, "contentType") || "application/json"
      const testHeadersRaw = formString(form, "headers") ?? ""

      const headers: Record<string, string> = {}
      if (testBody !== undefined) {
        headers["content-type"] = testContentType
      }
      for (const line of testHeadersRaw.split("\n")) {
        const colonIdx = line.indexOf(":")
        if (colonIdx > 0) {
          headers[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim()
        }
      }

      const testRequest = yield* Effect.try({
        try: () =>
          new Request(`http://localhost:${deps.config.port}${testPath}`, {
            method: testMethod,
            headers,
            ...(testBody !== undefined && testMethod !== "GET" && testMethod !== "HEAD" ? { body: testBody } : {})
          }),
        catch: (err) => new UiError({ message: `Invalid test request: ${String(err)}`, status: 400 })
      })

      const startTime = yield* Clock.currentTimeMillis
      const testResp = yield* Effect.tryPromise({
        try: () => deps.fetchSelf(testRequest),
        catch: (err) => new UiError({ message: `Request failed: ${String(err)}`, status: 502 })
      })
      const respBody = yield* Effect.tryPromise({
        try: () => testResp.text(),
        catch: (err) => new UiError({ message: `Reading the response failed: ${String(err)}`, status: 502 })
      })
      const duration = (yield* Clock.currentTimeMillis) - startTime

      const respHeaders: Record<string, string> = {}
      testResp.headers.forEach((val, key) => {
        respHeaders[key] = val
      })

      return htmlResponse(
        testResultPartial({ status: testResp.status, headers: respHeaders, body: respBody, duration })
      )
    }).pipe(Effect.catchTag("UiError", (err) => Effect.succeed(htmlResponse(errorBox(err.message), err.status))))

  const requestDetail = (entryId: string): Effect.Effect<Response> =>
    Effect.gen(function*() {
      const config = yield* currentConfig
      const entry = yield* deps.requestLogger.getEntryById(deps.id, entryId)
      if (entry === null) {
        return htmlResponse(requestNotFoundPage(config, entryId), 404)
      }
      const stubs = yield* Ref.get(deps.stubsRef)
      const matchedStub = stubs.find((s) => s.id === entry.response.matchedStubId) ?? null
      return htmlResponse(requestDetailPage({ config, entry, matchedStub }))
    })

  const rowContext: Effect.Effect<RowContext> = Ref.get(deps.stubsRef).pipe(
    Effect.map((stubs) => ({ stubs, protocol: deps.config.protocol }))
  )

  const loadLive: Effect.Effect<LiveData> = Effect.gen(function*() {
    const config = yield* currentConfig
    const stubs = yield* Ref.get(deps.stubsRef)
    const snapshot = yield* deps.metrics.getStats(deps.id)
    const unmatched = yield* deps.metrics.getUnmatched(deps.id)
    const nextIndex = new Map<string, number>()
    for (const stub of stubs) {
      const next = yield* deps.nextResponseIndex(stub)
      if (Option.isSome(next)) nextIndex.set(stub.id, next.value)
    }
    const nowMs = yield* Clock.currentTimeMillis
    return buildLiveData({ config, stubs, snapshot, unmatched, nextIndex, nowMs })
  })

  // Newest first
  const recentRows: Effect.Effect<ReadonlyArray<RequestLogEntry>> = deps.requestLogger
    .getEntries(deps.id, { limit: RECENT_ROWS })
    .pipe(Effect.map((entries) => entries.slice().reverse()))

  const livePageResponse = (request: Request): Effect.Effect<Response> =>
    Effect.gen(function*() {
      const data = yield* loadLive
      const recent = yield* recentRows
      const adminUiUrl = deps.adminPort === undefined
        ? undefined
        : `http://${browserHost(request)}:${String(deps.adminPort)}/_ui`
      return pageResponse(livePage(data, {
        theme: themeFromCookie(request.headers.get("cookie")),
        recent,
        ...(adminUiUrl !== undefined ? { adminUiUrl } : {})
      }))
    })

  // Server-sent events: one `request` event per logged request, carrying its row's HTML. It
  // subscribes before the first line goes out, so a request sent once the stream has opened is
  // never missed. It ends when the client goes away (the server cancels the body) or when this
  // run stops (`shutdown`), whichever comes first.
  const events = (): Response => {
    const opening = Sse.encoder.write(new Sse.Retry({ duration: RECONNECT, lastEventId: undefined }))
    const stream = Stream.unwrap(Effect.gen(function*() {
      const entries = yield* deps.requestLogger.follow(deps.id)
      const rows = entries.pipe(
        Stream.mapEffect((entry) =>
          rowContext.pipe(
            Effect.map((ctx) =>
              Sse.encoder.write({
                _tag: "Event",
                event: REQUEST_EVENT,
                id: entry.id,
                data: requestRow(entry, ctx).value
              })
            )
          )
        )
      )
      const heartbeats = Stream.tick(HEARTBEAT).pipe(Stream.map(() => ": heartbeat\n\n"))
      return Stream.concat(Stream.succeed(opening), Stream.merge(rows, heartbeats))
    })).pipe(Stream.interruptWhen(deps.shutdown), Stream.encodeText)
    return new Response(Stream.toReadableStream(stream), { headers: EVENT_STREAM_HEADERS })
  }

  const route = (request: Request, url: URL): Effect.Effect<Response, UiError> => {
    const path = url.pathname.slice(ADMIN_PREFIX.length) || "/"
    const method = request.method.toUpperCase()

    const asset = assetRoute(request, path)
    if (asset !== null) return Effect.succeed(asset)

    if (method === "GET" && path === "/favicon.svg") return Effect.succeed(faviconResponse())

    // Every change goes through a form post or an htmx request; a page on another site must not send one
    if (method !== "GET" && method !== "HEAD" && isCrossSite(request)) return Effect.succeed(crossSiteRefusal())

    if (method === "GET" && path === "/") return livePageResponse(request)

    if (method === "GET" && path === "/events") return Effect.sync(events)

    if (method === "GET" && path === "/fragments/live") {
      return loadLive.pipe(Effect.map((data) => pageResponse(liveFragment(data))))
    }

    if (method === "GET" && path === "/fragments/requests") {
      return Effect.all([recentRows, rowContext]).pipe(
        Effect.map(([entries, ctx]) => pageResponse(requestRows(entries, ctx)))
      )
    }

    if (method === "GET" && path === "/stubs") {
      return Effect.gen(function*() {
        const config = yield* currentConfig
        const stubs = yield* Ref.get(deps.stubsRef)
        const draft = draftFromQuery(url.searchParams)
        return htmlResponse(stubsPage({ config, stubs, ...(draft !== null ? { draft } : {}) }))
      })
    }

    if (method === "POST" && path === "/stubs") return addStub(request)

    const stubId = parseStubIdFromPath(path)
    if (method === "DELETE" && stubId !== null) return deleteStub(stubId)
    if (method === "PUT" && stubId !== null) return updateStub(request, stubId)

    if (method === "GET" && path === "/requests") {
      return Effect.gen(function*() {
        const config = yield* currentConfig
        const entries = yield* deps.requestLogger.getEntries(deps.id, { limit: 100 })
        return htmlResponse(requestsPage({ config, entries }))
      })
    }

    if (method === "GET" && path === "/requests/list") return listRequests(url.searchParams)

    if (method === "POST" && path === "/requests/test") return sendTestRequest(request)

    if (method === "DELETE" && path === "/requests") {
      return deps.requestLogger.clear(deps.id).pipe(Effect.as(htmlResponse(requestTablePartial([]))))
    }

    const detailMatch = /^\/requests\/([^/]+)$/.exec(path)
    if (method === "GET" && detailMatch?.[1] !== undefined) return requestDetail(detailMatch[1])

    return Effect.succeed(htmlResponse(html`<h1>Not Found</h1>`, 404))
  }

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    // Only the prefix itself or a path under it: /_admin-api and the like belong to the stubs
    if (url.pathname !== ADMIN_PREFIX && !url.pathname.startsWith(`${ADMIN_PREFIX}/`)) return null
    return deps.runPromise(
      route(request, url).pipe(
        Effect.catchTag("UiError", (err) => Effect.succeed(errorResponse(err.message, err.status)))
      )
    )
  }
}
