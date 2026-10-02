import * as Schema from "effect/Schema"
import { Stub } from "imposters/schemas/StubSchema"
import { answersChanged, applyStubPatch } from "imposters/server/StubChange"
import { describe, expect, it } from "vitest"

const base = {
  id: "s1",
  predicates: [{ field: "path", operator: "equals", value: "/a" }],
  responses: [{ status: 200, body: { ok: true } }, { status: 503 }],
  responseMode: "sequential"
}

// A decoded stub with some fields replaced, for taking typed fields from
const variant = (overrides: Record<string, unknown>) => Schema.decodeUnknownSync(Stub)({ ...base, ...overrides })

const stub = variant({})

describe("applyStubPatch", () => {
  it("replaces only the fields the patch gives", () => {
    const { predicates } = variant({ predicates: [{ field: "path", operator: "equals", value: "/b" }] })
    expect(applyStubPatch(stub, { predicates })).toEqual({ ...stub, predicates })
    expect(applyStubPatch(stub, {})).toEqual(stub)
  })
})

describe("answersChanged", () => {
  it("is false for a predicate-only edit", () => {
    expect(answersChanged(stub, applyStubPatch(stub, { predicates: [] }))).toBe(false)
  })

  it("is false when the same responses are sent again (a full-form UI save)", () => {
    // Structurally equal, not the same objects
    const { responseMode, responses } = variant({})
    expect(responses).not.toBe(stub.responses)
    expect(answersChanged(stub, applyStubPatch(stub, { responses, responseMode }))).toBe(false)
  })

  it("is true when a response changes", () => {
    const { responses } = variant({ responses: [{ status: 200, body: { ok: false } }, { status: 503 }] })
    expect(answersChanged(stub, applyStubPatch(stub, { responses }))).toBe(true)
  })

  it("is true when the responseMode changes", () => {
    expect(answersChanged(stub, applyStubPatch(stub, { responseMode: "repeat" }))).toBe(true)
  })
})
