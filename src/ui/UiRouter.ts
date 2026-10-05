import * as Clock from "effect/Clock"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import * as Sse from "effect/unstable/encoding/Sse"
import type { ImposterConfig, ImposterNotFoundError } from "../domain/imposter.js"
import { contextFromCaptured } from "../matching/Explain.js"
import { previewStub } from "../matching/Preview.js"
import { findMatchingStub } from "../matching/RequestMatcher.js"
import type {
  ImposterRepositoryShape,
  StubIndexOutOfRangeError,
  StubNotFoundError
} from "../repositories/ImposterRepository.js"
import { NonEmptyString } from "../schemas/common.js"
import type { PreviewResponse } from "../schemas/ExplainSchema.js"
import type { CreateStubRequest, Stub } from "../schemas/StubSchema.js"
import { StubChange } from "../server/StubChange.js"
import type { MetricsServiceShape } from "../services/MetricsService.js"
import type { LoggedEntry, RequestLoggerShape } from "../services/RequestLogger.js"
import { assetRoute } from "./assets/serve.js"
import { browserHost, crossSiteRefusal, isCrossSite } from "./crossSite.js"
import { checkStubText, problemLines, type StubCheck } from "./editor/checkStub.js"
import { draftToText } from "./editor/draftText.js"
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
import {
  type EditorState,
  type EditorStatus,
  editorStatus,
  type InsertAt,
  stubEditor,
  STUBS_URL,
  stubsAnswer,
  stubsPage
} from "./pages/stubs.js"
import { requestTablePartial } from "./partials.js"
import { draftFromQuery, draftFromStub, starterDraft } from "./stubDraft.js"
import { buildStubsData, type StubsData } from "./StubsData.js"
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

const readForm = (request: Request): Effect.Effect<FormData, UiError> =>
  Effect.tryPromise({
    try: () => request.formData(),
    catch: () => new UiError({ message: "Expected a form submission.", status: 400 })
  })

// ui.js sends this with every data-action request: answer with a fragment, not a page
const FRAGMENT_HEADER = "x-imposters-fragment"

const isFragmentRequest = (request: Request): boolean => request.headers.get(FRAGMENT_HEADER) === "1"

// After a form post without JS: back to the page, as a GET
const seeOther = (location: string): Response => new Response(null, { status: 303, headers: { location, ...NO_STORE } })

const STUB_PATH = /^\/stubs\/([^/]+)$/
const STUB_DELETE_PATH = /^\/stubs\/([^/]+)\/delete$/

const decodeSegment = (segment: string | undefined): string | null => {
  if (segment === undefined) return null
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

// A failed editor action: the message, what to show the user (the problems, as HTML), and its status
interface EditorFailure {
  readonly status: number
  readonly message: string
  readonly check?: StubCheck
}

const insertAt = (value: string | undefined): InsertAt => value === "first" ? "first" : "last"

const sentenceList = (lines: ReadonlyArray<string>): SafeHtml =>
  html`<ul class="status-problems">${
    lines.map((line) => html`<li>${line}</li>`).reduce((a, b) => html`${a}${b}`, html``)
  }</ul>`

export const makeUiRouter = (deps: UiDeps) => {
  const currentConfig: Effect.Effect<ImposterConfig> = deps.repo.get(deps.id).pipe(
    Effect.map((record) => record.config),
    Effect.catch(() => Effect.succeed(deps.config))
  )

  // ---------------------------------------------------------------- stubs page

  const adminUiUrlFor = (request: Request): string | undefined =>
    deps.adminPort === undefined ? undefined : `http://${browserHost(request)}:${String(deps.adminPort)}/_ui`

  const loadStubs: Effect.Effect<StubsData> = Effect.suspend(() => loadLive).pipe(Effect.map(buildStubsData))

  // What a stub would answer of the traffic no stub answers now. When editing, the stub under
  // edit is left out: the question is what it would catch as it is written now.
  const previewFor = (stub: CreateStubRequest, editing: string | undefined): Effect.Effect<PreviewResponse> =>
    Effect.gen(function*() {
      const others = (yield* Ref.get(deps.stubsRef)).filter((s) => s.id !== editing)
      const groups = (yield* deps.metrics.getUnmatched(deps.id)).filter((group) =>
        findMatchingStub(contextFromCaptured(group.sample.request), others) === undefined
      )
      return yield* previewStub(stub, groups)
    })

  const statusOf = (check: StubCheck, editing: string | undefined): Effect.Effect<EditorStatus> =>
    check._tag === "Valid"
      ? previewFor(check.stub, editing).pipe(Effect.map((preview) => ({ check, preview })))
      : Effect.succeed({ check })

  const statusFor = (text: string, editing: string | undefined): Effect.Effect<EditorStatus> =>
    checkStubText(text).pipe(Effect.flatMap((check) => statusOf(check, editing)))

  const newStubEditor = (focus: boolean): Effect.Effect<EditorState> => {
    const text = draftToText(starterDraft())
    return statusFor(text, undefined).pipe(Effect.map((status) => ({ text, insert: "last", status, focus })))
  }

  // The editor a URL asks for: `?edit=<id>`, `?draft=<method>&path=<path>` ("stub it"), or a new
  // stub. An edit of a stub that is gone is null.
  const editorFor = (params: URLSearchParams, focus: boolean): Effect.Effect<EditorState | null> =>
    Effect.gen(function*() {
      const editId = params.get("edit")
      if (editId !== null) {
        const stubs = yield* Ref.get(deps.stubsRef)
        const position = stubs.findIndex((stub) => stub.id === editId)
        const stub = stubs[position]
        if (stub === undefined) return null
        const text = draftToText(draftFromStub(stub))
        const status = yield* statusFor(text, stub.id)
        return { editing: { id: stub.id, position: position + 1 }, text, insert: "last", status, focus }
      }
      const draft = draftFromQuery(params)
      if (draft !== null) {
        const text = draftToText(draft.stub)
        const status = yield* statusFor(text, undefined)
        // A stub for one request goes before the broader ones
        return { text, insert: "first", from: { method: draft.method, path: draft.path }, status, focus }
      }
      return yield* newStubEditor(focus)
    })

  const stubsPageResponse = (
    request: Request,
    editor: EditorState,
    opts?: { readonly error?: string; readonly status?: number }
  ): Effect.Effect<Response> =>
    loadStubs.pipe(Effect.map((data) => {
      const adminUiUrl = adminUiUrlFor(request)
      return pageResponse(
        stubsPage(data, {
          theme: themeFromCookie(request.headers.get("cookie")),
          editor,
          ...(opts?.error !== undefined ? { error: opts.error } : {}),
          ...(adminUiUrl !== undefined ? { adminUiUrl } : {})
        }),
        opts?.status
      )
    }))

  const showStubsPage = (request: Request, url: URL): Effect.Effect<Response> =>
    Effect.gen(function*() {
      const editor = yield* editorFor(url.searchParams, false)
      if (editor !== null) return yield* stubsPageResponse(request, editor)
      const fresh = yield* newStubEditor(false)
      return yield* stubsPageResponse(request, fresh, {
        error: "That stub no longer exists; it may have been deleted elsewhere.",
        status: 404
      })
    })

  const editorFragment = (url: URL): Effect.Effect<Response> =>
    editorFor(url.searchParams, true).pipe(Effect.map((editor) =>
      editor === null
        ? pageResponse(html`That stub no longer exists; it may have been deleted elsewhere.`, 404)
        : pageResponse(stubEditor(editor))
    ))

  const previewFragment = (request: Request): Effect.Effect<Response> =>
    Effect.gen(function*() {
      const form = yield* readForm(request).pipe(Effect.option)
      if (Option.isNone(form)) return pageResponse(html`Expected a form submission.`, 400)
      const editing = formString(form.value, "editing") || undefined
      const status = yield* statusFor(formString(form.value, "stub") ?? "", editing)
      return pageResponse(editorStatus(status))
    })

  // A successful change: the refreshed list with JS (and a fresh editor), else back to the page
  const changed = (request: Request): Effect.Effect<Response> =>
    isFragmentRequest(request)
      ? Effect.gen(function*() {
        const data = yield* loadStubs
        return pageResponse(stubsAnswer(data, yield* newStubEditor(false)))
      })
      : Effect.succeed(seeOther(STUBS_URL))

  // A refused add or save: the problems for the form's error slot with JS, else the page again
  // with the editor as it was posted
  const refused = (request: Request, failure: EditorFailure, editor: EditorState): Effect.Effect<Response> => {
    if (isFragmentRequest(request)) {
      const lines = failure.check === undefined ? [] : problemLines(failure.check)
      return Effect.succeed(
        pageResponse(html`${failure.message}${lines.length === 0 ? html`` : sentenceList(lines)}`, failure.status)
      )
    }
    return Effect.gen(function*() {
      const status = failure.check === undefined ? editor.status : yield* statusOf(failure.check, editor.editing?.id)
      return yield* stubsPageResponse(
        request,
        { ...editor, ...(status !== undefined ? { status } : {}), error: failure.message },
        { status: failure.status }
      )
    })
  }

  const postedStub = (request: Request): Effect.Effect<{ readonly text: string; readonly insert: InsertAt } | null> =>
    readForm(request).pipe(
      Effect.map((form) => ({
        text: formString(form, "stub") ?? "",
        insert: insertAt(formString(form, "position"))
      })),
      Effect.catch(() => Effect.succeed(null))
    )

  const notAForm = (request: Request): Effect.Effect<Response> =>
    isFragmentRequest(request)
      ? Effect.succeed(pageResponse(html`Expected a form submission.`, 400))
      : Effect.succeed(seeOther(STUBS_URL))

  const IMPOSTER_GONE = "This imposter no longer exists."

  const addStub = (request: Request): Effect.Effect<Response> =>
    Effect.gen(function*() {
      const posted = yield* postedStub(request)
      if (posted === null) return yield* notAForm(request)
      const editor: EditorState = { text: posted.text, insert: posted.insert }
      const check = yield* checkStubText(posted.text)
      if (check._tag !== "Valid") {
        return yield* refused(request, {
          status: 400,
          message: "The stub was not added: fix the problems above.",
          check
        }, editor)
      }
      const stub: Stub = { id: NonEmptyString.make(crypto.randomUUID().slice(0, 8)), ...check.stub }
      const added = yield* deps.applyStubChange(
        StubChange.Add({ stub, index: posted.insert === "first" ? 0 : undefined })
      ).pipe(Effect.result)
      if (added._tag === "Failure") return yield* refused(request, { status: 404, message: IMPOSTER_GONE }, editor)
      return yield* changed(request)
    })

  const saveStub = (request: Request, stubId: string): Effect.Effect<Response> =>
    Effect.gen(function*() {
      const posted = yield* postedStub(request)
      if (posted === null) return yield* notAForm(request)
      const stubs = yield* Ref.get(deps.stubsRef)
      const position = stubs.findIndex((stub) => stub.id === stubId) + 1
      const editor: EditorState = { editing: { id: stubId, position }, text: posted.text, insert: "last" }
      const check = yield* checkStubText(posted.text)
      if (check._tag !== "Valid") {
        return yield* refused(request, {
          status: 400,
          message: "The stub was not saved: fix the problems above.",
          check
        }, editor)
      }
      const saved = yield* deps.applyStubChange(StubChange.Update({ stubId, patch: check.stub })).pipe(Effect.result)
      if (saved._tag === "Failure") {
        const message = saved.failure._tag === "ImposterNotFoundError"
          ? IMPOSTER_GONE
          : "This stub no longer exists (deleted elsewhere?): copy your JSON and add it as a new stub."
        return yield* refused(request, { status: 404, message }, editor)
      }
      return yield* changed(request)
    })

  // Deleting a stub that is already gone leaves it gone: the list is refreshed either way
  const deleteStub = (request: Request, stubId: string): Effect.Effect<Response> =>
    deps.applyStubChange(StubChange.Remove({ stubId })).pipe(
      Effect.ignore,
      Effect.andThen(changed(request))
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
  const recentRows: Effect.Effect<ReadonlyArray<LoggedEntry>> = deps.requestLogger
    .getRecent(deps.id, RECENT_ROWS)
    .pipe(Effect.map((rows) => rows.slice().reverse()))

  const livePageResponse = (request: Request): Effect.Effect<Response> =>
    Effect.gen(function*() {
      const data = yield* loadLive
      const recent = yield* recentRows
      const adminUiUrl = adminUiUrlFor(request)
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
        Stream.mapEffect(({ entry, seq }) =>
          rowContext.pipe(
            Effect.map((ctx) =>
              Sse.encoder.write({
                _tag: "Event",
                event: REQUEST_EVENT,
                id: entry.id,
                data: requestRow(entry, ctx, seq).value
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

    if (method === "GET" && path === "/stubs") return showStubsPage(request, url)

    if (method === "GET" && path === "/fragments/stub-editor") return editorFragment(url)

    if (method === "POST" && path === "/stubs/preview") return previewFragment(request)

    if (method === "POST" && path === "/stubs") return addStub(request)

    const deleteId = decodeSegment(STUB_DELETE_PATH.exec(path)?.[1])
    if (method === "POST" && deleteId !== null) return deleteStub(request, deleteId)

    const stubId = decodeSegment(STUB_PATH.exec(path)?.[1])
    if (method === "POST" && stubId !== null) return saveStub(request, stubId)

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
