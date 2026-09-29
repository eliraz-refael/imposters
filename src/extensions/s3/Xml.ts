/**
 * The XML S3 speaks: a small escaping builder for answers, and a parser whose output is
 * `unknown` until an Effect Schema decodes it.
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { XMLParser, XMLValidator } from "fast-xml-parser"

export const S3_XMLNS = "http://s3.amazonaws.com/doc/2006-03-01/"

/** An element: text content, or child elements (`undefined` children are skipped, for optional fields) */
export interface XmlElement {
  readonly name: string
  readonly attributes?: Readonly<Record<string, string>>
  readonly content: string | ReadonlyArray<XmlElement | undefined>
}

export const element = (
  name: string,
  content: string | ReadonlyArray<XmlElement | undefined>,
  attributes?: Readonly<Record<string, string>>
): XmlElement => attributes === undefined ? { name, content } : { name, content, attributes }

// Characters XML would drop or normalise when written literally: control characters, and CR
// (which parsers fold into LF). They go out as character references so text round-trips.
const needsReference = (code: number): boolean => code < 0x20 && code !== 0x09 && code !== 0x0a

/** Escapes text for element content or a double-quoted attribute value */
export const escapeXml = (text: string): string => {
  let out = ""
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    out += char === "&"
      ? "&amp;"
      : char === "<"
      ? "&lt;"
      : char === ">"
      ? "&gt;"
      : char === "\""
      ? "&quot;"
      : char === "'"
      ? "&apos;"
      : needsReference(code)
      ? `&#x${code.toString(16).toUpperCase()};`
      : char
  }
  return out
}

const renderElement = (el: XmlElement): string => {
  const attributes = Object.entries(el.attributes ?? {}).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join("")
  const body = typeof el.content === "string"
    ? escapeXml(el.content)
    : el.content.flatMap((child) => child === undefined ? [] : [renderElement(child)]).join("")
  return body === "" ? `<${el.name}${attributes}/>` : `<${el.name}${attributes}>${body}</${el.name}>`
}

/** A complete document with the XML declaration, as S3 sends it */
export const renderDocument = (root: XmlElement): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n${renderElement(root)}`

const namedEntities: Readonly<Record<string, string>> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: "\"" }

/** Resolves the five XML entities and numeric character references; the inverse of `escapeXml` */
export const unescapeXml = (text: string): string =>
  text.replaceAll(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (ref, name: string) => {
    if (name.startsWith("#")) {
      const code = name.startsWith("#x") ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return code <= 0x10ffff ? String.fromCodePoint(code) : ref
    }
    return namedEntities[name] ?? ref
  })

// `Object` is the only repeated element in a request body the emulator reads (DeleteObjects),
// so it is always an array even when there is one. Values stay strings, whitespace intact.
// Entities are left alone here and resolved by `unescapeXml`: the parser's own decoder drops
// numeric references unless its (deprecated) HTML mode is on, which also accepts HTML names.
const parser = new XMLParser({
  isArray: (name) => name === "Object",
  parseTagValue: false,
  processEntities: false,
  trimValues: false
})

/** Parses well-formed XML into an untyped tree; malformed input is a failure with the reason */
export const parseXml = (text: string): Result.Result<unknown, string> => {
  const valid = XMLValidator.validate(text)
  if (valid !== true) return Result.fail(valid.err.msg)
  try {
    const tree: unknown = parser.parse(text)
    return Result.succeed(tree)
  } catch (err) {
    return Result.fail(err instanceof Error ? err.message : String(err))
  }
}

/** The DeleteObjects request body: `<Delete><Object><Key/></Object>...<Quiet/></Delete>` */
export const DeleteRequestXml = Schema.Struct({
  Delete: Schema.Struct({
    Object: Schema.Array(Schema.Struct({ Key: Schema.String })),
    Quiet: Schema.optional(Schema.String)
  })
})
export type DeleteRequestXml = Schema.Schema.Type<typeof DeleteRequestXml>

export interface DeleteRequest {
  readonly keys: ReadonlyArray<string>
  readonly quiet: boolean
}

const decodeDeleteRequest = Schema.decodeUnknownResult(DeleteRequestXml)

/** Reads a DeleteObjects body; any failure is the reason it is malformed */
export const parseDeleteRequest = (text: string): Result.Result<DeleteRequest, string> =>
  Result.flatMap(parseXml(text), (tree) =>
    Result.match(decodeDeleteRequest(tree), {
      onFailure: (err) => Result.fail(err.message),
      onSuccess: ({ Delete }) =>
        Result.succeed({
          keys: Delete.Object.map((o) => unescapeXml(o.Key)),
          quiet: unescapeXml(Delete.Quiet ?? "false").trim().toLowerCase() === "true"
        })
    }))
