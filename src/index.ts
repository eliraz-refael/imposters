export * as AdminApi from "./api/AdminApi.js"

export * as ApiErrors from "./api/ApiErrors.js"

export * as ApiSchemas from "./api/ApiSchemas.js"

/**
 * The API's statistics: the metrics snapshot, with a row for every current stub (in matching
 * order, zeros if it has not been hit) carrying the response it gives next.
 */
export * as Conversions from "./api/Conversions.js"

export * as ImpostersGroup from "./api/ImpostersGroup.js"

export * as ImpostersHandlers from "./api/ImpostersHandlers.js"

export * as SystemGroup from "./api/SystemGroup.js"

export * as SystemHandlers from "./api/SystemHandlers.js"

export * as ConfigLoader from "./cli/ConfigLoader.js"

export * as version from "./cli/version.js"

export * as HandlerHttpClient from "./client/HandlerHttpClient.js"

export * as ImpostersClient from "./client/ImpostersClient.js"

export * as testing from "./client/testing.js"

/**
 * Parses and validates imposter creation request
 */
export * as imposter from "./domain/imposter.js"

/**
 * Parses and validates route creation request
 */
export * as route from "./domain/route.js"

/**
 * The imposter extension point: how a protocol other than plain HTTP is plugged in.
 *
 * An extension lives in its own folder, `src/extensions/<name>/`, and is attached in one
 * place, the extension list in `src/cli/Commands.ts`. The core only knows this module.
 */
export * as Extension from "./extensions/Extension.js"

export * as ApiLayer from "./layers/ApiLayer.js"

export * as MainLayer from "./layers/MainLayer.js"

export * as Explain from "./matching/Explain.js"

/**
 * Extract expression content from a ${...} pattern using brace-depth counting.
 * Returns [expressionContent, endIndex] or null if no valid expression found.
 */
export * as ExpressionEvaluator from "./matching/ExpressionEvaluator.js"

/**
 * What a candidate stub would catch of the given request groups: `matched` and `total` sum the
 * groups' counts, and `sample` is the candidate answering the first group it matches. A predicate
 * that would throw at runtime (an invalid regex) counts as no match and is reported in `error`.
 */
export * as Preview from "./matching/Preview.js"

/**
 * Strict UTF-8 decode: `undefined` when the bytes are not valid UTF-8, i.e. binary.
 * `partial` tolerates a multi-byte character cut off at the end, for decoding a truncated prefix.
 */
export * as RequestMatcher from "./matching/RequestMatcher.js"

export * as ResponseGenerator from "./matching/ResponseGenerator.js"

export * as TemplateEngine from "./matching/TemplateEngine.js"

export * as ImposterRepository from "./repositories/ImposterRepository.js"

export * as ConfigFileSchema from "./schemas/ConfigFileSchema.js"

export * as ExplainSchema from "./schemas/ExplainSchema.js"

export * as ImposterSchema from "./schemas/ImposterSchema.js"

export * as RequestLogSchema from "./schemas/RequestLogSchema.js"

export * as StubSchema from "./schemas/StubSchema.js"

export * as common from "./schemas/common.js"

export * as AdminPort from "./server/AdminPort.js"

export * as AdminServer from "./server/AdminServer.js"

export * as FiberManager from "./server/FiberManager.js"

/**
 * Adds, edits or removes a stub: writes the repository, hot-reloads a running imposter, and
 * resets what the change invalidates. Removing a stub, or an edit that changes its responses or
 * responseMode, resets that stub's hit counters and response cycle; a predicate-only edit keeps both.
 */
export * as ImposterServer from "./server/ImposterServer.js"

/**
 * Reads a response once for the request log, and hands back a fresh copy to send.
 * Bodies are handled as bytes, so binary responses (images, archives) pass through untouched.
 */
export * as ResponseCapture from "./server/ResponseCapture.js"

/**
 * The address to bind: the --host flag, else IMPOSTERS_HOST, else the default. A blank one is
 * skipped, because listen() given an empty address takes every interface.
 */
export * as ServerFactory from "./server/ServerFactory.js"

/**
 * Whether an edit changed what the stub answers (its responses or how it cycles them). Such an
 * edit restarts the stub's hit counters and response cycle; a predicate-only edit keeps both.
 */
export * as StubChange from "./server/StubChange.js"

export * as AppConfig from "./services/AppConfig.js"

/**
 * Adds `delta` to the bucket holding `atMs`. A stale slot is recycled; a record older than
 * what its slot now holds (it fell out of the window while in flight) is dropped.
 */
export * as MetricsAggregates from "./services/MetricsAggregates.js"

export * as MetricsService from "./services/MetricsService.js"

export * as PortAllocator from "./services/PortAllocator.js"

export * as ProxyService from "./services/ProxyService.js"

export * as RequestLogger from "./services/RequestLogger.js"

export * as Uuid from "./services/Uuid.js"

export * as UuidLive from "./services/UuidLive.js"

/**
 * What an imposter's live page (`/_admin`) shows, built from its metrics by pure functions, so
 * the page template only formats.
 */
export * as LiveData from "./ui/LiveData.js"

export * as UiRouter from "./ui/UiRouter.js"

export * as AdminUiRouter from "./ui/admin/AdminUiRouter.js"

/**
 * What the /_ui overview shows, read from the admin API's JSON (`GET /imposters?stats=true`,
 * `/health`, `/info`) and summarised by pure functions, so the page template only formats.
 */
export * as OverviewData from "./ui/admin/OverviewData.js"

/**
 * The /_ui overview: every imposter with its last 15 minutes of traffic, the start/stop/delete
 * actions, and the create form. The page polls its live region; forms work without JS.
 */
export * as Overview from "./ui/admin/pages/Overview.js"

/**
 * How the UIs print numbers and times. Pure: anything relative takes `now` as an argument, so a
 * page reads the clock once (through the admin API) and every row agrees.
 */
export * as format from "./ui/components/format.js"

/**
 * The page header's pieces: the mark, the wordmark, the theme toggle and the live label.
 */
export * as header from "./ui/components/header.js"

/**
 * The header of an imposter's own pages (`/_admin` on its port): the mark back to the admin UI,
 * the imposter's name, port and state, and the page tabs.
 */
export * as imposterHeader from "./ui/components/imposterHeader.js"

/**
 * The UIs' small building blocks, on the classes in ui-assets/ui.css. Every interpolation goes
 * through `html`, so names and paths from user config are escaped wherever these render.
 */
export * as primitives from "./ui/components/primitives.js"

/**
 * A redesigned page's document: the self-hosted stylesheet, fonts, script and icon, and the
 * theme rendered on <html> so the first paint is already in it. No CDN.
 */
export * as shell from "./ui/components/shell.js"

/**
 * Trend lines: a pure `points()` and the inline SVG that draws it.
 */
export * as sparkline from "./ui/components/sparkline.js"

/**
 * The cross-site guard both web UIs (`/_ui` and every imposter's `/_admin`) put in front of the
 * requests that change state.
 */
export * as crossSite from "./ui/crossSite.js"

export * as favicon from "./ui/favicon.js"

export * as html from "./ui/html.js"

export * as htmx from "./ui/htmx.js"

export * as layout from "./ui/layout.js"

/**
 * An imposter's live page (`/_admin`): its numbers, the requests as they arrive (server-sent
 * events), each stub's hits with the response it gives next, and what no stub matched. The
 * numbers and panels are polled; the request list is streamed.
 */
export * as live from "./ui/pages/live.js"

export * as requests from "./ui/pages/requests.js"

export * as stubs from "./ui/pages/stubs.js"

/**
 * "Stub it": a draft stub for a request no stub matched, which the stubs page offers in its add
 * form. Pure, and in the encoded (JSON) shape, since that is what the form shows and posts.
 */
export * as stubDraft from "./ui/stubDraft.js"

export * as theme from "./ui/theme.js"
