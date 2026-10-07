import { type DraftPath, draftToText, parseDraftText, pathKey } from "./draftText.js"

/**
 * The stub editor's form view, as pure functions over the same draft the JSON view edits:
 * `readForm` turns a draft into the form's state (or says what in it the form cannot show),
 * `writeForm` turns the state back into a draft (or says what the form holds that a draft
 * cannot), and `applyFormEdit` is every edit the form offers. Free of imports beyond
 * draftText.ts, because both sides use it: the server renders the form's rows from it, and the
 * browser runtime (ui-assets/form.ts) edits with it.
 *
 * The form never changes a draft it did not edit: for any draft readForm accepts,
 * writeForm(readForm(draft)) is the same draft, keys left out stay left out (a status of 200 by
 * default, caseSensitive, responseMode). A draft holding anything the form has no control for (a
 * body condition on JSON, two header names in one condition, a key the stub does not have) is
 * not shown at all: the form is unavailable for it and says why, and the JSON view edits it.
 */

// The stub schema's literals (src/schemas/StubSchema.ts), restated so the browser bundle needs
// no Effect; test/ui/formModel.test.ts checks they agree
export const FIELDS = ["method", "path", "headers", "query", "body"] as const
export type Field = (typeof FIELDS)[number]
export const OPERATORS = ["equals", "contains", "startsWith", "matches", "exists"] as const
export type Operator = (typeof OPERATORS)[number]
export const MODES = ["sequential", "random", "repeat"] as const
export type Mode = (typeof MODES)[number]
export const BODY_KINDS = ["json", "text", "none"] as const
export type BodyKind = (typeof BODY_KINDS)[number]
export const DELAY_KINDS = ["none", "fixed", "range"] as const
export type DelayKind = (typeof DELAY_KINDS)[number]

/** How the operator select names each operator */
export const OPERATOR_LABELS: Readonly<Record<Operator, string>> = {
  equals: "equals",
  contains: "contains",
  startsWith: "starts with",
  matches: "matches regex",
  exists: "exists"
}

/** headers and query compare one named value: the predicate's value is { name: value } */
export const isNamed = (field: Field): boolean => field === "headers" || field === "query"

/** What a named field's name is called: "header", "parameter" */
export const nameNoun = (field: Field): string => field === "query" ? "parameter" : "header"

export interface ConditionState {
  readonly field: Field
  readonly operator: Operator
  // headers and query: the name the value is keyed by
  readonly name: string
  // The value; undefined while the draft has none (`exists` ignores it)
  readonly value: string | undefined
  // undefined: not in the draft, so case-sensitive (the default)
  readonly caseSensitive: boolean | undefined
}

export interface HeaderState {
  readonly name: string
  readonly value: string
}

export interface ResponseState {
  // As typed; "" leaves it out of the draft (200, the default)
  readonly status: string
  readonly headers: ReadonlyArray<HeaderState>
  // The draft has a headers object even when it is empty
  readonly headersKey: boolean
  readonly bodyKind: BodyKind
  // The body as typed: JSON or text, by bodyKind; kept while the kind is none
  readonly bodyText: string
  readonly delayKind: DelayKind
  // Milliseconds as typed, for a fixed delay and for a range; kept while another kind is picked
  readonly ms: string
  readonly min: string
  readonly max: string
}

export interface FormState {
  readonly conditions: ReadonlyArray<ConditionState>
  // The draft has a predicates list even when it is empty
  readonly predicatesKey: boolean
  readonly responses: ReadonlyArray<ResponseState>
  readonly responsesKey: boolean
  // undefined: not in the draft (sequential, the default)
  readonly mode: Mode | undefined
}

export const NEW_CONDITION: ConditionState = {
  field: "path",
  operator: "equals",
  name: "",
  value: "",
  caseSensitive: undefined
}

export const NEW_HEADER: HeaderState = { name: "", value: "" }

export const NEW_RESPONSE: ResponseState = {
  status: "200",
  headers: [],
  headersKey: false,
  bodyKind: "none",
  bodyText: "",
  delayKind: "none",
  ms: "",
  min: "",
  max: ""
}

// ---------------------------------------------------------------- reading a draft

export type FormRead =
  | { readonly ok: true; readonly form: FormState }
  // What the form cannot show, as phrases: "condition 2 compares the body with JSON"
  | { readonly ok: false; readonly reasons: ReadonlyArray<string> }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isOneOf = <A extends string>(options: ReadonlyArray<A>, value: unknown): value is A =>
  options.some((option) => option === value)

const MAX_SHOWN = 30

const shown = (value: unknown): string => {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN - 1)}…` : text
}

const keyList = (keys: ReadonlyArray<string>): string => keys.map((key) => JSON.stringify(key)).join(", ")

const unknownKeys = (record: Record<string, unknown>, known: ReadonlyArray<string>): ReadonlyArray<string> =>
  Object.keys(record).filter((key) => !known.includes(key))

// -0 prints as "0", which reads back as 0: keep its sign
const numberText = (n: number): string => Object.is(n, -0) ? "-0" : String(n)

// A named field's { name: value }, or what keeps the form from showing it
const readNamed = (value: unknown, noun: string): readonly [string, string] | string => {
  if (!isRecord(value)) return "'s value isn't a { name: value } object"
  const entries = Object.entries(value)
  const [entry] = entries
  if (entry === undefined) return ` names no ${noun}`
  if (entries.length > 1) return ` checks ${String(entries.length)} ${noun}s at once`
  const [name, text] = entry
  if (name === "") return ` has an empty ${noun} name`
  if (typeof text !== "string") return `'s ${noun} value isn't text`
  return [name, text]
}

const readCondition = (input: unknown, index: number, reasons: Array<string>): ConditionState | undefined => {
  const where = `condition ${String(index + 1)}`
  if (!isRecord(input)) {
    reasons.push(`${where} isn't an object`)
    return undefined
  }
  const before = reasons.length
  const extra = unknownKeys(input, ["field", "operator", "value", "caseSensitive"])
  if (extra.length > 0) reasons.push(`${where} has ${keyList(extra)}, which a condition doesn't have`)
  const { caseSensitive, field, operator, value } = input
  if (!isOneOf(FIELDS, field)) reasons.push(`${where}'s field ${shown(field)} isn't one the form offers`)
  if (!isOneOf(OPERATORS, operator)) reasons.push(`${where}'s operator ${shown(operator)} isn't one the form offers`)
  if (caseSensitive !== undefined && typeof caseSensitive !== "boolean") {
    reasons.push(`${where}'s caseSensitive isn't true or false`)
  }
  if (!isOneOf(FIELDS, field) || !isOneOf(OPERATORS, operator)) return undefined
  const sense = typeof caseSensitive === "boolean" ? caseSensitive : undefined
  if (isNamed(field)) {
    const named = readNamed(value, nameNoun(field))
    if (typeof named === "string") reasons.push(`${where}${named}`)
    if (reasons.length > before || typeof named === "string") return undefined
    return { field, operator, name: named[0], value: named[1], caseSensitive: sense }
  }
  if (value !== undefined && typeof value !== "string") {
    reasons.push(field === "body" ? `${where} compares the body with JSON, not text` : `${where}'s value isn't text`)
    return undefined
  }
  if (reasons.length > before) return undefined
  return { field, operator, name: "", value, caseSensitive: sense }
}

const readHeaders = (
  input: unknown,
  where: string,
  reasons: Array<string>
): ReadonlyArray<HeaderState> | undefined => {
  if (input === undefined) return []
  if (!isRecord(input)) {
    reasons.push(`${where}'s headers aren't an object of names and values`)
    return undefined
  }
  const headers: Array<HeaderState> = []
  for (const [name, value] of Object.entries(input)) {
    if (name === "") reasons.push(`${where} has a header with an empty name`)
    else if (typeof value !== "string") reasons.push(`${where}'s header ${JSON.stringify(name)} isn't text`)
    else headers.push({ name, value })
  }
  return headers.length === Object.keys(input).length ? headers : undefined
}

type DelayRead = Pick<ResponseState, "delayKind" | "ms" | "min" | "max">

const readDelay = (input: unknown, where: string, reasons: Array<string>): DelayRead | undefined => {
  if (input === undefined) return { delayKind: "none", ms: "", min: "", max: "" }
  if (typeof input === "number") return { delayKind: "fixed", ms: numberText(input), min: "", max: "" }
  if (
    isRecord(input) && Object.keys(input).length === 2 &&
    typeof input.min === "number" && typeof input.max === "number"
  ) {
    return { delayKind: "range", ms: "", min: numberText(input.min), max: numberText(input.max) }
  }
  reasons.push(`${where}'s delay isn't a number or a { "min", "max" } range`)
  return undefined
}

const readResponse = (input: unknown, index: number, reasons: Array<string>): ResponseState | undefined => {
  const where = `response ${String(index + 1)}`
  if (!isRecord(input)) {
    reasons.push(`${where} isn't an object`)
    return undefined
  }
  const before = reasons.length
  // Callbacks are a response field the form has no section for yet: the stub opens in JSON
  if (Object.hasOwn(input, "callbacks")) reasons.push(`${where} has callbacks, which the form can't show yet`)
  const extra = unknownKeys(input, ["status", "headers", "body", "delay", "callbacks"])
  if (extra.length > 0) reasons.push(`${where} has ${keyList(extra)}, which a response doesn't have`)
  const { body, status } = input
  if (status !== undefined && typeof status !== "number") {
    reasons.push(`${where}'s status ${shown(status)} isn't a number`)
  }
  const headers = readHeaders(input.headers, where, reasons)
  const delay = readDelay(input.delay, where, reasons)
  if (reasons.length > before || headers === undefined || delay === undefined) return undefined
  return {
    status: typeof status === "number" ? numberText(status) : "",
    headers,
    headersKey: input.headers !== undefined,
    bodyKind: body === undefined ? "none" : typeof body === "string" ? "text" : "json",
    bodyText: body === undefined ? "" : typeof body === "string" ? body : draftToText(body),
    ...delay
  }
}

const readList = <A>(
  input: unknown,
  name: string,
  read: (item: unknown, index: number, reasons: Array<string>) => A | undefined,
  reasons: Array<string>
): ReadonlyArray<A> => {
  if (input === undefined) return []
  if (!Array.isArray(input)) {
    reasons.push(`${name} isn't a list`)
    return []
  }
  const items: Array<A> = []
  input.forEach((item: unknown, index) => {
    const got = read(item, index, reasons)
    if (got !== undefined) items.push(got)
  })
  return items
}

/** The form's state for a draft, or every reason the form cannot show it */
export const readForm = (draft: unknown): FormRead => {
  if (!isRecord(draft)) return { ok: false, reasons: ["the stub isn't a JSON object"] }
  const reasons: Array<string> = []
  const extra = unknownKeys(draft, ["predicates", "responses", "responseMode"])
  if (extra.length > 0) reasons.push(`the stub has ${keyList(extra)}, which a stub doesn't have`)
  const conditions = readList(draft.predicates, "predicates", readCondition, reasons)
  const responses = readList(draft.responses, "responses", readResponse, reasons)
  const mode = draft.responseMode
  if (mode !== undefined && !isOneOf(MODES, mode)) {
    reasons.push(`the response mode ${shown(mode)} isn't one the form offers`)
  }
  if (reasons.length > 0) return { ok: false, reasons }
  return {
    ok: true,
    form: {
      conditions,
      predicatesKey: draft.predicates !== undefined,
      responses,
      responsesKey: draft.responses !== undefined,
      mode: isOneOf(MODES, mode) ? mode : undefined
    }
  }
}

// ---------------------------------------------------------------- writing a draft

/**
 * Something the form holds that a draft cannot (a body that is not JSON yet, a header with no
 * name): the control it is about (its data-k), where that is in words, and what to do
 */
export interface FormProblem {
  readonly key: string
  readonly label: string
  readonly message: string
}

export type FormWrite =
  | { readonly ok: true; readonly draft: Record<string, unknown> }
  | { readonly ok: false; readonly problems: ReadonlyArray<FormProblem> }

// A number input's text as a number; undefined when it holds none
const numberIn = (raw: string): number | undefined => {
  if (raw.trim() === "") return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

// Built with fromEntries, so a name like "__proto__" is an ordinary key
const record = (entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> =>
  Object.fromEntries(entries)

const conditionDraft = (condition: ConditionState): Record<string, unknown> => ({
  field: condition.field,
  operator: condition.operator,
  ...(isNamed(condition.field)
    ? { value: record([[condition.name, condition.value ?? ""]]) }
    : condition.value === undefined
    ? {}
    : { value: condition.value }),
  ...(condition.caseSensitive === undefined ? {} : { caseSensitive: condition.caseSensitive })
})

const conditionProblems = (condition: ConditionState, index: number): ReadonlyArray<FormProblem> =>
  isNamed(condition.field) && condition.name === ""
    ? [{
      key: `c${String(index)}.name`,
      label: `condition ${String(index + 1)}`,
      message: `name the ${nameNoun(condition.field)} to check`
    }]
    : []

/** The body of a JSON-kind response, or what is wrong with its text (line and column) */
export const parseBody = (text: string): { readonly ok: true; readonly value: unknown } | {
  readonly ok: false
  readonly message: string
} => {
  if (text.trim() === "") return { ok: false, message: "the body is empty: write some JSON, or pick text or none" }
  const parsed = parseDraftText(text, "body")
  if (parsed.ok) return { ok: true, value: parsed.draft }
  const { column, line, message } = parsed.problem
  return { ok: false, message: `line ${String(line)}, column ${String(column)}: ${message}` }
}

// What a response is in the draft, or the problems that keep it out
const responseDraft = (
  response: ResponseState,
  index: number
): { readonly draft: Record<string, unknown>; readonly problems: ReadonlyArray<FormProblem> } => {
  const r = `r${String(index)}`
  const label = `response ${String(index + 1)}`
  const problems: Array<FormProblem> = []
  const problem = (key: string, at: string, message: string): void => {
    problems.push({ key: `${r}.${key}`, label: at === "" ? label : `${label} · ${at}`, message })
  }

  const status = numberIn(response.status)
  if (response.status.trim() !== "" && status === undefined) problem("status", "status", "write a number, like 200")

  const seen = new Set<string>()
  response.headers.forEach((header, h) => {
    const at = `header ${String(h + 1)}`
    if (header.name === "") problem(`h${String(h)}.name`, at, "give the header a name, or remove it")
    else if (seen.has(header.name)) problem(`h${String(h)}.name`, at, `${header.name} is already set above`)
    seen.add(header.name)
  })

  let body: { readonly value: unknown } | undefined
  if (response.bodyKind === "text") body = { value: response.bodyText }
  if (response.bodyKind === "json") {
    const parsed = parseBody(response.bodyText)
    if (parsed.ok) body = { value: parsed.value }
    else problem("body", "body", parsed.message)
  }

  let delay: { readonly value: unknown } | undefined
  if (response.delayKind === "fixed") {
    const ms = numberIn(response.ms)
    if (ms === undefined) problem("ms", "delay", "write the delay in milliseconds, or pick none")
    else delay = { value: ms }
  }
  if (response.delayKind === "range") {
    const min = numberIn(response.min)
    const max = numberIn(response.max)
    if (min === undefined) problem("min", "delay", "write the shortest delay in milliseconds")
    if (max === undefined) problem("max", "delay", "write the longest delay in milliseconds")
    if (min !== undefined && max !== undefined) delay = { value: { min, max } }
  }

  const draft: Record<string, unknown> = {
    ...(status === undefined ? {} : { status }),
    ...(response.headers.length > 0 || response.headersKey
      ? { headers: record(response.headers.map((header) => [header.name, header.value])) }
      : {}),
    ...(body === undefined ? {} : { body: body.value }),
    ...(delay === undefined ? {} : { delay: delay.value })
  }
  return { draft, problems }
}

/** The draft the form holds, or every problem that keeps it from being one */
export const writeForm = (form: FormState): FormWrite => {
  const responses = form.responses.map(responseDraft)
  const problems = [
    ...form.conditions.flatMap(conditionProblems),
    ...responses.flatMap((response) => response.problems)
  ]
  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    draft: {
      ...(form.conditions.length > 0 || form.predicatesKey ? { predicates: form.conditions.map(conditionDraft) } : {}),
      ...(form.responses.length > 0 || form.responsesKey
        ? { responses: responses.map((response) => response.draft) }
        : {}),
      ...(form.mode === undefined ? {} : { responseMode: form.mode })
    }
  }
}

// ---------------------------------------------------------------- editing

/** Every edit the form makes, by the index of the row or card it is in */
export type FormEdit =
  | { readonly _tag: "AddCondition" }
  | { readonly _tag: "RemoveCondition"; readonly index: number }
  | { readonly _tag: "SetField"; readonly index: number; readonly field: Field }
  | { readonly _tag: "SetOperator"; readonly index: number; readonly operator: Operator }
  | { readonly _tag: "SetName"; readonly index: number; readonly name: string }
  | { readonly _tag: "SetValue"; readonly index: number; readonly value: string }
  | { readonly _tag: "ToggleCase"; readonly index: number }
  | { readonly _tag: "AddResponse" }
  | { readonly _tag: "RemoveResponse"; readonly index: number }
  | { readonly _tag: "MoveResponse"; readonly index: number; readonly by: -1 | 1 }
  | { readonly _tag: "SetStatus"; readonly index: number; readonly raw: string }
  | { readonly _tag: "AddHeader"; readonly index: number }
  | { readonly _tag: "RemoveHeader"; readonly index: number; readonly header: number }
  | { readonly _tag: "SetHeaderName"; readonly index: number; readonly header: number; readonly name: string }
  | { readonly _tag: "SetHeaderValue"; readonly index: number; readonly header: number; readonly value: string }
  | { readonly _tag: "SetBodyKind"; readonly index: number; readonly kind: BodyKind }
  | { readonly _tag: "SetBodyText"; readonly index: number; readonly text: string }
  | { readonly _tag: "SetDelayKind"; readonly index: number; readonly kind: DelayKind }
  | { readonly _tag: "SetDelay"; readonly index: number; readonly part: "ms" | "min" | "max"; readonly raw: string }
  | { readonly _tag: "SetMode"; readonly mode: Mode }

const replaceAt = <A>(items: ReadonlyArray<A>, index: number, change: (item: A) => A): ReadonlyArray<A> =>
  items.map((item, i) => i === index ? change(item) : item)

const removeAt = <A>(items: ReadonlyArray<A>, index: number): ReadonlyArray<A> => items.filter((_, i) => i !== index)

const DEFAULT_MS = "500"
const DEFAULT_MIN = "100"
const DEFAULT_MAX = "800"

// A delay kind picked: its inputs start from what the other kind held, else from an example
const withDelayKind = (response: ResponseState, kind: DelayKind): ResponseState => {
  if (kind === "fixed") return { ...response, delayKind: kind, ms: response.ms || response.min || DEFAULT_MS }
  if (kind === "range") {
    const min = response.min || response.ms || DEFAULT_MIN
    const max = response.max || (Number(min) > Number(DEFAULT_MAX) ? min : DEFAULT_MAX)
    return { ...response, delayKind: kind, min, max }
  }
  return { ...response, delayKind: kind }
}

const editCondition = (form: FormState, index: number, change: (c: ConditionState) => ConditionState): FormState => ({
  ...form,
  conditions: replaceAt(form.conditions, index, change)
})

const editResponse = (form: FormState, index: number, change: (r: ResponseState) => ResponseState): FormState => ({
  ...form,
  responses: replaceAt(form.responses, index, change)
})

const editHeader = (
  form: FormState,
  index: number,
  header: number,
  change: (h: HeaderState) => HeaderState
): FormState => editResponse(form, index, (r) => ({ ...r, headers: replaceAt(r.headers, header, change) }))

/** The form after an edit; an edit of a row or card that is not there changes nothing */
export const applyFormEdit = (form: FormState, edit: FormEdit): FormState => {
  switch (edit._tag) {
    case "AddCondition":
      return { ...form, conditions: [...form.conditions, NEW_CONDITION] }
    case "RemoveCondition":
      return { ...form, conditions: removeAt(form.conditions, edit.index) }
    case "SetField":
      return editCondition(form, edit.index, (c) => ({ ...c, field: edit.field }))
    case "SetOperator":
      // exists still needs a value in the draft (the schema asks for one; it is ignored)
      return editCondition(form, edit.index, (c) => ({
        ...c,
        operator: edit.operator,
        value: edit.operator === "exists" ? (c.value ?? "") : c.value
      }))
    case "SetName":
      return editCondition(form, edit.index, (c) => ({ ...c, name: edit.name }))
    case "SetValue":
      return editCondition(form, edit.index, (c) => ({ ...c, value: edit.value }))
    case "ToggleCase":
      // Off writes caseSensitive: false; on again leaves it out, as the default
      return editCondition(
        form,
        edit.index,
        (c) => ({ ...c, caseSensitive: (c.caseSensitive ?? true) ? false : undefined })
      )
    case "AddResponse":
      return { ...form, responses: [...form.responses, NEW_RESPONSE] }
    case "RemoveResponse":
      // A stub needs a response: the last one stays
      return form.responses.length > 1 ? { ...form, responses: removeAt(form.responses, edit.index) } : form
    case "MoveResponse": {
      const to = edit.index + edit.by
      const moving = form.responses[edit.index]
      const other = form.responses[to]
      if (moving === undefined || other === undefined) return form
      return {
        ...form,
        responses: form.responses.map((r, i) => i === edit.index ? other : i === to ? moving : r)
      }
    }
    case "SetStatus":
      return editResponse(form, edit.index, (r) => ({ ...r, status: edit.raw }))
    case "AddHeader":
      return editResponse(form, edit.index, (r) => ({ ...r, headers: [...r.headers, NEW_HEADER] }))
    case "RemoveHeader":
      return editResponse(form, edit.index, (r) => ({ ...r, headers: removeAt(r.headers, edit.header) }))
    case "SetHeaderName":
      return editHeader(form, edit.index, edit.header, (h) => ({ ...h, name: edit.name }))
    case "SetHeaderValue":
      return editHeader(form, edit.index, edit.header, (h) => ({ ...h, value: edit.value }))
    case "SetBodyKind":
      // JSON starts from an empty object rather than an empty (invalid) text
      return editResponse(form, edit.index, (r) => ({
        ...r,
        bodyKind: edit.kind,
        bodyText: edit.kind === "json" && r.bodyText.trim() === "" ? "{}" : r.bodyText
      }))
    case "SetBodyText":
      return editResponse(form, edit.index, (r) => ({ ...r, bodyText: edit.text }))
    case "SetDelayKind":
      return editResponse(form, edit.index, (r) => withDelayKind(r, edit.kind))
    case "SetDelay":
      return editResponse(form, edit.index, (r) => ({ ...r, [edit.part]: edit.raw }))
    case "SetMode":
      return { ...form, mode: edit.mode }
  }
}

// ---------------------------------------------------------------- words

/** Where a schema path is, as the form names it: "response 1 · status", "condition 2 · operator" */
export const fieldLabel = (path: DraftPath): string => {
  const [head, index, field, name] = path
  if (head === undefined) return "the stub"
  if (head === "responseMode") return "response order"
  if (head === "predicates") {
    if (typeof index !== "number") return "conditions"
    const at = `condition ${String(index + 1)}`
    return typeof field === "string" ? `${at} · ${field === "caseSensitive" ? "case" : field}` : at
  }
  if (head === "responses") {
    if (typeof index !== "number") return "responses"
    const at = `response ${String(index + 1)}`
    if (field === "headers" && typeof name === "string") return `${at} · header ${name}`
    return typeof field === "string" ? `${at} · ${field}` : at
  }
  return pathKey(path)
}

/**
 * A schema message split at the path it starts with ("responses[0].status must be …"), so the
 * form can name the place its own way; undefined when it starts with none of the path
 */
export const splitMessage = (
  message: string,
  path: DraftPath
): { readonly at: DraftPath; readonly rest: string } | undefined => {
  for (let length = path.length; length > 0; length--) {
    const at = path.slice(0, length)
    const written = pathKey(at)
    const after = message.charAt(written.length)
    if (message.startsWith(written) && (after === " " || after === ":")) {
      return { at, rest: message.slice(written.length) }
    }
  }
  return undefined
}

const REASONS: Readonly<Record<number, string>> = {
  100: "Continue",
  101: "Switching Protocols",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Content Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a teapot",
  421: "Misdirected Request",
  422: "Unprocessable Content",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  507: "Insufficient Storage",
  508: "Loop Detected",
  511: "Network Authentication Required"
}

/** What a status input's text means, beside it: "OK", "Service Unavailable"; "" for a code with no name */
export const reasonPhrase = (raw: string): string => {
  if (raw.trim() === "") return "OK (the default)"
  const status = Number(raw)
  if (!Number.isInteger(status) || status < 100 || status > 599) return "not a status: 100–599"
  return REASONS[status] ?? ""
}
