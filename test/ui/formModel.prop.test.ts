import { it } from "@effect/vitest"
import { buildDraft, DraftSpec, EditCase, shape, toFormEdit } from "imposters/test/helpers/formDrafts"
import { draftToText, parseDraftText } from "imposters/ui/editor/draftText"
import { applyFormEdit, type FormState, readForm, writeForm } from "imposters/ui/editor/formModel"
import { describe, expect } from "vitest"

// The stub form as properties of its pure model (src/ui/editor/formModel.ts): it never changes a
// draft it did not edit, and whatever it writes, the JSON view prints and reads back unchanged,
// and the form can show again. The same edits through the page are runtime-form.prop.test.ts.

const formOf = (draft: unknown): FormState => {
  const read = readForm(draft)
  if (!read.ok) throw new Error(`the form cannot show ${JSON.stringify(draft)}: ${read.reasons.join("; ")}`)
  return read.form
}

const throughJson = (draft: unknown): unknown => {
  const parsed = parseDraftText(draftToText(draft))
  if (!parsed.ok) throw new Error(`the JSON view cannot read back ${draftToText(draft)}: ${parsed.problem.message}`)
  return parsed.draft
}

describe("the stub form's model (property)", () => {
  it.prop(
    "shows any draft it can show without changing it, and the JSON view agrees",
    { spec: DraftSpec },
    ({ spec }) => {
      const draft = buildDraft(spec)
      const written = writeForm(formOf(draft))
      expect(written.ok).toBe(true)
      if (written.ok) expect(shape(written.draft)).toEqual(shape(draft))
      expect(shape(throughJson(draft))).toEqual(shape(draft))
    },
    { arbitrary: { runs: 500 } }
  )

  it.prop(
    "after any edits, its draft prints as JSON that reads back the same, and the form can show it again",
    { scenario: EditCase },
    ({ scenario }) => {
      let form = formOf(buildDraft(scenario.start))
      for (const edit of scenario.edits) {
        form = applyFormEdit(form, toFormEdit(edit))
        const written = writeForm(form)
        if (!written.ok) {
          expect(written.problems.length).toBeGreaterThan(0)
          continue
        }
        expect(shape(throughJson(written.draft))).toEqual(shape(written.draft))
        const again = writeForm(formOf(written.draft))
        expect(again.ok).toBe(true)
        if (again.ok) expect(shape(again.draft)).toEqual(shape(written.draft))
        // The last response cannot be removed
        expect(form.responses.length).toBeGreaterThan(0)
      }
    },
    { arbitrary: { runs: 500, size: 30 } }
  )
})
