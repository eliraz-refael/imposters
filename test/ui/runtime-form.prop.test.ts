// @vitest-environment happy-dom
import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { buildDraft, type Edit, EditCase, shape, toFormEdit } from "imposters/test/helpers/formDrafts"
import { control, element, flush, mount, status, textDraft, useEditorHarness } from "imposters/test/helpers/stubEditor"
import { draftToText } from "imposters/ui/editor/draftText"
import { applyFormEdit, type FormEdit, type FormState, readForm, writeForm } from "imposters/ui/editor/formModel"
import { describe, expect } from "vitest"

// The stub form in the page as a property: random edits made the way a user makes them (clicks,
// typing, picking), on a random draft the form can show. After every edit the JSON textarea (what
// the editor posts) holds exactly the draft the pure model makes of the same edits, or, while
// the form holds something a draft cannot, the last draft it could; then the status says what to
// fix and "add stub" is off. The model alone is formModel.prop.test.ts.

useEditorHarness()

const input = (key: string, value: string): string | undefined => {
  const el = control<HTMLInputElement | HTMLTextAreaElement>(key)
  if (el === undefined) return undefined
  el.value = value
  el.dispatchEvent(new Event("input", { bubbles: true }))
  // What the control holds: a number input keeps only a number
  return el.value
}

const click = (key: string): boolean => {
  const el = control<HTMLButtonElement>(key)
  if (el === undefined || el.disabled) return false
  el.click()
  return true
}

// Makes the edit in the page; the model gets the same edit, with what the control took
const drive = (edit: Edit, model: FormState): FormState => {
  const apply = (value: FormEdit = toFormEdit(edit)): FormState => applyFormEdit(model, value)
  switch (edit._tag) {
    case "AddCondition":
      return click("add-condition") ? apply() : model
    case "RemoveCondition":
      return click(`c${String(edit.index)}.remove`) ? apply() : model
    case "SetField":
    case "SetOperator": {
      const part = edit._tag === "SetField" ? "field" : "operator"
      const el = control<HTMLSelectElement>(`c${String(edit.index)}.${part}`)
      if (el === undefined) return model
      el.value = edit._tag === "SetField" ? edit.field : edit.operator
      el.dispatchEvent(new Event("change", { bubbles: true }))
      return apply()
    }
    case "SetName": {
      const name = input(`c${String(edit.index)}.name`, edit.name)
      return name === undefined ? model : apply({ ...edit, name })
    }
    case "SetValue": {
      const value = input(`c${String(edit.index)}.value`, edit.value)
      return value === undefined ? model : apply({ ...edit, value })
    }
    case "ToggleCase":
      return click(`c${String(edit.index)}.case`) ? apply() : model
    case "AddResponse":
      return click("add-response") ? apply() : model
    case "RemoveResponse":
      return click(`r${String(edit.index)}.remove`) ? apply() : model
    case "MoveResponse":
      return click(`r${String(edit.index)}.${edit.by < 0 ? "up" : "down"}`) ? apply() : model
    case "SetStatus": {
      const raw = input(`r${String(edit.index)}.status`, edit.raw)
      return raw === undefined ? model : apply({ ...edit, raw })
    }
    case "AddHeader":
      return click(`r${String(edit.index)}.add-header`) ? apply() : model
    case "RemoveHeader":
      return click(`r${String(edit.index)}.h${String(edit.header)}.remove`) ? apply() : model
    case "SetHeaderName": {
      const name = input(`r${String(edit.index)}.h${String(edit.header)}.name`, edit.name)
      return name === undefined ? model : apply({ ...edit, name })
    }
    case "SetHeaderValue": {
      const value = input(`r${String(edit.index)}.h${String(edit.header)}.value`, edit.value)
      return value === undefined ? model : apply({ ...edit, value })
    }
    case "SetBodyKind":
      return click(`r${String(edit.index)}.kind-${edit.kind}`) ? apply() : model
    case "SetBodyText": {
      const text = input(`r${String(edit.index)}.body`, edit.text)
      return text === undefined ? model : apply({ ...edit, text })
    }
    case "SetDelayKind":
      return click(`r${String(edit.index)}.delay-${edit.kind}`) ? apply() : model
    case "SetDelay": {
      const raw = input(`r${String(edit.index)}.${edit.part}`, edit.raw)
      return raw === undefined ? model : apply({ ...edit, raw })
    }
    case "SetMode": {
      // Clicking the checked radio changes nothing, in the page or the model
      const radio = document.querySelector<HTMLInputElement>(`input[name=mode][value="${edit.mode}"]`)
      if (radio === null || radio.checked) return model
      radio.click()
      return apply()
    }
  }
}

const runCase = async ({ edits, start }: EditCase): Promise<void> => {
  const draft = buildDraft(start)
  const read = readForm(draft)
  if (!read.ok) throw new Error(read.reasons.join("; "))
  await mount(draftToText(draft))
  let model = read.form
  let lastGood: unknown = draft
  for (const [at, edit] of edits.entries()) {
    model = drive(edit, model)
    await flush()
    const where = `after edit ${String(at)} of ${JSON.stringify(edits.slice(0, at + 1))}`
    const written = writeForm(model)
    if (written.ok) lastGood = written.draft
    expect(shape(textDraft()), where).toEqual(shape(lastGood))
    expect(element<HTMLButtonElement>("button[type=submit]").disabled, where).toBe(!written.ok)
    if (!written.ok) expect(status().textContent, where).toMatch(/to fix/)
    expect(document.querySelectorAll("[data-row=condition]").length, where).toBe(model.conditions.length)
    expect(document.querySelectorAll("[data-row=response]").length, where).toBe(model.responses.length)
  }
}

describe("the stub form in the page (property)", () => {
  it.effect.prop(
    "the JSON it posts is always the draft the model makes of the same edits",
    { scenario: EditCase },
    ({ scenario }) => Effect.promise(() => runCase(scenario)),
    { timeout: 120_000, arbitrary: { runs: 200, size: 30 } }
  )
})
