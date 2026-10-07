import { PredicateField, PredicateOperator, ResponseMode } from "imposters/schemas/StubSchema"
import {
  applyFormEdit,
  fieldLabel,
  FIELDS,
  type FormState,
  MODES,
  NEW_RESPONSE,
  OPERATORS,
  readForm,
  reasonPhrase,
  splitMessage,
  writeForm
} from "imposters/ui/editor/formModel"
import { describe, expect, it } from "vitest"

// The stub form's pure model: what it cannot show (and says why), what it cannot write yet, its
// edits' defaults, and the words it puts on schema problems. The round trips are properties, in
// formModel.prop.test.ts.

const reasonsFor = (draft: unknown): ReadonlyArray<string> => {
  const read = readForm(draft)
  return read.ok ? [] : read.reasons
}

const formOf = (draft: unknown): FormState => {
  const read = readForm(draft)
  if (!read.ok) throw new Error(read.reasons.join("; "))
  return read.form
}

const ONE = { responses: [{ status: 200 }] }

describe("readForm", () => {
  it("restates the schema's literals (the browser bundle has no Effect)", () => {
    expect(FIELDS).toEqual(PredicateField.literals)
    expect(OPERATORS).toEqual(PredicateOperator.literals)
    expect(MODES).toEqual(ResponseMode.literals)
  })

  it("says what it cannot show, rather than dropping it", () => {
    expect(reasonsFor([ONE])).toEqual(["the stub isn't a JSON object"])
    expect(reasonsFor({ ...ONE, name: "x" })).toEqual([`the stub has "name", which a stub doesn't have`])
    expect(reasonsFor({ ...ONE, predicates: [{ field: "body", operator: "equals", value: { a: 1 } }] })).toEqual([
      "condition 1 compares the body with JSON, not text"
    ])
    expect(reasonsFor({ ...ONE, predicates: [{ field: "headers", operator: "equals", value: { a: "1", b: "2" } }] }))
      .toEqual(["condition 1 checks 2 headers at once"])
    expect(reasonsFor({ ...ONE, predicates: [{ field: "query", operator: "equals", value: { a: 1 } }] })).toEqual([
      "condition 1's parameter value isn't text"
    ])
    expect(reasonsFor({ ...ONE, predicates: [{ field: "headers", operator: "exists", value: {} }] })).toEqual([
      "condition 1 names no header"
    ])
    expect(reasonsFor({ ...ONE, predicates: [{ field: "url", operator: "equals", value: "/" }] })).toEqual([
      `condition 1's field "url" isn't one the form offers`
    ])
    expect(reasonsFor({ responses: [{ status: "ok", headers: { a: 1 }, delay: "slow" }] })).toEqual([
      `response 1's status "ok" isn't a number`,
      `response 1's header "a" isn't text`,
      `response 1's delay isn't a number or a { "min", "max" } range`
    ])
    // Callbacks are real, but the form has no section for them yet: the stub opens in JSON
    expect(reasonsFor({ responses: [{ status: 200 }, { status: 200, callbacks: { after: [] } }] })).toEqual([
      `response 2 has callbacks, which the form can't show yet`
    ])
    expect(reasonsFor({ responses: [{ status: 200, extra: 1 }] })).toEqual([
      `response 1 has "extra", which a response doesn't have`
    ])
    expect(reasonsFor({ ...ONE, responseMode: "loop" })).toEqual([`the response mode "loop" isn't one the form offers`])
  })

  it("shows what the schema would still refuse, so the check can say so beside the control", () => {
    // A status out of range and a range the wrong way round are numbers: the form shows them
    expect(reasonsFor({ responses: [{ status: 700, delay: { min: 9, max: 1 } }] })).toEqual([])
    // No responses at all: an empty form, with "add response"
    expect(formOf({}).responses).toEqual([])
  })

  it("a body is JSON, text or none, by what the draft holds", () => {
    const form = formOf({ responses: [{ body: { a: 1 } }, { body: "hi" }, {}, { body: null }] })
    expect(form.responses.map((r) => [r.bodyKind, r.bodyText])).toEqual([
      ["json", `{ "a": 1 }`],
      ["text", "hi"],
      ["none", ""],
      ["json", "null"]
    ])
  })
})

describe("writeForm", () => {
  it("leaves out what the draft left out, and writes back what it had", () => {
    const draft = { predicates: [], responses: [{ headers: {} }] }
    expect(writeForm(formOf(draft))).toEqual({ ok: true, draft })
    expect(writeForm(formOf({ responses: [{}] }))).toEqual({ ok: true, draft: { responses: [{}] } })
  })

  it("names everything it cannot write yet, by control", () => {
    const form: FormState = {
      conditions: [{ field: "headers", operator: "equals", name: "", value: "x", caseSensitive: undefined }],
      predicatesKey: true,
      responses: [{
        ...NEW_RESPONSE,
        headers: [{ name: "a", value: "1" }, { name: "a", value: "2" }, { name: "", value: "3" }],
        bodyKind: "json",
        bodyText: "{ \"a\": ",
        delayKind: "range",
        min: "",
        max: "5"
      }],
      responsesKey: true,
      mode: undefined
    }
    const written = writeForm(form)
    expect(written.ok).toBe(false)
    if (written.ok) return
    expect(written.problems.map((p) => `${p.key} | ${p.label}: ${p.message}`)).toEqual([
      "c0.name | condition 1: name the header to check",
      "r0.h1.name | response 1 · header 2: a is already set above",
      "r0.h2.name | response 1 · header 3: give the header a name, or remove it",
      "r0.body | response 1 · body: line 1, column 8: the text ends early: expected a value: a string in double quotes, a number, true, false, null, an object or a list",
      "r0.min | response 1 · delay: write the shortest delay in milliseconds"
    ])
  })

  it("an empty JSON body and an empty fixed delay are problems, not a silent default", () => {
    const form = formOf({ responses: [{ body: {}, delay: 5 }] })
    const blank = applyFormEdit(applyFormEdit(form, { _tag: "SetBodyText", index: 0, text: "  " }), {
      _tag: "SetDelay",
      index: 0,
      part: "ms",
      raw: ""
    })
    const written = writeForm(blank)
    expect(written.ok ? [] : written.problems.map((p) => p.message)).toEqual([
      "the body is empty: write some JSON, or pick text or none",
      "write the delay in milliseconds, or pick none"
    ])
  })
})

describe("applyFormEdit", () => {
  it("the Aa toggle: off writes false, on again leaves the key out", () => {
    const form = formOf({ ...ONE, predicates: [{ field: "path", operator: "equals", value: "/a" }] })
    const off = applyFormEdit(form, { _tag: "ToggleCase", index: 0 })
    expect(writeForm(off)).toMatchObject({ draft: { predicates: [{ caseSensitive: false }] } })
    expect(writeForm(applyFormEdit(off, { _tag: "ToggleCase", index: 0 }))).toEqual(writeForm(form))
  })

  it("exists keeps a value (the schema needs one), and a picked delay starts from an example", () => {
    const form = formOf({ ...ONE, predicates: [{ field: "path", operator: "equals" }] })
    expect(writeForm(applyFormEdit(form, { _tag: "SetOperator", index: 0, operator: "exists" }))).toMatchObject({
      draft: { predicates: [{ operator: "exists", value: "" }] }
    })
    const fixed = applyFormEdit(form, { _tag: "SetDelayKind", index: 0, kind: "fixed" })
    expect(writeForm(fixed)).toMatchObject({ draft: { responses: [{ delay: 500 }] } })
    const range = applyFormEdit(form, { _tag: "SetDelayKind", index: 0, kind: "range" })
    expect(writeForm(range)).toMatchObject({ draft: { responses: [{ delay: { min: 100, max: 800 } }] } })
    const json = applyFormEdit(form, { _tag: "SetBodyKind", index: 0, kind: "json" })
    expect(writeForm(json)).toMatchObject({ draft: { responses: [{ body: {} }] } })
  })

  it("never removes the last response, and moves only within the list", () => {
    const form = formOf(ONE)
    expect(applyFormEdit(form, { _tag: "RemoveResponse", index: 0 })).toBe(form)
    expect(applyFormEdit(form, { _tag: "MoveResponse", index: 0, by: -1 })).toBe(form)
  })

  it("a header named __proto__ is an ordinary header", () => {
    const form = applyFormEdit(applyFormEdit(formOf(ONE), { _tag: "AddHeader", index: 0 }), {
      _tag: "SetHeaderName",
      index: 0,
      header: 0,
      name: "__proto__"
    })
    const written = writeForm(form)
    const responses: unknown = written.ok ? written.draft.responses : undefined
    const first: unknown = Array.isArray(responses) ? responses[0] : undefined
    const headers: unknown = typeof first === "object" && first !== null && "headers" in first
      ? first.headers
      : undefined
    expect(typeof headers === "object" && headers !== null ? Object.keys(headers) : []).toEqual(["__proto__"])
  })
})

describe("the form's words", () => {
  it("fieldLabel names a schema path the way the form does", () => {
    expect(fieldLabel(["responses", 1, "status"])).toBe("response 2 · status")
    expect(fieldLabel(["responses", 0, "headers", "x-id"])).toBe("response 1 · header x-id")
    expect(fieldLabel(["responses", 0, "delay", "max"])).toBe("response 1 · delay")
    expect(fieldLabel(["predicates", 2, "caseSensitive"])).toBe("condition 3 · case")
    expect(fieldLabel(["predicates", 0])).toBe("condition 1")
    expect(fieldLabel(["responseMode"])).toBe("response order")
    expect(fieldLabel([])).toBe("the stub")
  })

  it("splitMessage finds the path a message starts with", () => {
    expect(splitMessage("responses[0].status must be an HTTP status code", ["responses", 0, "status"])).toEqual({
      at: ["responses", 0, "status"],
      rest: " must be an HTTP status code"
    })
    expect(splitMessage(`predicates[1] needs a "value"`, ["predicates", 1, "value"])).toEqual({
      at: ["predicates", 1],
      rest: ` needs a "value"`
    })
    expect(splitMessage("responses[0].delay: max (1) must be at least min (9)", ["responses", 0, "delay", "max"]))
      .toEqual({ at: ["responses", 0, "delay"], rest: ": max (1) must be at least min (9)" })
    expect(splitMessage("a stub is a JSON object", [])).toBeUndefined()
  })

  it("reasonPhrase", () => {
    expect(reasonPhrase("503")).toBe("Service Unavailable")
    expect(reasonPhrase("")).toBe("OK (the default)")
    expect(reasonPhrase("299")).toBe("")
    expect(reasonPhrase("700")).toBe("not a status: 100–599")
  })
})
