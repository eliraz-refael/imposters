/**
 * The /_ui overview: every imposter with its last 15 minutes of traffic, the start/stop/delete
 * actions, and the create form. The page polls its live region; forms work without JS.
 */
import * as Option from "effect/Option"
import { ago, count, decimal, millis, ms, NONE, percent, plural, shortDuration } from "../../components/format.js"
import { brand, liveLabel, mark, themeToggle, topBar } from "../../components/header.js"
import {
  icons,
  linkButton,
  pill,
  postButton,
  protocolPill,
  statTile,
  type ValueTone
} from "../../components/primitives.js"
import { shell } from "../../components/shell.js"
import { sparkline } from "../../components/sparkline.js"
import { concat, html, type SafeHtml } from "../../html.js"
import type { Theme } from "../../theme.js"
import { countsUnmatched, type ImposterRow, isHot, type Overview } from "../OverviewData.js"

// The live region the page polls and every action's answer replaces
export const OVERVIEW_ID = "overview"
export const OVERVIEW_FRAGMENT_URL = "/_ui/fragments/overview"
const POLL_MS = 5000
const MINUTES = 15

const imposterPath = (id: string, action: "start" | "stop" | "delete"): string =>
  `/_ui/imposters/${encodeURIComponent(id)}/${action}`

const rate = (requests: number): string => decimal(requests / MINUTES)

// ---------------------------------------------------------------- headline

// `oob` marks it for an answer, whose swap replaces the page's headline by id
const headline = (data: Overview, oob: boolean): SafeHtml => {
  const { summary } = data
  const parts = summary.total === 0
    ? ["no imposters yet"]
    : [`${count(summary.running)} of ${count(summary.total)} running`, plural(summary.stubs, "stub")]
  const uptime = Option.match(data.health, { onNone: () => [], onSome: (h) => [`up ${shortDuration(h.uptime)}`] })
  return html`<p class="label headline" id="overview-headline"${oob ? html` data-oob` : html``}>// ${
    [...parts, ...uptime].join(" · ")
  }</p>`
}

// ---------------------------------------------------------------- summary strip

const WARN: ValueTone = "warn"

const strip = (data: Overview): SafeHtml => {
  const { summary } = data
  const { requests, serverErrors, unmatched } = summary.last15
  const share = percent(serverErrors, requests)

  const serverErrorNote = summary.mostServerErrors !== undefined
    ? html`mostly <a href="${summary.mostServerErrors.uiUrl}">${summary.mostServerErrors.name}</a>`
    : requests > 0
    ? html`no 5xx answers`
    : html`no traffic yet`

  const unmatchedNote = summary.mostUnmatched !== undefined
    ? html`<a href="${summary.mostUnmatched.uiUrl}">see them on ${summary.mostUnmatched.name} →</a>`
    : requests > 0
    ? html`every request matched`
    : html`nothing to match yet`

  return html`<section class="panel strip strip-4" aria-label="Traffic, last 15 minutes">
  ${
    statTile({
      label: "requests · last 15 min",
      value: count(requests),
      note: `${rate(requests)} / min`,
      aside: sparkline({ values: summary.timeline, width: 120, height: 32, tone: requests > 0 ? "on" : "off" })
    })
  }
  ${
    statTile({
      label: "5xx rate",
      value: share,
      ...(isHot(summary.last15) ? { tone: WARN } : {}),
      note: serverErrorNote
    })
  }
  ${
    summary.slowest !== undefined
      ? statTile({
        label: "slowest p95",
        value: millis(summary.slowest.p95),
        unit: "ms",
        note: html`${summary.slowest.row.name}`
      })
      : statTile({ label: "slowest p95", value: NONE, note: "no traffic yet" })
  }
  ${statTile({ label: "no stub matched", value: count(unmatched), note: unmatchedNote })}
</section>`
}

// ---------------------------------------------------------------- table

// Column names; the cells repeat them as `data-label`, which the stacked cards on a narrow
// screen print above each value (ui.css), since those cards have no header row
const COLUMN = {
  stubs: "stubs",
  traffic: "traffic · 15 min",
  rate: "req/min",
  serverErrors: "5xx",
  p95: "p95",
  unmatched: "unmatched"
} as const

const COLUMNS: ReadonlyArray<readonly [string, boolean]> = [
  ["name", false],
  ["protocol", false],
  ["port", false],
  [COLUMN.stubs, true],
  [COLUMN.traffic, false],
  [COLUMN.rate, true],
  [COLUMN.serverErrors, true],
  [COLUMN.p95, true],
  [COLUMN.unmatched, true]
]

const headRow: SafeHtml = html`<div class="row row-imposters row-head label" role="row">${
  concat(
    COLUMNS.map(([name, numeric]) =>
      html`<span role="columnheader"${numeric ? html` class="num-head"` : html``}>${name}</span>`
    )
  )
}<span role="columnheader"><span class="visually-hidden">actions</span></span></div>`

const statusLine = (row: ImposterRow, nowMs: Option.Option<number>): string => {
  if (!row.running) return `stopped · ${row.stubs === 0 ? "no stubs yet" : `${plural(row.stubs, "stub")} ready`}`
  if (row.lastRequestAtMs === undefined) return "running · no requests yet"
  const then = row.lastRequestAtMs
  return Option.match(nowMs, {
    onNone: () => "running",
    onSome: (now) => `running · last req ${ago(then, now)}`
  })
}

const imposterRow = (row: ImposterRow, nowMs: Option.Option<number>): SafeHtml => {
  const target = `#${OVERVIEW_ID}`
  const hot = row.running && isHot(row.last15)
  const off = (value: string): string => (row.running ? value : NONE)
  const name = row.running
    ? html`<a class="imp-name ellipsis" href="${row.uiUrl}">${row.name}</a>`
    : html`<span class="imp-name ellipsis">${row.name}</span>`

  return html`<div class="row row-imposters${row.running ? "" : " row-off"}" role="row" id="imposter-${row.id}">
  <div class="cell-name" role="cell">
    <span class="${row.running ? "dot-on" : "dot-off"}" aria-hidden="true"></span>
    <div class="stack">${name}<span class="label ellipsis">${statusLine(row, nowMs)}</span></div>
  </div>
  <span class="cell-protocol" role="cell">${protocolPill(row.protocol)}</span>
  <span class="port" role="cell">:${row.port}</span>
  <span class="num cell-stubs" role="cell" data-label="${COLUMN.stubs}">${count(row.stubs)}</span>
  <span class="cell-spark" role="cell" data-label="${COLUMN.traffic}">${
    sparkline({
      values: row.running ? row.timeline : [],
      width: 150,
      height: 28,
      tone: !row.running ? "off" : hot ? "warn" : "on"
    })
  }</span>
  <span class="num" role="cell" data-label="${COLUMN.rate}">${off(rate(row.last15.requests))}</span>
  <span class="num${hot ? " c-warn" : ""}" role="cell" data-label="${COLUMN.serverErrors}">${
    off(percent(row.last15.serverErrors, row.last15.requests))
  }</span>
  <span class="num" role="cell" data-label="${COLUMN.p95}">${off(row.p95 === undefined ? NONE : ms(row.p95))}</span>
  <span class="num" role="cell" data-label="${COLUMN.unmatched}">${
    countsUnmatched(row) ? off(count(row.last15.unmatched)) : NONE
  }</span>
  <div class="actions" role="cell">
    ${
    postButton({
      action: imposterPath(row.id, row.running ? "stop" : "start"),
      label: row.running ? "stop" : "start",
      ariaLabel: `${row.running ? "Stop" : "Start"} ${row.name}`,
      target
    })
  }
    ${
    row.running
      ? linkButton({ href: row.uiUrl, label: "open ↗", ariaLabel: `Open ${row.name}` })
      : html`<span class="btn" aria-disabled="true" title="Start it to open its UI">open ↗</span>`
  }
    ${
    postButton({
      action: imposterPath(row.id, "delete"),
      label: icons.trash,
      variant: "icon-danger",
      ariaLabel: `Delete ${row.name}`,
      target,
      confirm: row.stubs === 0 ? `Delete ${row.name}?` : `Delete ${row.name} and its ${plural(row.stubs, "stub")}?`
    })
  }
  </div>
</div>`
}

const emptyState: SafeHtml = html`<div class="empty">
  <p class="empty-title">no imposters yet</p>
  <p class="label">Create one below, <span class="mono c-text-2">POST /imposters</span>, or start with <span class="mono c-text-2">--config</span>.</p>
</div>`

const table = (data: Overview): SafeHtml => {
  const nowMs = Option.map(data.health, (h) => h.nowMs)
  return html`<section class="panel" aria-label="Imposters">
  ${
    data.imposters.length === 0
      ? emptyState
      : html`<div class="table-scroll"><div class="table" role="table" aria-label="Imposters">${headRow}${
        concat(data.imposters.map((row) => imposterRow(row, nowMs)))
      }</div></div>`
  }
</section>`
}

const liveRegion = (data: Overview): SafeHtml => html`${strip(data)}${table(data)}`

export interface FragmentOpts {
  // A message for the create form's error slot, sent out of band with a 2xx answer: a create
  // that made the imposter but could not start it, so the form resets and the row appears
  readonly formError?: string
}

/**
 * What the poll and every action answer with: the live region, plus the headline out of band
 * (`data-oob`), since its counts change with it.
 */
export const overviewFragment = (data: Overview, opts?: FragmentOpts): SafeHtml =>
  html`${liveRegion(data)}${headline(data, true)}${
    opts?.formError === undefined ? html`` : formErrorSlot(opts.formError, true)
  }`

// ---------------------------------------------------------------- create form

export interface CreateFormState {
  readonly name: string
  readonly port: string
  readonly protocol: string
  readonly start: boolean
  // A plain-English reason the last submission failed
  readonly error?: string
}

export const emptyCreateForm: CreateFormState = { name: "", port: "", protocol: "HTTP", start: true }

// The create form's own error slot; `oob` marks it for an answer, whose swap replaces it by id
const formErrorSlot = (message: string, oob: boolean): SafeHtml =>
  html`<div class="alert form-error" id="new-error" data-error-slot role="alert"${
    oob ? html` data-oob` : html``
  }>${message}</div>`

const createForm = (data: Overview, form: CreateFormState): SafeHtml => {
  const portHint = Option.match(data.portRange, {
    onNone: () => "auto",
    onSome: (range) => `auto (${String(range.min)}–${String(range.max)})`
  })
  return html`<section class="panel-dashed new" id="new" aria-labelledby="new-title">
  <div class="new-head">
    <h2 class="h2" id="new-title">new imposter</h2>
    <span class="label">or POST /imposters, or a --config file</span>
  </div>
  <form class="new-form" method="post" action="/_ui/imposters" data-action data-target="#${OVERVIEW_ID}" data-reset>
    <div class="field"><label class="label" for="new-name">name</label><input class="input w-name" id="new-name" name="name" value="${form.name}" placeholder="orders-api" autocomplete="off" spellcheck="false"></div>
    <div class="field"><label class="label" for="new-port">port</label><input class="input w-port" id="new-port" name="port" value="${form.port}" placeholder="${portHint}" inputmode="numeric" autocomplete="off"></div>
    <div class="field"><label class="label" for="new-protocol">protocol</label><select class="input w-protocol" id="new-protocol" name="protocol">${
    concat(data.protocols.map((protocol) =>
      html`<option value="${protocol}"${protocol === form.protocol ? html` selected` : html``}>${protocol}</option>`
    ))
  }</select></div>
    <label class="check-label"><input class="check" type="checkbox" name="start"${
    form.start ? html` checked` : html``
  }>start it now</label>
    <button class="btn btn-accent btn-field" type="submit">create</button>
    ${formErrorSlot(form.error ?? "", false)}
  </form>
</section>`
}

// ---------------------------------------------------------------- page

export interface OverviewPageOpts {
  readonly theme: Theme | null
  readonly form: CreateFormState
  // A failed start, stop or delete, shown above the table
  readonly error?: string
}

export const overviewPage = (data: Overview, opts: OverviewPageOpts): SafeHtml => {
  const address = `${data.bindHost}:${String(data.adminPort)}`
  const header = topBar({
    navLabel: "Admin",
    start: html`${mark()}${brand}${pill(`admin · ${address}`)}`,
    end: html`${liveLabel()}${linkButton({ href: "/docs", label: "API docs" })}${themeToggle}`
  })
  const body = html`${header}
<main class="main main-overview">
  <div class="hero">
    <div class="hero-text">
      ${headline(data, false)}
      <h1 class="display">imposters<span class="c-ok">_</span></h1>
    </div>
    <a class="btn btn-accent btn-lg" href="#new">+ new imposter</a>
  </div>
  <div class="alert" data-error-slot role="alert">${opts.error ?? ""}</div>
  <div class="overview" id="${OVERVIEW_ID}" data-poll="${POLL_MS}" data-url="${OVERVIEW_FRAGMENT_URL}">
    ${liveRegion(data)}
  </div>
  ${createForm(data, opts.form)}
  <footer class="footer label">
    <span>imposters v${data.version} · binds ${data.bindHost}</span>
    <span>no auth on the admin API: keep it off untrusted networks</span>
  </footer>
</main>`
  return shell({ title: "imposters · all imposters", prefix: "/_ui", theme: opts.theme }, body)
}
