import * as DateTime from "effect/DateTime"
import type { RequestLogEntry } from "../../schemas/RequestLogSchema.js"
import type { Stub } from "../../schemas/StubSchema.js"
import type { LoggedEntry } from "../../services/RequestLogger.js"
import { HOT_SERVER_ERROR_RATE } from "../admin/OverviewData.js"
import { ago, clockTime, count, decimal, millis, ms, NONE } from "../components/format.js"
import { imposterHeader, STUB_COUNT_ID } from "../components/imposterHeader.js"
import { icons, linkButton, tabCount } from "../components/primitives.js"
import { shell } from "../components/shell.js"
import { sparkline } from "../components/sparkline.js"
import { concat, html, type SafeHtml } from "../html.js"
import {
  type LiveData,
  nextResponseText,
  responseHitsText,
  type StubHits,
  stubLabel,
  stubPath,
  type UnmatchedRow
} from "../LiveData.js"
import { draftStubUrl } from "../stubDraft.js"
import type { Theme } from "../theme.js"

/**
 * An imposter's live page (`/_admin`): its numbers, the requests as they arrive (server-sent
 * events), each stub's hits with the response it gives next, and what no stub matched. The
 * numbers and panels are polled; the request list is streamed.
 */

export const EVENTS_URL = "/_admin/events"
// The SSE event each logged request is sent as
export const REQUEST_EVENT = "request"
export const LIVE_FRAGMENT_URL = "/_admin/fragments/live"
export const RECENT_FRAGMENT_URL = "/_admin/fragments/requests"
// Rows the list keeps, and the page and a reconnect start with
export const RECENT_ROWS = 20
const STATS_ID = "live-stats"
const SIDE_ID = "live-side"
const ROWS_ID = "live-rows"
// The panels re-fetch at most once a second while requests arrive, and every 10 s when it is quiet
const POLL_IDLE_MS = 10_000
const POLL_THROTTLE_MS = 1_000
// Unmatched groups listed before "and N more"
const UNMATCHED_SHOWN = 8

// ---------------------------------------------------------------- request rows

/** What a request row needs besides the entry: the current stubs, for "#1 /orders" */
export interface RowContext {
  readonly stubs: ReadonlyArray<Stub>
  readonly protocol: string
}

const METHOD_CLASS: Readonly<Record<string, string>> = {
  GET: "m-get",
  HEAD: "m-get",
  POST: "m-post",
  PUT: "m-put",
  PATCH: "m-put",
  DELETE: "m-delete"
}

/** A method's colour class: GET lime, POST teal, PUT and PATCH amber, DELETE red */
export const methodClass = (method: string): string => METHOD_CLASS[method.toUpperCase()] ?? "c-text-2"

/** A status's colour class: 5xx red, 4xx amber, else lime */
export const statusClass = (status: number): string => status >= 500 ? "c-error" : status >= 400 ? "c-caution" : "c-ok"

// Which stub answered, "no match", the proxy, or the extension (by its protocol)
const answeredBy = (entry: RequestLogEntry, ctx: RowContext): SafeHtml => {
  switch (entry.response.outcome) {
    case "stub": {
      const position = ctx.stubs.findIndex((stub) => stub.id === entry.response.matchedStubId)
      const stub = ctx.stubs[position]
      return stub === undefined
        ? html`<span class="req-stub ellipsis c-muted">removed stub</span>`
        : html`<span class="req-stub ellipsis c-text-2">#${position + 1} ${stubPath(stub)}</span>`
    }
    case "extension":
      return html`<span class="req-stub ellipsis c-info">${ctx.protocol}</span>`
    case "proxy":
      return html`<span class="req-stub ellipsis c-info">proxy</span>`
    case "unmatched":
      return html`<span class="req-stub ellipsis c-caution">no match</span>`
  }
}

const queryString = (query: Readonly<Record<string, string>>): string => {
  const params = new URLSearchParams(query).toString()
  return params === "" ? "" : `?${params}`
}

/**
 * One request, linking to its detail page; also what each SSE event carries. `seq` (the log's
 * sequence number) lets ui.js keep the list in log order whatever order the rows arrive in.
 */
export const requestRow = (entry: RequestLogEntry, ctx: RowContext, seq?: number): SafeHtml => {
  const method = entry.request.method.toUpperCase()
  const fullPath = `${entry.request.path}${queryString(entry.request.query)}`
  return html`<a class="req req-row" id="req-${entry.id}"${
    seq === undefined ? html`` : html` data-seq="${seq}"`
  } href="/_admin/requests/${encodeURIComponent(entry.id)}"><span class="req-time c-muted">${
    clockTime(DateTime.toEpochMillis(entry.timestamp))
  }</span><span class="req-method ${
    methodClass(method)
  }">${method}</span><span class="req-path ellipsis" title="${fullPath}">${entry.request.path}</span><span class="req-status num ${
    statusClass(entry.response.status)
  }">${entry.response.status}</span>${answeredBy(entry, ctx)}<span class="req-ms num ${
    entry.duration >= 1000 ? "c-warn" : "c-muted"
  }">${ms(entry.duration)}</span></a>`
}

/** Newest first; nothing at all when there are none, so the list is `:empty` */
export const requestRows = (rows: ReadonlyArray<LoggedEntry>, ctx: RowContext): SafeHtml =>
  concat(rows.map((row) => requestRow(row.entry, ctx, row.seq)))

// ---------------------------------------------------------------- stats

const statCard = (label: string, value: SafeHtml, wide = false): SafeHtml =>
  html`<div class="panel stat${wide ? " stat-wide" : ""}"><span class="label">${label}</span>${value}</div>`

// `oob` marks it for an answer, whose swap replaces the page's by id
const stats = (data: LiveData, oob: boolean): SafeHtml => {
  const s = data.stats
  const traffic = s.totalRequests > 0
  const hot = traffic && s.serverErrorRate >= HOT_SERVER_ERROR_RATE
  const latency = s.p50 !== undefined && s.p95 !== undefined && s.p99 !== undefined
    ? html`${millis(s.p50)} · ${millis(s.p95)} · ${millis(s.p99)} <span class="stat-unit">ms</span>`
    : html`${NONE}`
  return html`<section class="stats stats-4" id="${STATS_ID}" aria-label="Stats"${oob ? html` data-oob` : html``}>
  ${
    statCard(
      "req / min",
      html`<div class="stat-line"><span class="stat-value">${decimal(s.perMinute)}</span>${
        sparkline({ values: s.timeline, width: 120, height: 30, tone: s.last15.requests > 0 ? "on" : "off" })
      }</div>`
    )
  }
  ${
    statCard(
      "5xx",
      html`<span class="stat-value${hot ? " c-warn" : ""}">${
        traffic ? `${(s.serverErrorRate * 100).toFixed(1)}%` : NONE
      }</span>`
    )
  }
  ${statCard("latency p50 · p95 · p99", html`<span class="stat-value stat-value-sm">${latency}</span>`, true)}
  ${statCard("total · since start", html`<span class="stat-value">${count(s.totalRequests)}</span>`)}
</section>`
}

// ---------------------------------------------------------------- stub hits

const meterTone = (status: number): string =>
  status >= 500 ? "meter-warn" : status >= 400 ? "meter-caution" : "meter-ok"

// Each response's share of every stub hit, so the bars compare across stubs
const meter = (row: StubHits, allHits: number): SafeHtml =>
  html`<div class="meter" aria-hidden="true">${
    concat(row.stub.responses.map((response, i) => {
      const hits = row.byResponse[i] ?? 0
      if (hits === 0 || allHits === 0) return html``
      const width = `${((hits / allHits) * 100).toFixed(2)}%`
      return html`<span class="${meterTone(response.status)}" style="width: ${width}"></span>`
    }))
  }</div>`

// The next response stays on one line, so "next: 200" never splits
const nextLine = (row: StubHits): SafeHtml => {
  const next = nextResponseText(row)
  return next === undefined ? html`` : html` · <span class="nowrap">${next}</span>`
}

const hitRow = (row: StubHits, allHits: number): SafeHtml =>
  html`<li class="hit">
  <div class="hit-head"><span class="hit-name ellipsis">#${row.position} ${
    stubLabel(row.stub)
  }</span><span class="num hit-count">${count(row.hits)}</span></div>
  ${meter(row, allHits)}
  <span class="label">${responseHitsText(row)}${nextLine(row)}</span>
</li>`

const stubHitsPanel = (data: LiveData): SafeHtml => {
  const allHits = data.stubHits.reduce((sum, row) => sum + row.hits, 0)
  return html`<section class="panel" aria-labelledby="hits-title">
  <div class="bar"><h2 class="title" id="hits-title">stub hits</h2><a class="label c-ok" href="/_admin/stubs">edit stubs →</a></div>
  ${
    data.stubHits.length === 0
      ? html`<div class="pad"><p class="label panel-note">no stubs yet: <a href="/_admin/stubs">add one</a>, or POST /imposters/:id/stubs</p></div>`
      : html`<ol class="hits">${concat(data.stubHits.map((row) => hitRow(row, allHits)))}</ol>`
  }
</section>`
}

// ---------------------------------------------------------------- unmatched

const unmatchedRow = (row: UnmatchedRow, nowMs: number): SafeHtml => {
  const line = `${row.method} ${row.path}`
  return html`<li class="item">
  <div class="stack"><span class="item-line ellipsis" title="${line}">${line}</span><span class="label">× ${
    count(row.count)
  } · last ${ago(row.lastSeenAt, nowMs)}</span></div>
  ${linkButton({ href: draftStubUrl(row.method, row.path), label: "stub it", ariaLabel: `Stub ${line}` })}
</li>`
}

// An extension or a proxy answers every request no stub matches, so none is ever left unmatched
const answeredInstead = (data: LiveData): string | undefined =>
  data.config.protocol !== "HTTP"
    ? `the ${data.config.protocol} extension answers what no stub matches`
    : data.config.proxy !== undefined
    ? "the proxy answers what no stub matches"
    : undefined

const unmatchedPanel = (data: LiveData): SafeHtml => {
  const instead = answeredInstead(data)
  if (instead !== undefined) {
    return html`<section class="panel" aria-labelledby="unmatched-title">
  <div class="bar"><h2 class="title" id="unmatched-title">no stub matched</h2></div>
  <div class="pad"><p class="label panel-note">${instead}</p></div>
</section>`
  }
  const total = data.unmatched.reduce((sum, row) => sum + row.count, 0)
  const shown = data.unmatched.slice(0, UNMATCHED_SHOWN)
  const more = data.unmatched.length - shown.length
  if (total === 0) {
    return html`<section class="panel" aria-labelledby="unmatched-title">
  <div class="bar"><h2 class="title" id="unmatched-title">no stub matched · 0</h2><span class="label">answered 404</span></div>
  <div class="pad"><p class="label panel-note">${
      data.stats.totalRequests > 0 ? "nothing unmatched" : "nothing to match yet"
    }</p></div>
</section>`
  }
  return html`<section class="panel panel-caution" aria-labelledby="unmatched-title">
  <div class="bar"><h2 class="title c-caution" id="unmatched-title">no stub matched · ${
    count(total)
  }</h2><span class="label">answered 404</span></div>
  <ul class="list">${concat(shown.map((row) => unmatchedRow(row, data.nowMs)))}</ul>${
    more > 0 ? html`<p class="label pad panel-note">and ${count(more)} more</p>` : html``
  }
</section>`
}

// ---------------------------------------------------------------- fragments and page

const side = (data: LiveData): SafeHtml => html`${stubHitsPanel(data)}${unmatchedPanel(data)}`

/** What the poll answers with: the side panels, plus the stats and the stubs tab's count out of band */
export const liveFragment = (data: LiveData): SafeHtml =>
  html`${side(data)}${stats(data, true)}${tabCount(data.stubs.length, STUB_COUNT_ID, true)}`

export interface LivePageOpts {
  readonly theme: Theme | null
  // Newest first
  readonly recent: ReadonlyArray<LoggedEntry>
  readonly adminUiUrl?: string
}

export const livePage = (data: LiveData, opts: LivePageOpts): SafeHtml => {
  const { config } = data
  const header = imposterHeader({
    name: config.name,
    port: config.port,
    protocol: config.protocol,
    running: config.status === "running",
    ...(config.proxy !== undefined ? { proxyMode: config.proxy.mode } : {}),
    stubCount: data.stubs.length,
    current: "live",
    ...(opts.adminUiUrl !== undefined ? { adminUiUrl: opts.adminUiUrl } : {})
  })
  const rowContext: RowContext = { stubs: data.stubs, protocol: config.protocol }
  const body = html`${header}
<main class="main">
  ${stats(data, false)}
  <div class="live-grid">
    <section class="panel live-requests" aria-labelledby="requests-title">
      <div class="bar">
        <div class="bar-title"><span class="live" aria-hidden="true"></span><h2 class="title" id="requests-title">live requests</h2><span class="label">newest first · UTC</span></div>
        <div class="bar-actions">
          <button class="btn" type="button" data-sse-pause="#${ROWS_ID}" aria-pressed="false" aria-label="Pause the stream"><span class="when-live">${icons.pause}pause</span><span class="when-paused">${icons.play}resume · <span data-sse-count>0</span> new</span></button>
          ${linkButton({ href: "/_admin/requests", label: "all requests →" })}
        </div>
      </div>
      <div class="req req-head" aria-hidden="true"><span>time</span><span>method</span><span>path</span><span class="num-head">status</span><span>stub</span><span class="num-head">duration</span></div>
      <div class="req-rows" id="${ROWS_ID}" data-sse="${EVENTS_URL}" data-sse-event="${REQUEST_EVENT}" data-sse-reload="${RECENT_FRAGMENT_URL}" data-sse-max="${RECENT_ROWS}">${
    requestRows(opts.recent, rowContext)
  }</div>
      <p class="rows-empty label">waiting for requests to :${config.port}; they appear here as they arrive</p>
    </section>
    <div class="live-side" id="${SIDE_ID}" data-poll="${POLL_IDLE_MS}" data-poll-throttle="${POLL_THROTTLE_MS}" data-url="${LIVE_FRAGMENT_URL}">
      ${side(data)}
    </div>
  </div>
</main>`
  return shell({ title: `${config.name} · live`, prefix: "/_admin", theme: opts.theme }, body)
}
