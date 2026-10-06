import type { ImposterConfig } from "../../domain/imposter.js"
import { dateTime, ms } from "../components/format.js"
import { linkButton, postButton } from "../components/primitives.js"
import { shell } from "../components/shell.js"
import { concat, html, type SafeHtml } from "../html.js"
import {
  type Answered,
  type BodyView,
  bytesText,
  type KeyValue,
  type RequestDetail,
  type StubRef,
  type StubVerdicts,
  type VerdictRow
} from "../RequestsData.js"
import type { Theme } from "../theme.js"
import { methodClass, statusClass } from "./live.js"
import { REQUESTS_URL, requestsHeader, requestUrl } from "./requests.js"

/**
 * One logged request (`/_admin/requests/:id`): what was asked and what was answered, which stub
 * (and which of its responses) answered, why the current stubs match it or not, and the
 * request again as a curl command (copied with data-copy) or replayed (a POST answered with a
 * 303 to the replay's own page).
 */

export const replayUrl = (id: string): string => `${requestUrl(id)}/replay`

const stubHref = (id: string): string => `/_admin/stubs#stub-${encodeURIComponent(id)}`
const editHref = (id: string): string => `/_admin/stubs?edit=${encodeURIComponent(id)}`

const stubLink = (ref: StubRef): SafeHtml => html`<a href="${stubHref(ref.id)}">#${ref.position} ${ref.label}</a>`

// ---------------------------------------------------------------- the head

// "matched #1 GET /orders, response 2 of 2", or what answered instead
const answeredLine = (answered: Answered): SafeHtml => {
  switch (answered.kind) {
    case "stub": {
      if (answered.stub === undefined) {
        return html`matched stub <span title="${answered.stubId}">${answered.stubId.slice(0, 8)}</span>, since removed`
      }
      const { responseCount, responseIndex } = answered
      const which = responseIndex !== undefined && responseCount !== undefined && responseCount > 1
        ? html`, response ${responseIndex + 1} of ${responseCount}`
        : html``
      return html`matched ${stubLink(answered.stub)}${which}`
    }
    case "extension":
      return html`<span class="c-caution">no stub matched</span> → the <span class="c-info">${answered.protocol}</span> extension answered`
    case "proxy":
      return html`<span class="c-caution">no stub matched</span> → proxied${
        answered.target === undefined ? html`` : html` to <span class="c-info">${answered.target}</span>`
      }`
    case "unmatched":
      return html`<span class="c-caution">no stub matched</span>`
  }
}

const head = (d: RequestDetail): SafeHtml => {
  const unmatched = d.answered.kind !== "stub"
  return html`<div class="detail-head">
  <div class="stack detail-id">
    <a class="label" href="${REQUESTS_URL}">← requests</a>
    <div class="detail-title"><span class="detail-word ${
    methodClass(d.method)
  }">${d.method}</span><h2 class="detail-path">${d.path}${
    d.queryText === "" ? html`` : html`<span class="detail-query">?${d.queryText}</span>`
  }</h2><span class="detail-word ${statusClass(d.response.status)}">→&nbsp;${d.response.status}</span></div>
    <span class="label detail-meta"><time datetime="${d.iso}">${dateTime(d.epochMs)} UTC</time> · ${ms(d.duration)} · ${
    answeredLine(d.answered)
  }</span>
  </div>
  <div class="detail-actions">
    <button class="btn" type="button" data-copy="${d.curl}" aria-label="Copy the request as a curl command">copy as curl</button>
    ${postButton({ action: replayUrl(d.id), label: "replay", ariaLabel: "Send this request again" })}
    ${
    unmatched
      ? linkButton({ href: d.draftUrl, label: "stub it", variant: "accent", ariaLabel: `Stub ${d.method} ${d.path}` })
      : linkButton({ href: d.draftUrl, label: "new stub from this" })
  }
  </div>
</div>`
}

// ---------------------------------------------------------------- request and response

const kv = (rows: ReadonlyArray<KeyValue>): SafeHtml =>
  html`<div class="kv">${concat(rows.map((row) => html`<span>${row.key}</span><span>${row.value}</span>`))}</div>`

const bodyView = (body: BodyView): SafeHtml => {
  switch (body.kind) {
    case "none":
      return html`<span class="label">no body</span>`
    case "binary": {
      const size = bytesText(body.bytes)
      return html`<span class="label">a body${
        size === "" ? "" : ` of ${size}`
      } that is not text: the log keeps no copy</span>`
    }
    case "text":
      return html`<pre class="code code-body">${body.text}</pre>${
        body.cut ? html`<span class="label">the first 10 KiB: the log keeps no more</span>` : html``
      }`
  }
}

const dots =
  html`<span class="dots" aria-hidden="true"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>`

const exchangeBar = (title: string, end: SafeHtml): SafeHtml =>
  html`<div class="bar exchange-bar"><div class="bar-title">${dots}<span class="label">${title}</span></div>${end}</div>`

const requestPanel = (d: RequestDetail): SafeHtml =>
  html`<section class="panel exchange" aria-label="Request">
  ${exchangeBar("request", html``)}
  <div class="exchange-body">
    ${
    d.query.length === 0
      ? html``
      : html`${kv(d.query.map((q) => ({ key: `query.${q.key}`, value: q.value })))}<div class="rule"></div>`
  }
    ${d.headers.length === 0 ? html`<span class="label">no headers</span>` : kv(d.headers)}
    ${bodyView(d.body)}
    <details class="disclose"><summary class="label">as curl</summary><pre class="code code-body" data-curl>${d.curl}</pre></details>
  </div>
</section>`

const responsePanel = (d: RequestDetail): SafeHtml =>
  html`<section class="panel exchange" aria-label="Response">
  ${
    exchangeBar(
      "response",
      html`<span class="label ${statusClass(d.response.status)}">${d.response.status}${
        d.response.reason === "" ? "" : ` ${d.response.reason}`
      }</span>`
    )
  }
  <div class="exchange-body">
    ${d.response.headers.length === 0 ? html`<span class="label">no headers</span>` : kv(d.response.headers)}
    ${bodyView(d.response.body)}
  </div>
</section>`

// ---------------------------------------------------------------- why it matched

const verdict = (row: VerdictRow): SafeHtml =>
  html`<div class="verdict${row.ok ? "" : " verdict-no"}"><span class="verdict-mark ${row.ok ? "c-ok" : "c-error"}">${
    row.ok ? "✓" : "✗"
  }</span><span class="verdict-text"><span class="c-text-2">${row.predicate}</span>${
    row.ignoresCase ? html` <span class="c-muted">any case</span>` : html``
  }${row.actual === undefined ? html`` : html` <span class="c-muted">· got ${row.actual}</span>`}${
    row.error === undefined ? html`` : html`<span class="verdict-error c-error">${row.error}</span>`
  }</span></div>`

const verdictRows = (v: StubVerdicts, extra?: string): SafeHtml =>
  html`<div class="verdicts">${
    v.rows.length === 0
      ? html`<div class="verdict"><span class="verdict-mark c-ok">✓</span><span class="verdict-text c-text-2">no predicates: it matches any request</span></div>`
      : concat(v.rows.map(verdict))
  }${
    extra === undefined
      ? html``
      : html`<div class="verdict"><span class="verdict-mark c-muted">→</span><span class="verdict-text c-text-2">${extra}</span></div>`
  }</div>`

const otherStub = (v: StubVerdicts, match: StubRef | undefined): SafeHtml => {
  const note = v.matched && match !== undefined
    ? html`<span class="label">matches too, but #${match.position} comes first</span>`
    : v.error !== undefined
    ? html`<span class="label c-error">cannot be checked</span>`
    : html`<span class="label">${v.rows.filter((r) => !r.ok).length} of ${v.rows.length} failed</span>`
  return html`<div class="why-stub">
  <div class="why-stub-head"><span class="verdict-mark ${v.matched ? "c-ok" : "c-error"}">${
    v.matched ? "✓" : "✗"
  }</span>${stubLink(v.stub)}${note}<a class="label why-edit" href="${editHref(v.stub.id)}">edit</a></div>
  ${verdictRows(v)}
</div>`
}

const whyTitle = (d: RequestDetail): string => {
  const { agrees, error, match, others } = d.explanation
  if (error !== undefined) return "matching fails now"
  if (match !== undefined) {
    return agrees ? `why stub #${match.stub.position} matched` : `stub #${match.stub.position} would match now`
  }
  if (others.length === 0) return "no stubs to match"
  return agrees ? "why no stub matched" : "no stub would match now"
}

const othersSummary = (d: RequestDetail): string => {
  const n = d.explanation.others.length
  if (d.explanation.match !== undefined) return n === 1 ? "the other stub" : `the other ${n} stubs`
  return n === 1
    ? `1 stub, and it did not match · ${d.fallback} answers`
    : `${n} stubs, none matched · ${d.fallback} answers`
}

const whyPanel = (d: RequestDetail): SafeHtml => {
  const { error, match, others } = d.explanation
  // The response line only describes the stub that answered, when it is also the one that matches now
  const extra = match !== undefined && d.explanation.agrees ? d.responseLine : undefined
  return html`<section class="panel why" aria-labelledby="why-title">
  <div class="bar"><h2 class="title" id="why-title">${
    whyTitle(d)
  }</h2><span class="label">against the stubs as they are now</span></div>
  <div class="why-body">
    ${d.differs === undefined ? html`` : html`<p class="why-flag" data-differs>⚠ ${d.differs}</p>`}
    ${error === undefined || d.differs !== undefined ? html`` : html`<p class="why-flag">⚠ ${error}</p>`}
    ${match === undefined ? html`` : verdictRows(match, extra)}
    ${
    match === undefined && others.length === 0
      ? html`<p class="label panel-note">this imposter has no stubs, so ${d.fallback} answers every request</p>`
      : html``
  }
    ${
    others.length === 0
      ? html``
      : html`<details class="disclose why-others"${match === undefined ? html` open` : html``}><summary class="label">${
        othersSummary(d)
      }</summary><div class="why-list">${concat(others.map((v) => otherStub(v, match?.stub)))}</div></details>`
  }
  </div>
</section>`
}

// ---------------------------------------------------------------- pages

export interface RequestDetailOpts {
  readonly config: ImposterConfig
  readonly stubCount: number
  readonly theme: Theme | null
  readonly adminUiUrl?: string
}

export const requestDetailPage = (d: RequestDetail, opts: RequestDetailOpts): SafeHtml => {
  const body = html`${requestsHeader(opts.config, opts.stubCount, opts.adminUiUrl)}
<main class="main">
  ${head(d)}
  <div class="alert" data-error-slot></div>
  <div class="exchange-grid">
    ${requestPanel(d)}
    ${responsePanel(d)}
  </div>
  ${whyPanel(d)}
</main>`
  return shell({ title: `${opts.config.name} · ${d.method} ${d.path}`, prefix: "/_admin", theme: opts.theme }, body)
}

/**
 * A request's page, or its replay, for an entry the log no longer holds (it keeps the latest
 * 100 of this run, and clearing it empties it) or never held
 */
export const requestNotFoundPage = (entryId: string, opts: RequestDetailOpts, doing?: string): SafeHtml => {
  const body = html`${requestsHeader(opts.config, opts.stubCount, opts.adminUiUrl)}
<main class="main">
  <div class="stack page-head"><a class="label" href="${REQUESTS_URL}">← requests</a><h2 class="page-title">request not found</h2></div>
  <div class="panel pad"><p class="label panel-note">No logged request has id <span class="c-heading">${entryId}</span>${
    doing === undefined ? "" : `, so there is nothing to ${doing}`
  }. The log keeps the last 100 requests since the imposter started; this one may have aged out, or the log was cleared.</p></div>
</main>`
  return shell({ title: `${opts.config.name} · request not found`, prefix: "/_admin", theme: opts.theme }, body)
}

/** A page with one message: an unknown /_admin path, or an action that failed without JS */
export const noticePage = (title: string, message: string, opts: RequestDetailOpts): SafeHtml => {
  const body = html`${requestsHeader(opts.config, opts.stubCount, opts.adminUiUrl)}
<main class="main">
  <div class="stack page-head"><a class="label" href="${REQUESTS_URL}">← requests</a><h2 class="page-title">${title}</h2></div>
  <div class="alert" role="alert">${message}</div>
</main>`
  return shell({ title: `${opts.config.name} · ${title}`, prefix: "/_admin", theme: opts.theme }, body)
}
