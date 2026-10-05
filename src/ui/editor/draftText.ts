/**
 * The stub editor's text view: JSON text to a stub draft and back, with plain-English syntax
 * errors that name the line and column. Pure and free of imports, because both sides use it:
 * the server (checking a posted stub) and the browser runtime (ui-assets/editor.ts bundles it, so
 * a syntax error shows without a round trip). A form view edits the same draft, through the same
 * two functions.
 */

/** A place in the text, both counted from 1 */
export interface TextPosition {
  readonly line: number
  readonly column: number
}

/** Why the text is not JSON, and where */
export interface SyntaxProblem extends TextPosition {
  readonly message: string
}

/** A path into a draft, as the schema reports it: ["responses", 0, "status"] */
export type DraftPath = ReadonlyArray<string | number>

export type DraftParse =
  | {
    readonly ok: true
    // The parsed JSON: not yet a stub, the schema decides that
    readonly draft: unknown
    // Where each value starts (and each key, under "<path>#key"), by pathKey
    readonly offsets: ReadonlyMap<string, number>
  }
  | { readonly ok: false; readonly problem: SyntaxProblem }

/** The line and column of an offset into the text */
export const positionAt = (text: string, offset: number): TextPosition => {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)))
  const lines = before.split("\n")
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 }
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** A path as a reader writes it: responses[0].status, headers["content-type"]; the root is "" */
export const pathKey = (path: DraftPath): string =>
  path.reduce<string>((key, segment) => {
    if (typeof segment === "number") return `${key}[${String(segment)}]`
    if (IDENTIFIER.test(segment)) return key === "" ? segment : `${key}.${segment}`
    return `${key}[${JSON.stringify(segment)}]`
  }, "")

// ---------------------------------------------------------------- the scanner

// Thrown inside the scanner only; parseDraftText turns it into a SyntaxProblem
class Stop {
  constructor(readonly offset: number, readonly message: string) {}
}

const VALUE_HINT = "a value: a string in double quotes, a number, true, false, null, an object or a list"

const describeChar = (char: string | undefined): string =>
  char === undefined ? "the end" : char === "\n" ? "a line break" : JSON.stringify(char)

/**
 * Checks the text is JSON and records where each value starts. JSON.parse makes the value
 * afterwards: its messages differ between engines and do not always say where, which is why
 * this scanner exists.
 */
const scan = (text: string): ReadonlyMap<string, number> => {
  const offsets = new Map<string, number>()
  let i = 0

  const skipSpace = (): void => {
    for (;;) {
      const char = text[i]
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        i++
      } else if (char === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
        throw new Stop(i, "JSON has no comments: remove it")
      } else {
        return
      }
    }
  }

  const expectValueAt = (): never => {
    const char = text[i]
    if (char === undefined) throw new Stop(i, `the text ends early: expected ${VALUE_HINT}`)
    if (char === "'") throw new Stop(i, "JSON strings use double quotes (\"), not single quotes")
    if (char === "}" || char === "]") throw new Stop(i, `unexpected ${describeChar(char)}: expected ${VALUE_HINT}`)
    if (/[A-Za-z]/.test(char)) {
      const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i))?.[0] ?? char
      throw new Stop(i, `unexpected ${word}: text needs double quotes, like "${word}"`)
    }
    throw new Stop(i, `unexpected ${describeChar(char)}: expected ${VALUE_HINT}`)
  }

  const scanString = (): void => {
    const start = i
    i++
    for (;;) {
      const char = text[i]
      if (char === undefined) throw new Stop(start, "this string is never closed: add a \" at its end")
      if (char === "\"") {
        i++
        return
      }
      if (char === "\n") throw new Stop(start, "this string is never closed: add a \" before the line ends")
      if (char < " ") throw new Stop(i, "a string cannot hold a control character: write it as an escape, like \\t")
      if (char === "\\") {
        const next = text[i + 1]
        if (next === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
            throw new Stop(i, "\\u needs four hex digits, like \\u00e9")
          }
          i += 6
          continue
        }
        if (next === undefined || !"\"\\/bfnrt".includes(next)) {
          throw new Stop(i, `\\${next ?? ""} is not a JSON escape: write a backslash itself as \\\\`)
        }
        i += 2
        continue
      }
      i++
    }
  }

  const scanNumber = (): void => {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i))
    if (match === null || match[0] === "-") throw new Stop(i, "this is not a number JSON knows, like 200 or 1.5")
    const after = text[i + match[0].length]
    if (after !== undefined && /[0-9.]/.test(after)) {
      throw new Stop(i, "this is not a number JSON knows (no leading zeros, digits on both sides of a dot)")
    }
    i += match[0].length
  }

  const scanWord = (): void => {
    for (const word of ["true", "false", "null"]) {
      if (text.startsWith(word, i)) {
        i += word.length
        return
      }
    }
    expectValueAt()
  }

  const scanObject = (path: Array<string | number>): void => {
    const open = i
    i++
    skipSpace()
    if (text[i] === "}") {
      i++
      return
    }
    for (;;) {
      skipSpace()
      const keyAt = i
      if (text[i] === "}") throw new Stop(i, "a comma before } is not allowed in JSON: remove it")
      if (text[i] === "'") throw new Stop(i, "keys use double quotes (\"), not single quotes")
      if (text[i] !== "\"") {
        if (text[i] === undefined) throw new Stop(open, "this { is never closed: add a } at its end")
        throw new Stop(i, `unexpected ${describeChar(text[i])}: expected a key in double quotes, like "status"`)
      }
      scanString()
      const key = text.slice(keyAt, i)
      const name: unknown = JSON.parse(key)
      const segment = typeof name === "string" ? name : key
      skipSpace()
      if (text[i] !== ":") throw new Stop(i, `expected a : after the key ${key}`)
      i++
      skipSpace()
      const childPath = [...path, segment]
      offsets.set(`${pathKey(childPath)}#key`, keyAt)
      scanValue(childPath)
      skipSpace()
      const char = text[i]
      if (char === ",") {
        i++
        continue
      }
      if (char === "}") {
        i++
        return
      }
      if (char === undefined) throw new Stop(open, "this { is never closed: add a } at its end")
      throw new Stop(i, `unexpected ${describeChar(char)}: expected a comma or } after the value of ${key}`)
    }
  }

  const scanArray = (path: Array<string | number>): void => {
    const open = i
    i++
    skipSpace()
    if (text[i] === "]") {
      i++
      return
    }
    for (let index = 0;; index++) {
      skipSpace()
      if (text[i] === "]") throw new Stop(i, "a comma before ] is not allowed in JSON: remove it")
      if (text[i] === undefined) throw new Stop(open, "this [ is never closed: add a ] at its end")
      scanValue([...path, index])
      skipSpace()
      const char = text[i]
      if (char === ",") {
        i++
        continue
      }
      if (char === "]") {
        i++
        return
      }
      if (char === undefined) throw new Stop(open, "this [ is never closed: add a ] at its end")
      throw new Stop(i, `unexpected ${describeChar(char)}: expected a comma or ] after item ${String(index + 1)}`)
    }
  }

  function scanValue(path: Array<string | number>): void {
    skipSpace()
    offsets.set(pathKey(path), i)
    const char = text[i]
    if (char === "{") scanObject(path)
    else if (char === "[") scanArray(path)
    else if (char === "\"") scanString()
    else if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) scanNumber()
    else if (char === "t" || char === "f" || char === "n") scanWord()
    else expectValueAt()
  }

  skipSpace()
  if (i === text.length) {
    throw new Stop(0, "the editor is empty: a stub is a JSON object, like { \"responses\": [{ \"status\": 200 }] }")
  }
  scanValue([])
  skipSpace()
  if (i < text.length) {
    throw new Stop(i, `unexpected ${describeChar(text[i])} after the end of the stub: is a comma or a { missing?`)
  }
  return offsets
}

/** The draft the text holds, or the first syntax error in it with its line and column */
export const parseDraftText = (text: string): DraftParse => {
  try {
    const offsets = scan(text)
    const draft: unknown = JSON.parse(text)
    return { ok: true, draft, offsets }
  } catch (error) {
    if (error instanceof Stop) {
      return { ok: false, problem: { message: error.message, ...positionAt(text, error.offset) } }
    }
    // The scanner accepted what JSON.parse did not: never expected, but still an answer
    return { ok: false, problem: { message: "this is not valid JSON", line: 1, column: 1 } }
  }
}

/**
 * Where a path points in parsed text: the value's start, or for a missing key the closest
 * value that is there (the object that should hold it)
 */
export const locate = (parsed: DraftParse, text: string, path: DraftPath): TextPosition | undefined => {
  if (!parsed.ok) return undefined
  for (let length = path.length; length >= 0; length--) {
    const offset = parsed.offsets.get(pathKey(path.slice(0, length)))
    if (offset !== undefined) return positionAt(text, offset)
  }
  return undefined
}

// ---------------------------------------------------------------- printing

const INLINE_WIDTH = 80
const INDENT = "  "

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// No object or list inside, apart from empty ones
const isFlat = (value: unknown): boolean => {
  const children = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : []
  return children.every((child) =>
    typeof child !== "object" || child === null ||
    (Array.isArray(child) ? child.length === 0 : Object.keys(child).length === 0)
  )
}

const inline = (value: unknown): string => {
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[${value.map(inline).join(", ")}]`
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined)
    return entries.length === 0
      ? "{}"
      : `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`).join(", ")} }`
  }
  return JSON.stringify(value)
}

const print = (value: unknown, indent: string): string => {
  const flat = inline(value)
  if ((typeof value !== "object" || value === null) || (isFlat(value) && indent.length + flat.length <= INLINE_WIDTH)) {
    return flat
  }
  const inner = indent + INDENT
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    return `[\n${value.map((item) => inner + print(item, inner)).join(",\n")}\n${indent}]`
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return "{}"
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${print(v, inner)}`).join(",\n")}\n${indent}}`
}

/**
 * A draft as the editor shows it: two-space indents, with small flat objects and lists (a
 * predicate, a header map) kept on one line. It is JSON: parseDraftText reads it back unchanged.
 */
export const draftToText = (draft: unknown): string => print(draft, "")
