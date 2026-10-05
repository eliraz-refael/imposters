import * as Schema from "effect/Schema"
import { BODY_KINDS, DELAY_KINDS, FIELDS, type FormEdit, MODES, OPERATORS } from "imposters/ui/editor/formModel"

/**
 * Schema-described inputs for the stub form's property tests: drafts the form can show (as a
 * spec, built into the encoded JSON shape by `buildDraft`), and sequences of form edits.
 * test/ui/formModel.prop.test.ts runs them on the pure model, test/ui/runtime-form.prop.test.ts
 * through the page.
 */

const Name = Schema.String.check(Schema.isMinLength(1))
const Ms = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60000 }))

const ScalarCondition = Schema.TaggedStruct("Scalar", {
  field: Schema.Literals(["method", "path", "body"]),
  operator: Schema.Literals(OPERATORS),
  value: Schema.optionalKey(Schema.String),
  caseSensitive: Schema.optionalKey(Schema.Boolean)
})

const NamedCondition = Schema.TaggedStruct("Named", {
  field: Schema.Literals(["headers", "query"]),
  operator: Schema.Literals(OPERATORS),
  name: Name,
  value: Schema.String,
  caseSensitive: Schema.optionalKey(Schema.Boolean)
})

const ResponseSpec = Schema.Struct({
  status: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  headers: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Name, value: Schema.String })).check(Schema.isMaxLength(3))
  ),
  body: Schema.optionalKey(Schema.Json),
  delay: Schema.optionalKey(Schema.Union([Ms, Schema.Struct({ a: Ms, b: Ms })]))
})

export const DraftSpec = Schema.Struct({
  predicates: Schema.optionalKey(
    Schema.Array(Schema.Union([ScalarCondition, NamedCondition])).check(Schema.isMaxLength(4))
  ),
  responses: Schema.optionalKey(Schema.Array(ResponseSpec).check(Schema.isMaxLength(3))),
  responseMode: Schema.optionalKey(Schema.Literals(MODES))
})
export type DraftSpec = typeof DraftSpec.Type

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// JSON has no -0 (JSON.stringify writes 0), so no draft the editor holds has one
const plainJson = (value: unknown): unknown => {
  if (Object.is(value, -0)) return 0
  if (Array.isArray(value)) return value.map(plainJson)
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainJson(v)]))
  return value
}

type ConditionSpec = typeof ScalarCondition.Type | typeof NamedCondition.Type
type ResponseSpec = typeof ResponseSpec.Type

const conditionDraft = (spec: ConditionSpec): Record<string, unknown> => ({
  field: spec.field,
  operator: spec.operator,
  ...(spec._tag === "Named"
    ? { value: Object.fromEntries([[spec.name, spec.value]]) }
    : spec.value === undefined
    ? {}
    : { value: spec.value }),
  ...(spec.caseSensitive === undefined ? {} : { caseSensitive: spec.caseSensitive })
})

const responseDraft = (spec: ResponseSpec): Record<string, unknown> => ({
  ...(spec.status === undefined ? {} : { status: spec.status }),
  ...(spec.headers === undefined
    ? {}
    : { headers: Object.fromEntries(spec.headers.map((header) => [header.name, header.value])) }),
  ...(spec.body === undefined ? {} : { body: plainJson(spec.body) }),
  ...(spec.delay === undefined
    ? {}
    : {
      delay: typeof spec.delay === "number"
        ? spec.delay
        : { min: Math.min(spec.delay.a, spec.delay.b), max: Math.max(spec.delay.a, spec.delay.b) }
    })
})

/** A draft the form can show, in the encoded (JSON) shape the editor holds */
export const buildDraft = (spec: DraftSpec): Record<string, unknown> => ({
  ...(spec.predicates === undefined ? {} : { predicates: spec.predicates.map(conditionDraft) }),
  ...(spec.responses === undefined ? {} : { responses: spec.responses.map(responseDraft) }),
  ...(spec.responseMode === undefined ? {} : { responseMode: spec.responseMode })
})

/**
 * A JSON value as plain structure, for comparing drafts: an object as its sorted entries, so a
 * key the draft really has but holds undefined still counts, and a key named "constructor" (which
 * toStrictEqual reads as the object's class) is just a key
 */
export const shape = (value: unknown): unknown => {
  if (Array.isArray(value)) return { list: value.map(shape) }
  if (isRecord(value)) {
    return {
      object: Object.entries(value)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => [key, shape(item)])
    }
  }
  return value
}

// ---------------------------------------------------------------- edits

// Small, so most edits land on a row or card that is there (one past the end: an edit of nothing)
const Index = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 }))
const HeaderIndex = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
// What a number input can hold, and a few things it cannot (it would give "" for those)
const NumberText = Schema.Literals(["", "200", "503", "2.5", "0", "60000", "-1", "1e3", "abc"])
const BodyText = Schema.Union([
  Schema.Literals(["", "{}", "[1, 2]", "{ \"a\": ", "\"text\"", "null", "{ \"x\": [true, 1.5] }"]),
  Schema.String
])
const Short = Schema.Union([Schema.Literals(["", "GET", "/orders", "content-type", "x"]), Schema.String])

export const Edit = Schema.Union([
  Schema.TaggedStruct("AddCondition", {}),
  Schema.TaggedStruct("RemoveCondition", { index: Index }),
  Schema.TaggedStruct("SetField", { index: Index, field: Schema.Literals(FIELDS) }),
  Schema.TaggedStruct("SetOperator", { index: Index, operator: Schema.Literals(OPERATORS) }),
  Schema.TaggedStruct("SetName", { index: Index, name: Short }),
  Schema.TaggedStruct("SetValue", { index: Index, value: Short }),
  Schema.TaggedStruct("ToggleCase", { index: Index }),
  Schema.TaggedStruct("AddResponse", {}),
  Schema.TaggedStruct("RemoveResponse", { index: Index }),
  Schema.TaggedStruct("MoveResponse", { index: Index, by: Schema.Literals([-1, 1]) }),
  Schema.TaggedStruct("SetStatus", { index: Index, raw: NumberText }),
  Schema.TaggedStruct("AddHeader", { index: Index }),
  Schema.TaggedStruct("RemoveHeader", { index: Index, header: HeaderIndex }),
  Schema.TaggedStruct("SetHeaderName", { index: Index, header: HeaderIndex, name: Short }),
  Schema.TaggedStruct("SetHeaderValue", { index: Index, header: HeaderIndex, value: Short }),
  Schema.TaggedStruct("SetBodyKind", { index: Index, kind: Schema.Literals(BODY_KINDS) }),
  Schema.TaggedStruct("SetBodyText", { index: Index, text: BodyText }),
  Schema.TaggedStruct("SetDelayKind", { index: Index, kind: Schema.Literals(DELAY_KINDS) }),
  Schema.TaggedStruct("SetDelay", { index: Index, part: Schema.Literals(["ms", "min", "max"]), raw: NumberText }),
  Schema.TaggedStruct("SetMode", { mode: Schema.Literals(MODES) })
])
export type Edit = typeof Edit.Type

// The schema's edit is the model's: this only proves the two agree at compile time
export const toFormEdit = (edit: Edit): FormEdit => edit

// Edits start from a stub with a response or more, as the editor's drafts do
export const EditCase = Schema.Struct({
  start: Schema.Struct({
    ...DraftSpec.fields,
    responses: Schema.Array(ResponseSpec).check(Schema.isMinLength(1), Schema.isMaxLength(3))
  }),
  edits: Schema.Array(Edit).check(Schema.isMinLength(8), Schema.isMaxLength(30))
})
export type EditCase = typeof EditCase.Type
