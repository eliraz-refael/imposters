import { pathKey } from "./draftText.js"
import {
  BODY_KINDS,
  type ConditionState,
  DELAY_KINDS,
  type HeaderState,
  isNamed,
  nameNoun,
  reasonPhrase,
  type ResponseState
} from "./formModel.js"

/**
 * What each control of the stub form shows, for a row or card at an index: its key (data-k, by
 * which the runtime routes an edit and restores the focus), its label, the schema path a problem
 * marks it by (data-path), its value and whether it is hidden, pressed or disabled. Pure and
 * shared: src/ui/pages/stubForm.ts renders the rows from it, and ui-assets/form.ts applies it to
 * a clone of a row's <template>, so both draw the same controls. Each control is found in its
 * row by `data-c="<name>"`.
 */

export interface Control {
  readonly k?: string
  readonly id?: string
  // aria-label
  readonly label?: string
  // data-path: the schema path a check's problem marks this control by
  readonly path?: string
  readonly hidden?: boolean
  readonly disabled?: boolean
  // aria-pressed
  readonly pressed?: boolean
  // An input's or textarea's value, a select's selected option
  readonly value?: string
  // The element's text
  readonly text?: string
  readonly placeholder?: string
  // A <label>'s for
  readonly htmlFor?: string
  readonly labelledBy?: string
  readonly describedBy?: string
}

export type Controls = Readonly<Record<string, Control>>

const VALUE_PLACEHOLDERS: Readonly<Record<string, string>> = {
  method: "GET",
  path: "/orders",
  body: "text in the body",
  headers: "value",
  query: "value"
}

export const conditionControls = (condition: ConditionState, index: number): Controls => {
  const n = String(index + 1)
  const c = `c${String(index)}`
  const named = isNamed(condition.field)
  const valuePath = pathKey(["predicates", index, "value"])
  const exists = condition.operator === "exists"
  return {
    field: {
      k: `${c}.field`,
      label: `Condition ${n} field`,
      path: pathKey(["predicates", index, "field"]),
      value: condition.field
    },
    operator: {
      k: `${c}.operator`,
      label: `Condition ${n} operator`,
      path: pathKey(["predicates", index, "operator"]),
      value: condition.operator
    },
    name: {
      k: `${c}.name`,
      label: `Condition ${n} ${nameNoun(condition.field)} name`,
      ...(named ? { path: valuePath } : {}),
      hidden: !named,
      value: condition.name,
      placeholder: `${nameNoun(condition.field)} name`
    },
    value: {
      k: `${c}.value`,
      label: `Condition ${n} value`,
      ...(named ? {} : { path: valuePath }),
      hidden: exists,
      value: condition.value ?? "",
      placeholder: VALUE_PLACEHOLDERS[condition.field] ?? ""
    },
    present: { hidden: !exists },
    case: {
      k: `${c}.case`,
      label: `Condition ${n} case sensitive`,
      path: pathKey(["predicates", index, "caseSensitive"]),
      pressed: condition.caseSensitive ?? true
    },
    remove: { k: `${c}.remove`, label: `Remove condition ${n}` }
  }
}

export const headerControls = (header: HeaderState, index: number, h: number): Controls => {
  const n = String(index + 1)
  const m = String(h + 1)
  const k = `r${String(index)}.h${String(h)}`
  return {
    name: {
      k: `${k}.name`,
      label: `Response ${n} header ${m} name`,
      path: pathKey(["responses", index, "headers"]),
      value: header.name,
      placeholder: "name"
    },
    value: {
      k: `${k}.value`,
      label: `Response ${n} header ${m} value`,
      path: pathKey(["responses", index, "headers", header.name]),
      value: header.value,
      placeholder: "value"
    },
    remove: { k: `${k}.remove`, label: `Remove response ${n} header ${m}` }
  }
}

export const responseControls = (response: ResponseState, index: number, count: number): Controls => {
  const n = String(index + 1)
  const r = `r${String(index)}`
  const id = `resp-${String(index)}`
  const kinds = Object.fromEntries(
    BODY_KINDS.map((kind) => [`kind-${kind}`, { k: `${r}.kind-${kind}`, pressed: response.bodyKind === kind }])
  )
  const delays = Object.fromEntries(
    DELAY_KINDS.map((kind) => [`delay-${kind}`, { k: `${r}.delay-${kind}`, pressed: response.delayKind === kind }])
  )
  return {
    card: { labelledBy: `${id}-title` },
    title: { id: `${id}-title`, text: `response ${n}` },
    up: { k: `${r}.up`, label: `Move response ${n} up`, disabled: index === 0 },
    down: { k: `${r}.down`, label: `Move response ${n} down`, disabled: index >= count - 1 },
    remove: { k: `${r}.remove`, label: `Remove response ${n}`, disabled: count <= 1 },
    "status-label": { htmlFor: `${id}-status` },
    status: {
      k: `${r}.status`,
      id: `${id}-status`,
      path: pathKey(["responses", index, "status"]),
      value: response.status,
      placeholder: "200"
    },
    reason: { text: reasonPhrase(response.status) },
    "add-header": { k: `${r}.add-header`, label: `Add a header to response ${n}` },
    kinds: { label: `Response ${n} body type` },
    ...kinds,
    body: {
      k: `${r}.body`,
      id: `${id}-body`,
      label: `Response ${n} body`,
      path: pathKey(["responses", index, "body"]),
      hidden: response.bodyKind === "none",
      value: response.bodyText,
      describedBy: `${id}-body-err`
    },
    "body-err": { id: `${id}-body-err`, hidden: true, text: "" },
    "body-hint": { hidden: response.bodyKind === "none" },
    delays: { label: `Response ${n} delay` },
    ...delays,
    fixed: { hidden: response.delayKind !== "fixed" },
    ms: {
      k: `${r}.ms`,
      label: `Response ${n} delay (ms)`,
      path: pathKey(["responses", index, "delay"]),
      value: response.ms
    },
    range: { hidden: response.delayKind !== "range" },
    min: {
      k: `${r}.min`,
      label: `Response ${n} delay, at least (ms)`,
      path: pathKey(["responses", index, "delay", "min"]),
      value: response.min
    },
    max: {
      k: `${r}.max`,
      label: `Response ${n} delay, at most (ms)`,
      path: pathKey(["responses", index, "delay", "max"]),
      value: response.max
    },
    "delay-hint": { hidden: response.delayKind !== "range" }
  }
}
