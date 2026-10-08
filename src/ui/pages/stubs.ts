import type { PreviewResponse } from "../../schemas/ExplainSchema.js"
import { editorJs } from "../assets/generated.js"
import { count, plural } from "../components/format.js"
import { imposterHeader, STUB_COUNT_ID } from "../components/imposterHeader.js"
import { icons, pill, postButton, tabCount } from "../components/primitives.js"
import { shell } from "../components/shell.js"
import { type LocatedProblem, problemLines, type StubCheck } from "../editor/checkStub.js"
import { parseDraftText } from "../editor/draftText.js"
import { fieldLabel, readForm, splitMessage } from "../editor/formModel.js"
import { concat, html, type SafeHtml } from "../html.js"
import {
  type CallsView,
  type CallView,
  type Fallback,
  type PredicateChip,
  type ResponseView,
  sentBodyPreview,
  type StubCard,
  type StubsData
} from "../StubsData.js"
import type { Theme } from "../theme.js"
import { stubFormView } from "./stubForm.js"

/**
 * An imposter's stubs page (`/_admin/stubs`): a card per stub in matching order, with edit and
 * delete, and the editor that adds and edits them (a form and the JSON, checked and previewed as
 * you type). Every form works without JS: a POST answered with a 303 back here, or this page
 * again with the problems; the editor then shows the JSON alone. ui.js swaps fragments instead
 * (data-action), and editor.js runs the editor (data-stub-editor).
 */

export const STUBS_URL = "/_admin/stubs"
export const EDITOR_FRAGMENT_URL = "/_admin/fragments/stub-editor"
export const PREVIEW_URL = "/_admin/stubs/preview"
const LIST_ID = "stub-list"
const EDITOR_ID = "stub-editor"

export const stubUrl = (id: string): string => `${STUBS_URL}/${encodeURIComponent(id)}`
const deleteUrl = (id: string): string => `${stubUrl(id)}/delete`

// ---------------------------------------------------------------- cards

const chip = (predicate: PredicateChip): SafeHtml =>
  html`<span class="tok"><span class="tok-field">${predicate.field}</span>&nbsp;<span class="tok-op">${predicate.operator}</span>${
    predicate.value === "" ? html`` : html`&nbsp;<span class="tok-value">${predicate.value}</span>`
  }${predicate.ignoresCase ? html`&nbsp;<span class="tok-op">any case</span>` : html``}</span>`

const chips = (predicates: ReadonlyArray<PredicateChip>): SafeHtml =>
  predicates.length === 0
    ? html`<span class="tok"><span class="tok-op">any request</span></span>`
    : concat(predicates.map((p, i) => i === 0 ? chip(p) : html`<span class="label">and</span>${chip(p)}`))

// "stock GET 127.0.0.1:3203", and "onError fail" for a call whose failure fails the answer
const callLine = (call: CallView): SafeHtml =>
  html`<span class="c-text-2">${call.name}</span> ${call.method} ${call.host}${
    call.failsAnswer ? html` <span class="c-caution">onError fail</span>` : html``
  }`

// The calls a response makes: which run before and after it, then each one's method and host
const callsBlock = (calls: CallsView): SafeHtml =>
  html`<div class="stack answer-calls" data-calls><span class="label c-text-2">${calls.summary}</span><span class="label">${
    concat(calls.calls.map((call, i) => i === 0 ? callLine(call) : html` · ${callLine(call)}`))
  }</span></div>`

const answer = (response: ResponseView): SafeHtml =>
  html`<div class="answer">
  <div class="answer-head"><span class="status-num c-${response.tone}">${response.status}</span>${
    response.next ? html`<span class="pill pill-next">next</span>` : html``
  }${response.hits === undefined ? html`` : html`<span class="label">× ${count(response.hits)}</span>`}${
    response.delay === undefined ? html`` : pill(response.delay, "warn")
  }</div>${response.calls === undefined ? html`` : callsBlock(response.calls)}
  ${
    response.body === undefined
      ? html`<span class="label">no body</span>`
      : html`<pre class="code">${response.body}</pre>`
  }
</div>`

const editLink = (card: StubCard): SafeHtml =>
  html`<a class="btn" href="${STUBS_URL}?edit=${
    encodeURIComponent(card.id)
  }#${EDITOR_ID}" data-action="GET ${EDITOR_FRAGMENT_URL}?edit=${
    encodeURIComponent(card.id)
  }" data-target="#${EDITOR_ID}" data-swap="outer" aria-label="Edit stub ${card.position}">edit</a>`

export const stubCard = (card: StubCard): SafeHtml =>
  html`<article class="panel stub-card" id="stub-${card.id}" aria-label="Stub ${card.position}">
  <div class="bar stub-bar">
    <div class="bar-title"><span class="stub-num">#${card.position}</span><span class="label" title="${card.id}">${card.shortId}</span>${
    pill(card.mode)
  }</div>
    <div class="bar-actions"><span class="label stub-hits">${card.hitsLine}</span>${editLink(card)}${
    postButton({
      action: deleteUrl(card.id),
      label: icons.trash,
      variant: "icon-danger",
      ariaLabel: `Delete stub ${card.position}`,
      target: `#${LIST_ID}`,
      confirm: `Delete stub #${card.position} (${card.label})?`
    })
  }</div>
  </div>
  <div class="stub-body">
    <div class="stub-row"><span class="label stub-key">when</span><div class="chips">${
    chips(card.predicates)
  }</div></div>
    <div class="stub-row"><span class="label stub-key stub-key-top">answer</span><div class="answers${
    card.responses.length > 1 ? " answers-many" : ""
  }">${concat(card.responses.map(answer))}</div></div>
  </div>
</article>`

const fallbackNote = (fallback: Fallback): SafeHtml => {
  switch (fallback.kind) {
    case "extension":
      return html`<span class="label">nothing else matches → the <span class="c-info">${fallback.protocol}</span> extension answers</span>`
    case "proxy":
      return html`<span class="label">nothing else matches → the proxy answers (${fallback.mode}, <span class="c-info">${fallback.targetUrl}</span>)</span>`
    case "notFound":
      return html`<span class="label">nothing else matches → <span class="c-caution">404</span> · ${
        fallback.unmatched === 0 ? "none so far" : `${plural(fallback.unmatched, "request")} so far`
      }</span>${fallback.unmatched === 0 ? html`` : html`<a class="label" href="/_admin">see them →</a>`}`
  }
}

/** The cards, then what answers a request none of them matches: the list the actions refresh */
export const stubList = (data: StubsData): SafeHtml =>
  html`${
    data.cards.length === 0
      ? html`<div class="panel pad"><p class="label panel-note">no stubs yet: every request gets the answer below. Add one with the editor.</p></div>`
      : concat(data.cards.map(stubCard))
  }
<div class="panel stub-foot">${fallbackNote(data.fallback)}</div>`

// ---------------------------------------------------------------- the editor

/** What the editor's status shows: the check of its text, and for a valid stub its preview */
export interface EditorStatus {
  readonly check: StubCheck
  readonly preview?: PreviewResponse
}

export type InsertAt = "first" | "last"

export interface EditorState {
  // Add a new stub, or edit this one
  readonly editing?: { readonly id: string; readonly position: number }
  readonly text: string
  // Where a new stub goes
  readonly insert: InsertAt
  // "Stub it": the request the draft was made for
  readonly from?: { readonly method: string; readonly path: string }
  readonly status?: EditorStatus
  // The message for the form's own error slot (a failed save, without JS)
  readonly error?: string
  // Swapped in by an action: ui.js moves the focus to it
  readonly focus?: boolean
  // In an answer: replaces the page's editor by id
  readonly oob?: boolean
}

const sampleBody = (body: string | undefined): string => {
  const preview = body === undefined ? undefined : sentBodyPreview(body)
  return preview === undefined ? "" : ` ${preview}`
}

const previewLines = (preview: PreviewResponse): SafeHtml => {
  const reach = preview.total === 0
    ? "no unmatched requests to try it on yet"
    : preview.matched === 0
    ? `would answer none of the ${plural(preview.total, "unmatched request")}`
    : `would answer ${count(preview.matched)} of the ${plural(preview.total, "unmatched request")}`
  const sample = preview.sample
  return html`<span class="label c-text-2">${reach}</span>${
    sample === undefined ?
      html`` :
      html`<span class="status-sample">${sample.request.method} ${sample.request.path} → ${
        String(sample.response.status)
      }${sampleBody(sample.response.body)}</span>`
  }${preview.error === undefined ? html`` : html`<span class="status-warn">⚠ ${preview.error}</span>`}`
}

/**
 * A schema problem twice, for the two views (CSS shows the one in use): at its line in the
 * JSON, and at its control in the form ("response 1 · status must be …"). Each place is a link
 * the editor follows; without JS, "line 8" jumps to the textarea.
 */
const problemItem = (problem: LocatedProblem): SafeHtml => {
  const { at, message, path } = problem
  const inJson = at === undefined
    ? html`${message}`
    : html`<a href="#stub-json" data-line="${String(at.line)}">line ${String(at.line)}</a>: ${message}`
  const split = splitMessage(message, path)
  const target = split?.at ?? path
  return html`<li data-problem-path="${
    JSON.stringify(path)
  }"><span class="in-json">${inJson}</span><span class="in-form"><a href="#editor-form" data-goto="${
    JSON.stringify(target)
  }">${fieldLabel(target)}</a>${split === undefined ? `: ${message}` : split.rest}</span></li>`
}

/** The status box's content: ✓ with the preview, or ✗ with every problem and where it is */
export const editorStatus = (status: EditorStatus): SafeHtml => {
  const { check } = status
  if (check._tag === "Valid") {
    // Preview never calls out: a response's callback results show as the templates wrote them
    const callsOut = check.stub.responses.some((response) => response.callbacks !== undefined)
    return html`<span class="status-head c-ok" data-check="valid">✓ valid stub</span>${
      status.preview === undefined ? html`` : previewLines(status.preview)
    }${callsOut ? html`<span class="label c-text-2" data-preview-note>callbacks don't run in preview</span>` : html``}`
  }
  const head = check._tag === "Syntax" ? "✗ not JSON yet" : "✗ not a valid stub yet"
  const items = check._tag === "Syntax"
    ? concat(problemLines(check).map((line) => html`<li>${line}</li>`))
    : concat(check.problems.map(problemItem))
  return html`<span class="status-head c-error" data-check="invalid">${head}</span><ul class="status-problems">${items}</ul>`
}

const statusState = (status: EditorStatus | undefined): string =>
  status === undefined ? "idle" : status.check._tag === "Valid" ? "valid" : "invalid"

// The mode the text asks for, so the form's control starts in step with it
const modeOf = (text: string): string => {
  const parsed = parseDraftText(text)
  if (!parsed.ok || typeof parsed.draft !== "object" || parsed.draft === null) return "sequential"
  const mode: unknown = "responseMode" in parsed.draft ? parsed.draft.responseMode : "sequential"
  return typeof mode === "string" ? mode : "sequential"
}

const segOption = (name: string, value: string, checked: boolean): SafeHtml =>
  html`<label class="seg-opt"><input type="radio" name="${name}" value="${value}"${
    checked ? html` checked` : html``
  }><span>${value}</span></label>`

// Where a new stub goes; a form field, so it works without JS
const insertControl = (insert: InsertAt): SafeHtml =>
  html`<fieldset class="seg"><legend class="label">insert</legend>${
    segOption("position", "first", insert === "first")
  }${segOption("position", "last", insert === "last")}</fieldset>`

// The form | JSON switch. Both views edit the JSON the editor posts, so without JS there is
// nothing to switch: it stays hidden until editor.js shows it.
const viewTabs = html`<div class="editor-tabs" data-editor-tabs hidden>
        <div class="seg-btns" role="tablist" aria-label="Editor view"><button type="button" role="tab" id="editor-tab-form" aria-controls="editor-form" aria-selected="false" aria-describedby="editor-note" tabindex="-1" data-tab="form">form</button><button type="button" role="tab" id="editor-tab-json" aria-controls="editor-json" aria-selected="true" aria-describedby="editor-note" data-tab="json">JSON</button></div>
        <span class="label editor-note" id="editor-note" data-editor-note hidden></span>
      </div>`

// The edited stub's place, " #2" (none for a stub no longer listed). A delete's answer carries
// one for every stub, out of band: the page has only the edited stub's, which a delete above it
// renumbers, and the others are dropped.
const positionMark = (id: string, position: number, oob: boolean): SafeHtml =>
  html`<span id="stub-position-${id}"${oob ? html` data-oob` : html``}>${
    position > 0 ? ` #${String(position)}` : ""
  }</span>`

const heading = (state: EditorState): SafeHtml => {
  if (state.editing !== undefined) {
    return html`<h2 class="title" id="editor-title">edit stub${
      positionMark(state.editing.id, state.editing.position, false)
    }</h2><span class="label">${state.editing.id.slice(0, 8)}</span>`
  }
  return html`<h2 class="title" id="editor-title">new stub</h2>${
    state.from === undefined ? html`` : html`<span class="label">from ${state.from.method} ${state.from.path}</span>`
  }`
}

/**
 * The editor: one form holding the whole stub as JSON, posted to add or save it, and the form
 * view of the same stub (shown by editor.js). The textarea's text starts on the line after its
 * tag: the HTML parser drops one newline there, so a text that starts with a blank line keeps
 * it, and the problems' line numbers still match.
 */
export const stubEditor = (state: EditorState): SafeHtml => {
  const editing = state.editing
  const action = editing === undefined ? STUBS_URL : stubUrl(editing.id)
  const parsed = parseDraftText(state.text)
  const read = parsed.ok ? readForm(parsed.draft) : undefined
  const form = read?.ok === true ? read.form : undefined
  return html`<section class="panel panel-focus editor" id="${EDITOR_ID}" aria-labelledby="editor-title" data-stub-editor data-preview-url="${PREVIEW_URL}"${
    editing === undefined ? html`` : html` data-editing="${editing.id}"`
  }${state.focus === true ? html` data-focus` : html``}${state.oob === true ? html` data-oob` : html``}>
  <form method="post" action="${action}" data-action data-target="#${LIST_ID}" novalidate>
    <div class="bar editor-bar">
      <div class="bar-title">${heading(state)}</div>
      ${editing === undefined ? insertControl(state.insert) : html``}
    </div>
    <div class="editor-body">
      ${viewTabs}
      ${stubFormView(form, form?.mode ?? modeOf(state.text))}
      <div class="editor-json" id="editor-json" data-json-view>
        <div class="editor-label"><label class="label" for="stub-json">stub · JSON</label><span class="label editor-hint">Tab indents · Esc, then Tab, leaves</span></div>
        <textarea id="stub-json" name="stub" class="code editor-text" spellcheck="false" autocomplete="off" autocapitalize="off" rows="18" data-editor-text>
${state.text}</textarea>
      </div>
      <div class="editor-status" data-editor-status data-state="${
    statusState(state.status)
  }" role="status" aria-live="polite">${state.status === undefined ? html`` : editorStatus(state.status)}</div>
      <div class="alert" data-error-slot>${state.error ?? ""}</div>
      <div class="editor-foot">
        <div class="bar-actions editor-actions"><a class="btn" href="${STUBS_URL}" data-action="GET ${EDITOR_FRAGMENT_URL}" data-target="#${EDITOR_ID}" data-swap="outer">cancel</a><button class="btn btn-accent" type="submit">${
    editing === undefined ? "add stub" : "save"
  }</button></div>
      </div>
    </div>
  </form>
</section>`
}

// ---------------------------------------------------------------- page and answers

/**
 * An action's answer with JS: the list, a fresh editor (when given; else each stub's place, for
 * the heading of the one being edited, and an empty place for a stub just deleted) and the tab's
 * count, the last two out of band
 */
export const stubsAnswer = (data: StubsData, editor?: EditorState, deleted?: string): SafeHtml =>
  html`${stubList(data)}${
    editor === undefined
      ? html`${concat(data.cards.map((card) => positionMark(card.id, card.position, true)))}${
        deleted === undefined || data.cards.some((card) => card.id === deleted)
          ? html``
          : positionMark(deleted, 0, true)
      }`
      : stubEditor({ ...editor, oob: true })
  }${tabCount(data.cards.length, STUB_COUNT_ID, true)}`

export interface StubsPageOpts {
  readonly theme: Theme | null
  readonly editor: EditorState
  // A failed action without JS (a stub deleted elsewhere): shown above the list
  readonly error?: string
  readonly adminUiUrl?: string
}

export const stubsPage = (data: StubsData, opts: StubsPageOpts): SafeHtml => {
  const { config } = data
  const header = imposterHeader({
    name: config.name,
    port: config.port,
    protocol: config.protocol,
    running: config.status === "running",
    ...(config.proxy !== undefined ? { proxyMode: config.proxy.mode } : {}),
    stubCount: data.cards.length,
    current: "stubs",
    ...(opts.adminUiUrl !== undefined ? { adminUiUrl: opts.adminUiUrl } : {})
  })
  const body = html`${header}
<main class="main">
  <div class="stubs-grid">
    <div class="stubs-col">
      <div class="stack page-head"><h2 class="page-title">stubs</h2><span class="label">first match wins, top to bottom · edits apply on the next request</span></div>
      <div class="alert" data-error-slot>${opts.error ?? ""}</div>
      <div class="stub-list" id="${LIST_ID}">${stubList(data)}</div>
    </div>
    ${stubEditor(opts.editor)}
  </div>
</main>`
  return shell({ title: `${config.name} · stubs`, prefix: "/_admin", theme: opts.theme, scripts: [editorJs] }, body)
}
