import { icons } from "../components/primitives.js"
import {
  type ConditionState,
  FIELDS,
  type FormState,
  type HeaderState,
  MODES,
  NEW_CONDITION,
  NEW_HEADER,
  NEW_RESPONSE,
  OPERATOR_LABELS,
  OPERATORS,
  type ResponseState
} from "../editor/formModel.js"
import { conditionControls, type Control, type Controls, headerControls, responseControls } from "../editor/formView.js"
import { concat, html, raw, type SafeHtml } from "../html.js"

/**
 * The stub editor's form view, as the server renders it: a row per condition, a card per
 * response, the response mode, and a <template> per row type that ui.js clones for a row it
 * adds. Each control's attributes come from src/ui/editor/formView.ts, which the runtime applies
 * to a clone the same way, so a row looks the same whoever drew it. The form is hidden until the
 * editor's script shows it: without JS the page posts the JSON, as before.
 */

// ---------------------------------------------------------------- attributes

const attrs = (control: Control, withValue: boolean): SafeHtml => {
  const parts: Array<SafeHtml> = []
  const add = (name: string, value: string | undefined): void => {
    if (value !== undefined) parts.push(html` ${raw(name)}="${value}"`)
  }
  add("data-k", control.k)
  add("id", control.id)
  add("aria-label", control.label)
  add("data-path", control.path)
  add("aria-pressed", control.pressed === undefined ? undefined : String(control.pressed))
  add("placeholder", control.placeholder)
  add("for", control.htmlFor)
  add("aria-labelledby", control.labelledBy)
  add("aria-describedby", control.describedBy)
  if (withValue) add("value", control.value)
  if (control.hidden === true) parts.push(raw(" hidden"))
  if (control.disabled === true) parts.push(raw(" disabled"))
  return concat(parts)
}

// ` data-c="name"` and the control's attributes; `withValue` for an <input>
const at = (controls: Controls, name: string, withValue = false): SafeHtml =>
  html` data-c="${name}"${attrs(controls[name] ?? {}, withValue)}`

const valueOf = (controls: Controls, name: string): string => controls[name]?.value ?? ""
const textOf = (controls: Controls, name: string): string => controls[name]?.text ?? ""

const options = <A extends string>(
  values: ReadonlyArray<A>,
  label: (value: A) => string,
  selected: string
): SafeHtml =>
  concat(
    values.map((value) =>
      html`<option value="${value}"${value === selected ? html` selected` : html``}>${label(value)}</option>`
    )
  )

// The HTML parser drops a newline right after <textarea>: one is added only when the text starts
// with one, so the value is the text either way
const areaText = (text: string): string => text.startsWith("\n") ? `\n${text}` : text

// ---------------------------------------------------------------- rows

export const conditionRow = (condition: ConditionState, index: number): SafeHtml => {
  const c = conditionControls(condition, index)
  return html`<div class="cond" data-row="condition">
  <select class="input cond-field"${at(c, "field")}>${options(FIELDS, (f) => f, valueOf(c, "field"))}</select>
  <select class="input cond-op"${at(c, "operator")}>${
    options(OPERATORS, (op) => OPERATOR_LABELS[op], valueOf(c, "operator"))
  }</select>
  <input class="input cond-name" autocomplete="off" spellcheck="false"${at(c, "name", true)}>
  <input class="input cond-value" autocomplete="off" spellcheck="false"${at(c, "value", true)}>
  <span class="hint cond-present"${at(c, "present")}>is present</span>
  <button type="button" class="btn btn-icon btn-case" title="case sensitive"${at(c, "case")}>Aa</button>
  <button type="button" class="btn btn-icon btn-danger"${at(c, "remove")}>${icons.close}</button>
</div>`
}

export const headerRow = (header: HeaderState, index: number, h: number): SafeHtml => {
  const c = headerControls(header, index, h)
  return html`<div class="hdr" data-row="header">
  <input class="input" list="header-names" autocomplete="off" spellcheck="false"${at(c, "name", true)}>
  <input class="input" autocomplete="off" spellcheck="false"${at(c, "value", true)}>
  <button type="button" class="btn btn-icon btn-danger"${at(c, "remove")}>${icons.close}</button>
</div>`
}

const segButton = (c: Controls, name: string, label: string): SafeHtml =>
  html`<button type="button"${at(c, name)}>${label}</button>`

// Written with `$` + `{`, so this file's own template literal leaves it alone
const TEMPLATE_HINT = raw(
  `templates work here: <span class="mono">{{request.query.id}}</span> or <span class="mono">$` +
    `{request.path}</span>`
)

export const responseCard = (response: ResponseState, index: number, count: number): SafeHtml => {
  const c = responseControls(response, index, count)
  return html`<div class="resp" role="group" data-row="response"${at(c, "card")}>
  <div class="resp-head">
    <span class="resp-title"${at(c, "title")}>${textOf(c, "title")}</span>
    <div class="resp-tools">
      <button type="button" class="btn btn-icon"${at(c, "up")}>${icons.up}</button>
      <button type="button" class="btn btn-icon"${at(c, "down")}>${icons.down}</button>
      <button type="button" class="btn btn-icon btn-danger"${at(c, "remove")}>${icons.trash}</button>
    </div>
  </div>
  <div class="resp-line">
    <label class="label resp-key"${at(c, "status-label")}>HTTP status</label>
    <input class="input inp-num" type="number" min="100" max="599" step="1"${at(c, "status", true)}>
    <span class="hint"${at(c, "reason")}>${textOf(c, "reason")}</span>
  </div>
  <div class="resp-line resp-top">
    <span class="label resp-key">headers</span>
    <div class="resp-stack">
      <div class="hdrs" data-headers>${concat(response.headers.map((header, h) => headerRow(header, index, h)))}</div>
      <div><button type="button" class="btn btn-ghost btn-sm"${at(c, "add-header")}>+ header</button></div>
    </div>
  </div>
  <div class="resp-line resp-top">
    <span class="label resp-key">body</span>
    <div class="resp-stack">
      <div class="seg-btns" role="group"${at(c, "kinds")}>${segButton(c, "kind-json", "JSON")}${
    segButton(c, "kind-text", "text")
  }${segButton(c, "kind-none", "none")}</div>
      <textarea class="code inp-body" rows="4" spellcheck="false" autocomplete="off" autocapitalize="off"${
    at(c, "body")
  }>${areaText(valueOf(c, "body"))}</textarea>
      <span class="err"${at(c, "body-err")}></span>
      <span class="hint"${at(c, "body-hint")}>${TEMPLATE_HINT}</span>
    </div>
  </div>
  <div class="resp-line">
    <span class="label resp-key">delay</span>
    <div class="seg-btns" role="group"${at(c, "delays")}>${segButton(c, "delay-none", "none")}${
    segButton(c, "delay-fixed", "fixed")
  }${segButton(c, "delay-range", "range")}</div>
    <span class="delay-in"${at(c, "fixed")}><input class="input inp-ms" type="number" min="0" max="60000" step="1"${
    at(c, "ms", true)
  }><span class="label">ms</span></span>
    <span class="delay-in"${at(c, "range")}><input class="input inp-ms" type="number" min="0" max="60000" step="1"${
    at(c, "min", true)
  }><span class="label">to</span><input class="input inp-ms" type="number" min="0" max="60000" step="1"${
    at(c, "max", true)
  }><span class="label">ms</span></span>
    <span class="hint"${at(c, "delay-hint")}>a random wait in that range, each time</span>
  </div>
</div>`
}

// ---------------------------------------------------------------- the form

const HEADER_NAMES = [
  "content-type",
  "cache-control",
  "location",
  "retry-after",
  "set-cookie",
  "etag",
  "access-control-allow-origin",
  "www-authenticate"
]

const MODE_HINT = "sequential: 1, 2, 1, 2 … · random: any one, each time · repeat: 1, 2, 2, 2 … (stays on the last)"

// The response mode, as radio buttons drawn as one segmented control
const modeControl = (mode: string): SafeHtml =>
  html`<fieldset class="seg" data-editor-mode><legend class="visually-hidden">response order</legend>${
    concat(MODES.map((value) =>
      html`<label class="seg-opt"><input type="radio" name="mode" value="${value}"${
        value === mode ? html` checked` : html``
      }><span>${value}</span></label>`
    ))
  }</fieldset>`

/**
 * The form for a draft the form can show; for one it cannot (`form` undefined) its lists start
 * empty, and the runtime opens the JSON view with the reason. `mode` is the mode to show checked.
 */
export const stubFormView = (form: FormState | undefined, mode: string): SafeHtml => {
  const responses = form?.responses ?? []
  return html`<div class="stub-form" id="editor-form" data-form-view hidden>
  <div class="form-sec">
    <div class="sec-head"><h3 class="sec-title">when</h3><span class="hint">every condition must match · none = every request</span></div>
    <div class="conds" data-conditions>${concat((form?.conditions ?? []).map(conditionRow))}</div>
    <div><button type="button" class="btn btn-ghost" data-k="add-condition">+ add condition</button></div>
  </div>
  <div class="form-sec">
    <div class="sec-head"><h3 class="sec-title">answer with</h3>${modeControl(mode)}</div>
    <span class="hint">${MODE_HINT}</span>
    <div class="resps" data-responses>${
    concat(responses.map((response, i) => responseCard(response, i, responses.length)))
  }</div>
    <div><button type="button" class="btn btn-ghost" data-k="add-response">+ add response</button></div>
  </div>
  <datalist id="header-names">${concat(HEADER_NAMES.map((name) => html`<option value="${name}"></option>`))}</datalist>
  <template data-template="condition">${conditionRow(NEW_CONDITION, 0)}</template>
  <template data-template="response">${responseCard(NEW_RESPONSE, 0, 1)}</template>
  <template data-template="header">${headerRow(NEW_HEADER, 0, 0)}</template>
</div>`
}
