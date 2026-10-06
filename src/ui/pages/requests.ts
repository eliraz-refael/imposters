import type { ImposterConfig } from "../../domain/imposter.js"
import type { RequestLogEntry } from "../../schemas/RequestLogSchema.js"
import type { Stub } from "../../schemas/StubSchema.js"
import { MAX_ENTRIES } from "../../services/RequestLogger.js"
import { count, plural } from "../components/format.js"
import { imposterHeader } from "../components/imposterHeader.js"
import { linkButton, postButton } from "../components/primitives.js"
import { shell } from "../components/shell.js"
import { concat, html, type SafeHtml } from "../html.js"
import { isFiltered, type ParsedFilters } from "../RequestsData.js"
import type { Theme } from "../theme.js"
import { requestRow, type RowContext } from "./live.js"

/**
 * An imposter's request log (`/_admin/requests`): every logged request, newest first, in the
 * live view's rows, each linking to its page; filters by method, path and status; clearing the
 * log; and a form that sends a request to the imposter. Every form works without JS: the filters
 * are a GET, clearing and sending are POSTs answered with a 303 (sending, to the new request's page).
 */

export const REQUESTS_URL = "/_admin/requests"
export const CLEAR_URL = "/_admin/requests/clear"
export const SEND_URL = "/_admin/requests/test"
// The request log keeps this many entries per imposter
export const LOG_SIZE = MAX_ENTRIES

/** A logged request's page */
export const requestUrl = (id: string): string => `${REQUESTS_URL}/${encodeURIComponent(id)}`

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
const CONTENT_TYPES = ["application/json", "text/plain", "application/x-www-form-urlencoded", "application/xml"]

const option = (value: string, label: string, selected: boolean): SafeHtml =>
  html`<option value="${value}"${selected ? html` selected` : html``}>${label}</option>`

const filterForm = (parsed: ParsedFilters): SafeHtml => {
  const { fields } = parsed
  // A method the select does not offer (typed into the URL) is still shown as the one filtered by
  const methods = fields.method === "" || METHODS.includes(fields.method) ? METHODS : [...METHODS, fields.method]
  return html`<form class="panel filters" method="get" action="${REQUESTS_URL}" aria-label="Filter requests">
  <div class="field"><label class="label" for="filter-method">method</label><select class="input" id="filter-method" name="method">${
    option("", "any", fields.method === "")
  }${concat(methods.map((m) => option(m, m, m === fields.method)))}</select></div>
  <div class="field filter-path"><label class="label" for="filter-path">path</label><input class="input" id="filter-path" name="path" type="text" value="${fields.path}" placeholder="/orders" autocomplete="off" spellcheck="false"></div>
  <div class="field filter-status"><label class="label" for="filter-status">status</label><input class="input" id="filter-status" name="status" type="text" inputmode="numeric" value="${fields.status}" placeholder="503" autocomplete="off"${
    parsed.error === undefined ? html`` : html` aria-invalid="true"`
  }></div>
  <div class="filter-actions"><button class="btn" type="submit">filter</button>${
    isFiltered(parsed.filters) || parsed.error !== undefined
      ? linkButton({ href: REQUESTS_URL, label: "show all" })
      : html``
  }</div>
</form>`
}

/** What the send form held, to show it again after a refused send (without JS) */
export interface SendForm {
  readonly method: string
  readonly path: string
  readonly contentType: string
  readonly headers: string
  readonly body: string
}

const EMPTY_SEND: SendForm = { method: "GET", path: "/", contentType: "application/json", headers: "", body: "" }

const sendPanel = (form: SendForm, error: string | undefined): SafeHtml =>
  html`<details class="panel send"${error === undefined ? html`` : html` open`}>
  <summary class="bar send-bar"><h2 class="title">send a request</h2><span class="label">to this imposter, logged like any other; opens its page</span></summary>
  <form class="send-form" method="post" action="${SEND_URL}" data-action>
    <div class="send-line">
      <div class="field"><label class="label" for="send-method">method</label><select class="input" id="send-method" name="method">${
    concat(METHODS.map((m) => option(m, m, m === form.method)))
  }</select></div>
      <div class="field send-path"><label class="label" for="send-path">path</label><input class="input" id="send-path" name="path" type="text" value="${form.path}" placeholder="/orders?status=open" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label class="label" for="send-type">content type</label><select class="input" id="send-type" name="contentType">${
    concat(CONTENT_TYPES.map((t) => option(t, t, t === form.contentType)))
  }</select></div>
    </div>
    <div class="field"><label class="label" for="send-headers">headers · one per line, name: value</label><textarea class="input code-input" id="send-headers" name="headers" rows="2" placeholder="authorization: Bearer token123" spellcheck="false">
${form.headers}</textarea></div>
    <div class="field"><label class="label" for="send-body">body · not sent with GET or HEAD</label><textarea class="input code-input" id="send-body" name="body" rows="4" placeholder='{ "key": "value" }' spellcheck="false">
${form.body}</textarea></div>
    <div class="alert" data-error-slot>${error ?? ""}</div>
    <div class="send-foot"><button class="btn btn-accent" type="submit">send</button></div>
  </form>
</details>`

const listTitle = (shown: number, total: number, filtered: boolean): string =>
  filtered ? `${count(shown)} of ${plural(total, "request")}` : plural(total, "request")

export interface RequestsPageData {
  readonly config: ImposterConfig
  readonly stubs: ReadonlyArray<Stub>
  // Newest first, filtered
  readonly entries: ReadonlyArray<RequestLogEntry>
  // Every entry the log holds
  readonly total: number
  readonly filters: ParsedFilters
}

export interface RequestsPageOpts {
  readonly theme: Theme | null
  readonly adminUiUrl?: string
  // A refused send without JS: the form as posted, and why
  readonly send?: { readonly form: SendForm; readonly error: string }
}

/** The header of the requests pages: the imposter, with the requests tab current */
export const requestsHeader = (config: ImposterConfig, stubCount: number, adminUiUrl: string | undefined): SafeHtml =>
  imposterHeader({
    name: config.name,
    port: config.port,
    protocol: config.protocol,
    running: config.status === "running",
    ...(config.proxy !== undefined ? { proxyMode: config.proxy.mode } : {}),
    stubCount,
    current: "requests",
    ...(adminUiUrl !== undefined ? { adminUiUrl } : {})
  })

export const requestsPage = (data: RequestsPageData, opts: RequestsPageOpts): SafeHtml => {
  const { config } = data
  const header = requestsHeader(config, data.stubs.length, opts.adminUiUrl)
  const ctx: RowContext = { stubs: data.stubs, protocol: config.protocol }
  const filtered = isFiltered(data.filters.filters)
  const empty = data.total === 0
    ? `nothing logged yet: requests to :${String(config.port)} appear here`
    : "no logged request matches these filters"
  const body = html`${header}
<main class="main">
  <div class="requests-head">
    <div class="stack page-head"><h2 class="page-title">requests</h2><span class="label">newest first · UTC · the log keeps the last ${LOG_SIZE}, from this start</span></div>
    <div class="bar-actions">${
    postButton({
      action: CLEAR_URL,
      label: "clear log",
      variant: "danger",
      confirm: "Clear this imposter's request log?"
    })
  }</div>
  </div>
  <div class="alert" data-error-slot>${data.filters.error ?? ""}</div>
  ${sendPanel(opts.send?.form ?? EMPTY_SEND, opts.send?.error)}
  ${filterForm(data.filters)}
  <section class="panel" aria-labelledby="log-title">
    <div class="bar"><h2 class="title" id="log-title">${
    listTitle(data.entries.length, data.total, filtered)
  }</h2><a class="label c-ok" href="/_admin">live view →</a></div>
    <div class="req req-head" aria-hidden="true"><span>time</span><span>method</span><span>path</span><span class="num-head">status</span><span>stub</span><span class="num-head">duration</span></div>
    <div class="req-list">${concat(data.entries.map((entry) => requestRow(entry, ctx)))}</div>
    <p class="rows-empty label">${empty}</p>
  </section>
</main>`
  return shell({ title: `${config.name} · requests`, prefix: "/_admin", theme: opts.theme }, body)
}
