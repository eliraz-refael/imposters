import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { formatPath, stubIssueMessages } from "imposters/schemas/IssueMessages"
import { CreateStubRequest } from "imposters/schemas/StubSchema"
import { describe, expect, it } from "vitest"

const decode = Schema.decodeUnknownExit(CreateStubRequest, { errors: "all" })

// The plain-English messages for an input the stub schema refuses
const messagesFor = (input: unknown): ReadonlyArray<string> => {
  const exit = decode(input)
  if (Exit.isSuccess(exit)) throw new Error("expected the schema to refuse it")
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
  if (!Schema.isSchemaError(error)) throw new Error("expected a SchemaError")
  return stubIssueMessages(error, input).map((m) => m.message)
}

describe("formatPath", () => {
  it("writes a path as a reader would", () => {
    expect(formatPath([])).toBe("")
    expect(formatPath(["responses", 0, "status"])).toBe("responses[0].status")
    expect(formatPath(["responses", 0, "headers", "content-type"])).toBe("responses[0].headers[\"content-type\"]")
  })
})

describe("stubIssueMessages", () => {
  it("a string status", () => {
    expect(messagesFor({ responses: [{ status: "ok" }] })).toEqual([
      "responses[0].status must be an HTTP status code (100–599), like 200, not \"ok\""
    ])
  })

  it("a status out of range, and one that is not whole", () => {
    expect(messagesFor({ responses: [{ status: 99 }, { status: 200.5 }] })).toEqual([
      "responses[0].status must be an HTTP status code (100–599), like 200, not 99",
      "responses[1].status must be an HTTP status code (100–599), like 200, not 200.5"
    ])
  })

  it("a missing responses list, pointing out a likely typo", () => {
    const [plain] = messagesFor({})
    expect(plain).toMatch(/^responses is missing: a stub needs a list of at least one response, like "responses": \[/)
    expect(plain).not.toContain("rename")
    expect(messagesFor({ response: [{ status: 200 }] })[0]).toContain(`there is a "response": rename it`)
  })

  it("an empty responses list, and one that is not a list", () => {
    expect(messagesFor({ responses: [] })).toEqual([
      "responses is empty: add at least one response, like { \"status\": 200, \"body\": \"ok\" }"
    ])
    expect(messagesFor({ responses: { status: 200 } })[0]).toMatch(
      /^responses must be a list of responses, .*, not \{"status":200\}$/
    )
  })

  it("an unknown predicate field and operator", () => {
    expect(messagesFor({ responses: [{}], predicates: [{ field: "url", operator: "eq", value: "/x" }] })).toEqual([
      "predicates[0].field must be one of method, path, headers, query or body, not \"url\"",
      "predicates[0].operator must be one of equals, contains, startsWith, matches or exists, not \"eq\""
    ])
  })

  it("a predicate missing its parts", () => {
    expect(messagesFor({ responses: [{}], predicates: [{ operator: "equals" }] })).toEqual([
      "predicates[0] needs a \"field\": one of method, path, headers, query or body",
      "predicates[0] needs a \"value\" to compare with, like \"/orders\""
    ])
  })

  it("a bad responseMode", () => {
    expect(messagesFor({ responses: [{}], responseMode: "loop" })).toEqual([
      "responseMode must be one of sequential, random or repeat, not \"loop\""
    ])
  })

  it("a delay out of range, and one of the wrong type", () => {
    const [outOfRange] = messagesFor({ responses: [{ delay: 70000 }] })
    expect(outOfRange).toMatch(/^responses\[0\]\.delay must be a whole number of milliseconds from 0 to 60000/)
    expect(outOfRange).toContain("not 70000")
    expect(messagesFor({ responses: [{ delay: "slow" }] })[0]).toContain("not \"slow\"")
  })

  it("a delay range with min above max", () => {
    expect(messagesFor({ responses: [{ delay: { min: 500, max: 100 } }] })).toEqual([
      "responses[0].delay: max (100) must be at least min (500)"
    ])
  })

  it("a delay range with a bound out of range", () => {
    const messages = messagesFor({ responses: [{ delay: { min: -1, max: 100 } }] })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(/^responses\[0\]\.delay must be a range of whole milliseconds from 0 to 60000/)
  })

  it("a header value that is not text", () => {
    expect(messagesFor({ responses: [{ headers: { "x-count": 1 } }] })).toEqual([
      "responses[0].headers[\"x-count\"] must be text, like \"application/json\", not 1"
    ])
  })

  it("a list instead of a stub, and something that is not an object at all", () => {
    expect(messagesFor([{ responses: [{}] }])[0]).toMatch(/^a stub is one JSON object, not a list/)
    expect(messagesFor("stub")[0]).toMatch(/^a stub is a JSON object with predicates and responses/)
  })

  it("never shows the schema's own wording for these", () => {
    const inputs: ReadonlyArray<unknown> = [
      { responses: [{ status: "ok" }] },
      {},
      { responses: [] },
      { responses: [{}], predicates: "all" },
      { responses: [{ delay: { min: 9, max: 1 } }] }
    ]
    for (const input of inputs) {
      for (const message of messagesFor(input)) {
        expect(message).not.toMatch(/Expected|Missing key|\["/)
      }
    }
  })

  it("shortens a long value it quotes", () => {
    const [message] = messagesFor({ responses: [{}], responseMode: "x".repeat(200) })
    expect(message?.length).toBeLessThan(140)
    expect(message).toContain("…")
  })
})
