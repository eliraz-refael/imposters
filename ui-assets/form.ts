/**
 * The stub editor's form view in the browser (`[data-form-view]`, rendered by
 * src/ui/pages/stubForm.ts). It holds the form's state (src/ui/editor/formModel.ts) and turns
 * every input, change and click into a FormEdit, then hands the new state to the editor
 * (editor.ts), which writes the draft. Adding, removing or reordering a row redraws its list
 * from the row's <template>, through the same control specs the server renders with
 * (src/ui/editor/formView.ts), and puts the focus back where it belongs. Values are set as
 * properties and text, never as HTML.
 */
import { type DraftPath, pathKey } from "../src/ui/editor/draftText.js"
import {
  applyFormEdit,
  BODY_KINDS,
  DELAY_KINDS,
  FIELDS,
  type FormEdit,
  type FormProblem,
  type FormState,
  MODES,
  OPERATORS,
  reasonPhrase
} from "../src/ui/editor/formModel.js"
import {
  conditionControls,
  type Control,
  type Controls,
  headerControls,
  responseControls
} from "../src/ui/editor/formView.js"
import { applyEdit } from "./applyEdit"
import { editForKey } from "./textEdit"

export interface FormView {
  /** Shows the form or hides it; hidden, it makes no edits (its radios are off too) */
  readonly setActive: (active: boolean) => void
  /** Shows a state: every row and card drawn again, the focus kept on the control it was on */
  readonly show: (state: FormState) => void
  readonly state: () => FormState | undefined
  /** Marks the controls the form's own problems are about, and fills a body's error line */
  readonly showProblems: (problems: ReadonlyArray<FormProblem>) => void
  /** Marks the controls a check's problems are about (schema paths) */
  readonly markPaths: (paths: ReadonlyArray<DraftPath>) => void
  readonly focusPath: (path: DraftPath) => boolean
  readonly focusKey: (key: string) => boolean
  /** The first control, for opening the editor on the form */
  readonly focusFirst: () => void
}

// The attributes a control spec owns; the templates' own markup never sets these
const MANAGED: ReadonlyArray<readonly [keyof Control, string]> = [
  ["k", "data-k"],
  ["id", "id"],
  ["label", "aria-label"],
  ["path", "data-path"],
  ["placeholder", "placeholder"],
  ["htmlFor", "for"],
  ["labelledBy", "aria-labelledby"],
  ["describedBy", "aria-describedby"]
]

const applyControl = (el: Element, control: Control): void => {
  for (const [field, attribute] of MANAGED) {
    const value = control[field]
    if (typeof value === "string") el.setAttribute(attribute, value)
    else el.removeAttribute(attribute)
  }
  if (control.pressed === undefined) el.removeAttribute("aria-pressed")
  else el.setAttribute("aria-pressed", String(control.pressed))
  el.toggleAttribute("hidden", control.hidden === true)
  el.toggleAttribute("disabled", control.disabled === true)
  if (control.value !== undefined) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.defaultValue = control.value
    if (el instanceof HTMLSelectElement) {
      for (const option of Array.from(el.options)) option.toggleAttribute("selected", option.value === control.value)
      // The attribute selects it in a browser; the property too, for DOMs that only read it while parsing
      el.value = control.value
    }
  }
  if (control.text !== undefined) el.textContent = control.text
}

/** Applies each control spec to the element with its data-c in `row` (the row itself included) */
export const fill = (row: Element, controls: Controls): void => {
  for (const [name, control] of Object.entries(controls)) {
    const selector = `[data-c="${name}"]`
    const el = row.matches(selector) ? row : row.querySelector(selector)
    if (el !== null) applyControl(el, control)
  }
}

const isOneOf = <A extends string>(options: ReadonlyArray<A>, value: unknown): value is A =>
  options.some((option) => option === value)

// A control key, data-k: c2.field, r0.status, r0.h1.name, add-condition
type Key =
  | { readonly row: "condition"; readonly index: number; readonly part: string }
  | { readonly row: "response"; readonly index: number; readonly part: string }
  | { readonly row: "header"; readonly index: number; readonly header: number; readonly part: string }
  | { readonly row: "form"; readonly part: string }

const parseKey = (key: string): Key => {
  const header = /^r(\d+)\.h(\d+)\.(.+)$/.exec(key)
  if (header !== null) {
    return { row: "header", index: Number(header[1]), header: Number(header[2]), part: header[3] ?? "" }
  }
  const row = /^([cr])(\d+)\.(.+)$/.exec(key)
  if (row !== null) return { row: row[1] === "c" ? "condition" : "response", index: Number(row[2]), part: row[3] ?? "" }
  return { row: "form", part: key }
}

const isVisible = (el: Element): boolean => el.closest("[hidden]") === null

// An edit, whether its list is drawn again, and where the focus goes then (the first that is there)
interface Action {
  readonly edit: FormEdit
  readonly redraw?: boolean
  readonly focus?: ReadonlyArray<string>
}

const clickAction = (key: Key, state: FormState): Action | undefined => {
  if (key.row === "form") {
    if (key.part === "add-condition") {
      return { edit: { _tag: "AddCondition" }, redraw: true, focus: [`c${String(state.conditions.length)}.field`] }
    }
    if (key.part === "add-response") {
      return { edit: { _tag: "AddResponse" }, redraw: true, focus: [`r${String(state.responses.length)}.status`] }
    }
    return undefined
  }
  const { index } = key
  const i = String(index)
  if (key.row === "condition") {
    if (key.part === "case") return { edit: { _tag: "ToggleCase", index }, redraw: true, focus: [`c${i}.case`] }
    if (key.part === "remove") {
      return {
        edit: { _tag: "RemoveCondition", index },
        redraw: true,
        focus: [`c${i}.remove`, `c${String(index - 1)}.remove`, "add-condition"]
      }
    }
    return undefined
  }
  if (key.row === "header") {
    if (key.part !== "remove") return undefined
    const h = key.header
    return {
      edit: { _tag: "RemoveHeader", index, header: h },
      redraw: true,
      focus: [`r${i}.h${String(h)}.remove`, `r${i}.h${String(h - 1)}.remove`, `r${i}.add-header`]
    }
  }
  const { part } = key
  if (part === "up" || part === "down") {
    const by = part === "up" ? -1 : 1
    const to = `r${String(index + by)}`
    return {
      edit: { _tag: "MoveResponse", index, by },
      redraw: true,
      focus: [`${to}.${part}`, `${to}.${part === "up" ? "down" : "up"}`]
    }
  }
  if (part === "remove") {
    return {
      edit: { _tag: "RemoveResponse", index },
      redraw: true,
      focus: [`r${i}.remove`, `r${String(index - 1)}.remove`, "add-response"]
    }
  }
  if (part === "add-header") {
    const headers = state.responses[index]?.headers.length ?? 0
    return { edit: { _tag: "AddHeader", index }, redraw: true, focus: [`r${i}.h${String(headers)}.name`] }
  }
  const kind = part.slice(part.indexOf("-") + 1)
  if (part.startsWith("kind-") && isOneOf(BODY_KINDS, kind)) {
    return { edit: { _tag: "SetBodyKind", index, kind }, redraw: true, focus: [`r${i}.${part}`] }
  }
  if (part.startsWith("delay-") && isOneOf(DELAY_KINDS, kind)) {
    return { edit: { _tag: "SetDelayKind", index, kind }, redraw: true, focus: [`r${i}.${part}`] }
  }
  return undefined
}

// What typing into (or choosing in) a control does
const valueAction = (key: Key, value: string): Action | undefined => {
  if (key.row === "form") return undefined
  const { index } = key
  if (key.row === "header") {
    const { header } = key
    if (key.part === "name") return { edit: { _tag: "SetHeaderName", index, header, name: value } }
    if (key.part === "value") return { edit: { _tag: "SetHeaderValue", index, header, value } }
    return undefined
  }
  const self = [`${key.row === "condition" ? "c" : "r"}${String(index)}.${key.part}`]
  if (key.row === "condition") {
    if (key.part === "field" && isOneOf(FIELDS, value)) {
      return { edit: { _tag: "SetField", index, field: value }, redraw: true, focus: self }
    }
    if (key.part === "operator" && isOneOf(OPERATORS, value)) {
      return { edit: { _tag: "SetOperator", index, operator: value }, redraw: true, focus: self }
    }
    if (key.part === "name") return { edit: { _tag: "SetName", index, name: value } }
    if (key.part === "value") return { edit: { _tag: "SetValue", index, value } }
    return undefined
  }
  if (key.part === "status") return { edit: { _tag: "SetStatus", index, raw: value } }
  if (key.part === "body") return { edit: { _tag: "SetBodyText", index, text: value } }
  if (key.part === "ms" || key.part === "min" || key.part === "max") {
    return { edit: { _tag: "SetDelay", index, part: key.part, raw: value } }
  }
  return undefined
}

const BODY_HINT = " · or switch to text to send it as written"

/**
 * Runs the form in `root`. `onEdit` gets every state an edit makes; `show` (from the editor)
 * draws a state read from the draft without calling it.
 */
export const startForm = (root: HTMLElement, onEdit: (state: FormState) => void): FormView => {
  const conditions = root.querySelector<HTMLElement>("[data-conditions]")
  const responses = root.querySelector<HTMLElement>("[data-responses]")
  const radios = Array.from(root.querySelectorAll<HTMLInputElement>("input[name=mode]"))
  let current: FormState | undefined
  let problems: ReadonlyArray<FormProblem> = []
  let checked: ReadonlyArray<DraftPath> = []

  const clone = (name: string): HTMLElement => {
    const template = root.querySelector<HTMLTemplateElement>(`template[data-template="${name}"]`)
    const node = template?.content.firstElementChild?.cloneNode(true)
    if (!(node instanceof HTMLElement)) throw new Error(`the stub form has no ${name} template`)
    return node
  }

  const byKey = (key: string): HTMLElement | undefined =>
    Array.from(root.querySelectorAll<HTMLElement>("[data-k]")).find((el) => el.dataset.k === key)

  const focusable = (el: HTMLElement | undefined): el is HTMLElement =>
    el !== undefined && isVisible(el) && !el.hasAttribute("disabled")

  const focusKey = (key: string): boolean => {
    const el = byKey(key)
    if (!focusable(el)) return false
    el.focus()
    return true
  }

  const focusAny = (keys: ReadonlyArray<string>): void => {
    for (const key of keys) if (focusKey(key)) return
  }

  // The control a schema path is about: the one whose data-path is its longest prefix, else the
  // first control of its row or card
  const controlFor = (path: DraftPath): HTMLElement | undefined => {
    const controls = Array.from(root.querySelectorAll<HTMLElement>("[data-path]")).filter(isVisible)
    for (let length = path.length; length > 0; length--) {
      const key = pathKey(path.slice(0, length))
      const hit = controls.find((el) => el.dataset.path === key)
      if (hit !== undefined) return hit
    }
    const [head, index] = path
    if (typeof index !== "number") return undefined
    if (head === "predicates") return byKey(`c${String(index)}.field`)
    if (head === "responses") return byKey(`r${String(index)}.status`)
    return undefined
  }

  // aria-invalid on every control a problem is about: the form's own (by key) and a check's (by path)
  const syncMarks = (): void => {
    const bad = new Set<Element>()
    for (const problem of problems) {
      const el = byKey(problem.key)
      if (el !== undefined) bad.add(el)
    }
    for (const path of checked) {
      const el = controlFor(path)
      if (el !== undefined) bad.add(el)
    }
    for (const el of Array.from(root.querySelectorAll("[data-k], [data-path]"))) {
      if (bad.has(el)) el.setAttribute("aria-invalid", "true")
      else el.removeAttribute("aria-invalid")
    }
    // A body that is not JSON says why under itself, as the mockup does
    for (const area of Array.from(root.querySelectorAll<HTMLElement>("[data-c=body]"))) {
      const line = area.parentElement?.querySelector("[data-c=body-err]")
      if (line === null || line === undefined) continue
      const problem = problems.find((p) => p.key === area.dataset.k)
      line.textContent = problem === undefined ? "" : problem.message + BODY_HINT
      line.toggleAttribute("hidden", problem === undefined)
    }
  }

  const draw = (state: FormState): void => {
    conditions?.replaceChildren(...state.conditions.map((condition, i) => {
      const row = clone("condition")
      fill(row, conditionControls(condition, i))
      return row
    }))
    responses?.replaceChildren(...state.responses.map((response, i) => {
      const card = clone("response")
      fill(card, responseControls(response, i, state.responses.length))
      card.querySelector("[data-headers]")?.replaceChildren(...response.headers.map((header, h) => {
        const row = clone("header")
        fill(row, headerControls(header, i, h))
        return row
      }))
      return card
    }))
    const mode = state.mode ?? "sequential"
    for (const radio of radios) radio.checked = radio.value === mode
    syncMarks()
  }

  const show = (state: FormState): void => {
    const active = document.activeElement
    const key = active instanceof HTMLElement && root.contains(active) ? active.dataset.k : undefined
    current = state
    draw(state)
    if (key !== undefined) focusKey(key)
  }

  const run = (action: Action | undefined): void => {
    if (action === undefined || current === undefined || root.hidden) return
    current = applyFormEdit(current, action.edit)
    if (action.redraw === true) {
      draw(current)
      if (action.focus !== undefined) focusAny(action.focus)
    }
    onEdit(current)
  }

  root.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-k]") : null
    if (!(button instanceof HTMLButtonElement) || current === undefined) return
    run(clickAction(parseKey(button.dataset.k ?? ""), current))
  })

  const onValue = (event: Event): void => {
    const el = event.target
    if (el instanceof HTMLInputElement && el.type === "radio") {
      if (event.type === "change" && el.name === "mode" && el.checked && isOneOf(MODES, el.value)) {
        run({ edit: { _tag: "SetMode", mode: el.value } })
      }
      return
    }
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
      return
    }
    const key = el.dataset.k
    if (key === undefined) return
    // A select changes on "change"; text changes on "input"
    if ((el instanceof HTMLSelectElement) !== (event.type === "change")) return
    run(valueAction(parseKey(key), el.value))
    // The reason phrase follows the status as it is typed
    if (key.endsWith(".status")) {
      const reason = el.closest("[data-row=response]")?.querySelector("[data-c=reason]")
      if (reason !== null && reason !== undefined) reason.textContent = reasonPhrase(el.value)
    }
  }
  root.addEventListener("input", onValue)
  root.addEventListener("change", onValue)

  // A JSON body gets the JSON view's typing helpers: brackets and quotes close themselves
  root.addEventListener("keydown", (event) => {
    const area = event.target
    if (!(area instanceof HTMLTextAreaElement) || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
      return
    }
    const key = area.dataset.k ?? ""
    const index = Number(/^r(\d+)\.body$/.exec(key)?.[1] ?? Number.NaN)
    if (current?.responses[index]?.bodyKind !== "json" || event.key === "Tab" || event.key === "Escape") return
    const edit = editForKey(
      { text: area.value, start: area.selectionStart, end: area.selectionEnd },
      event.key,
      event.shiftKey
    )
    if (edit === null) return
    event.preventDefault()
    applyEdit(area, edit)
  })

  return {
    setActive: (active) => {
      root.hidden = !active
      for (const radio of radios) radio.disabled = !active
    },
    show,
    state: () => current,
    showProblems: (next) => {
      problems = next
      syncMarks()
    },
    markPaths: (paths) => {
      checked = paths
      syncMarks()
    },
    focusPath: (path) => {
      const el = controlFor(path)
      if (!focusable(el)) return false
      el.focus()
      return true
    },
    focusKey,
    focusFirst: () => {
      const first = Array.from(root.querySelectorAll<HTMLElement>("[data-k]")).find(focusable)
      first?.focus({ preventScroll: true })
    }
  }
}
