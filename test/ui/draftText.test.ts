import { it as prop } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { draftToText, locate, parseDraftText, pathKey, positionAt } from "imposters/ui/editor/draftText"
import { draftStubFrom } from "imposters/ui/stubDraft"
import { describe, expect, it } from "vitest"

// The editor's text ⇄ draft conversion: JSON syntax errors with their line and column, where a
// path sits in the text, and printing a draft back as text

const problemOf = (text: string) => {
  const parsed = parseDraftText(text)
  if (parsed.ok) throw new Error(`expected a syntax error in ${JSON.stringify(text)}`)
  return parsed.problem
}

describe("parseDraftText", () => {
  it("reads JSON into a draft", () => {
    const parsed = parseDraftText(`{ "responses": [{ "status": 200 }] }`)
    expect(parsed.ok && parsed.draft).toEqual({ responses: [{ status: 200 }] })
  })

  it.each([
    ["", 1, 1, "the editor is empty"],
    ["{\n  \"responses\": [\n}", 3, 1, "unexpected \"}\": expected a value"],
    ["{\n  \"a\": 1,\n}", 3, 1, "a comma before } is not allowed"],
    ["[1, 2,]", 1, 7, "a comma before ] is not allowed"],
    ["{\n  \"a\": 1\n  \"b\": 2\n}", 3, 3, "expected a comma or } after the value of \"a\""],
    ["{ 'a': 1 }", 1, 3, "keys use double quotes"],
    ["{ \"a\": 'x' }", 1, 8, "JSON strings use double quotes"],
    ["{ a: 1 }", 1, 3, "expected a key in double quotes"],
    ["{ \"status\": ok }", 1, 13, "unexpected ok: text needs double quotes, like \"ok\""],
    ["{ \"a\": \"open\n}", 1, 8, "this string is never closed"],
    ["{ \"a\": 1 // why\n}", 1, 10, "JSON has no comments"],
    ["{ \"a\": 01 }", 1, 8, "not a number JSON knows"],
    ["{ \"a\": \"\\x\" }", 1, 9, "\\x is not a JSON escape"],
    ["{ \"a\": 1 } }", 1, 12, "after the end of the stub"],
    ["{\n  \"a\": [1, 2", 2, 8, "this [ is never closed"],
    ["{\n  \"a\": 1", 1, 1, "this { is never closed"]
  ])("names the line and column of a syntax error: %j", (text, line, column, message) => {
    const problem = problemOf(text)
    expect(problem.message).toContain(message)
    expect({ line: problem.line, column: problem.column }).toEqual({ line, column })
  })

  it("agrees with JSON.parse on what is JSON", () => {
    const samples = [
      "{}",
      "[]",
      "\"x\"",
      "-0.5e3",
      "true",
      "null",
      "{\"a\":[1,{\"b\":null}]}",
      " \n{ } ",
      "{\"__proto__\": 1}"
    ]
    for (const text of samples) {
      const parsed = parseDraftText(text)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.draft).toEqual(JSON.parse(text))
    }
  })
})

describe("locate", () => {
  const text = `{
  "predicates": [],
  "responses": [
    { "status": "ok" }
  ]
}`
  const parsed = parseDraftText(text)

  it("finds where a value starts", () => {
    expect(locate(parsed, text, ["responses", 0, "status"])).toEqual({ line: 4, column: 17 })
    expect(locate(parsed, text, ["predicates"])).toEqual({ line: 2, column: 17 })
  })

  it("points a missing key at the closest value that is there", () => {
    expect(locate(parsed, text, ["responses", 0, "body"])).toEqual({ line: 4, column: 5 })
    expect(locate(parsed, text, ["responseMode"])).toEqual({ line: 1, column: 1 })
  })

  it("knows nothing of text that does not parse", () => {
    expect(locate(parseDraftText("{"), "{", ["responses"])).toBeUndefined()
  })
})

describe("positionAt and pathKey", () => {
  it("counts lines and columns from 1", () => {
    expect(positionAt("ab\ncd", 0)).toEqual({ line: 1, column: 1 })
    expect(positionAt("ab\ncd", 4)).toEqual({ line: 2, column: 2 })
    expect(positionAt("ab", 99)).toEqual({ line: 1, column: 3 })
  })

  it("writes keys as a reader would", () => {
    expect(pathKey(["responses", 0, "headers", "content-type"])).toBe("responses[0].headers[\"content-type\"]")
  })
})

describe("draftToText", () => {
  it("prints a draft as the mockup shows it: flat objects on one line, the rest indented", () => {
    expect(draftToText(draftStubFrom("GET", "/payments/pm_81"))).toBe(`{
  "predicates": [
    { "field": "method", "operator": "equals", "value": "GET" },
    { "field": "path", "operator": "equals", "value": "/payments/pm_81" }
  ],
  "responses": [
    {
      "status": 200,
      "headers": { "content-type": "application/json" },
      "body": {}
    }
  ],
  "responseMode": "sequential"
}`)
  })

  it("keeps a long flat object on several lines", () => {
    const text = draftToText({ body: { message: "x".repeat(90) } })
    expect(text).toContain(`"body": {\n    "message":`)
  })

  prop.prop(
    "reads back exactly what it printed",
    { value: Schema.Json },
    ({ value }) => {
      const parsed = parseDraftText(draftToText(value))
      expect(parsed.ok).toBe(true)
      // JSON has no -0, so compare with what JSON itself reads back
      if (parsed.ok) expect(parsed.draft).toEqual(JSON.parse(JSON.stringify(value)))
    },
    { arbitrary: { runs: 300 } }
  )
})
