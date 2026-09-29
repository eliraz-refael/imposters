import { it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import {
  element,
  escapeXml,
  parseDeleteRequest,
  parseXml,
  renderDocument,
  unescapeXml
} from "imposters/extensions/s3/Xml"
import { describe, expect } from "vitest"
import { WellFormedString, xmlDeleteBody } from "./requests"

const keysOf = (text: string) =>
  Result.match(parseDeleteRequest(text), { onFailure: (why) => ({ failed: why }), onSuccess: (r) => r })

describe("escapeXml / unescapeXml", () => {
  it.prop("unescape inverts escape for any well-formed string", { s: WellFormedString }, ({ s }) => {
    expect(unescapeXml(escapeXml(s))).toBe(s)
  }, { arbitrary: { runs: 200 } })

  it.prop("escaped text never contains markup characters", { s: WellFormedString }, ({ s }) => {
    expect(escapeXml(s)).not.toMatch(/[<>"']/)
    expect(escapeXml(s).replaceAll(/&(amp|lt|gt|quot|apos|#x[0-9A-F]+);/g, "")).not.toContain("&")
  })

  it("writes control characters and CR as character references", () => {
    expect(escapeXml("a\rb\u0001c\td\ne")).toBe("a&#xD;b&#x1;c\td\ne")
  })

  it("leaves an unknown entity untouched", () => {
    expect(unescapeXml("&nbsp; &amp;nbsp; &#65;&#x42;")).toBe("&nbsp; &nbsp; AB")
  })
})

describe("renderDocument", () => {
  it("renders the declaration, attributes, nesting and self-closing empties", () => {
    const xml = renderDocument(
      element("Root", [element("A", "x & y"), undefined, element("Empty", [])], { xmlns: "urn:\"q\"" })
    )
    expect(xml).toBe(
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Root xmlns=\"urn:&quot;q&quot;\"><A>x &amp; y</A><Empty/></Root>"
    )
  })

  it.prop("a rendered document parses back to the same text", { s: WellFormedString }, ({ s }) => {
    const tree = parseXml(renderDocument(element("R", [element("V", s)])))
    const decoded = Result.flatMap(
      tree,
      (t) =>
        Result.mapError(
          Schema.decodeUnknownResult(Schema.Struct({ R: Schema.Struct({ V: Schema.String }) }))(t),
          String
        )
    )
    // An empty element renders self-closing and parses as ""
    expect(Result.map(decoded, (d) => unescapeXml(d.R.V))).toEqual(Result.succeed(s))
  })
})

describe("parseXml", () => {
  it.each(["", "not xml", "<Delete><Object>", "<a></b>"])("rejects malformed input %j", (text) => {
    expect(Result.isFailure(parseXml(text))).toBe(true)
  })
})

describe("parseDeleteRequest", () => {
  it("reads a single Object as a one-key list, and Quiet", () => {
    expect(keysOf(xmlDeleteBody(["only"], true))).toEqual({ keys: ["only"], quiet: true })
  })

  it("defaults Quiet to false and keeps whitespace and leading zeros in keys", () => {
    expect(keysOf(xmlDeleteBody(["  spaced  ", "007"]))).toEqual({ keys: ["  spaced  ", "007"], quiet: false })
  })

  it("resolves entities in keys", () => {
    expect(keysOf(xmlDeleteBody(["a&amp;b&lt;c&#x1F600;"]))).toEqual({ keys: ["a&b<c😀"], quiet: false })
  })

  it.each([
    ["no Delete element", "<Other/>"],
    ["an Object without a Key", "<Delete><Object><VersionId>1</VersionId></Object></Delete>"],
    ["malformed XML", "<Delete><Object><Key>k</Key></Delete>"]
  ])("fails for %s", (_, text) => {
    expect(Result.isFailure(parseDeleteRequest(text))).toBe(true)
  })

  it.prop(
    "a Delete body built from any keys parses back to the same keys",
    { keys: Schema.NonEmptyArray(WellFormedString), quiet: Schema.Boolean },
    ({ keys, quiet }) => {
      expect(keysOf(xmlDeleteBody(keys, quiet, escapeXml))).toEqual({ keys, quiet })
    }
  )
})
