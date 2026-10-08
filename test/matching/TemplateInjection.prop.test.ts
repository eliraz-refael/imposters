import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { RequestContext } from "imposters/matching/RequestMatcher"
import {
  applyTemplates,
  resolveTemplateKey,
  substituteTemplateKeys,
  type TemplateContext
} from "imposters/matching/TemplateEngine"
import jsonata from "jsonata"
import { describe, expect } from "vitest"

// applyTemplates is one pass over the template's own text: `{{key}}` and `${expr}` are both found
// as written, and nothing either inserts is scanned again. Two properties pin it down:
//
// 1. Where no inserted value meets an expression, it renders what the two-pass engine it replaced
//    rendered. That engine is copied below as the oracle, instrumented to say whether a value
//    met an expression: whether any `${` it tried (closed or not) began in, ran over, or ended
//    in a value it had inserted. Those are the cases the fix changes on purpose (a value's `${`,
//    a `$` before a value's `{`, a value ending in `$` before the template's `{`, an empty value
//    between a `$` and a `{`, a value's `}` closing an open `${`, a `{{key}}` inside `${…}` (and a
//    failed one shown as written), and an empty value beside an expression that the old engine
//    then took for the whole string),
//    pinned by the plain tests in TemplateEngine.test.ts. Generated values never hold `${`.
// 2. A template whose own text has no `$` renders as plain `{{key}}` substitution, whatever the
//    values hold: a value carrying `${…}` is never evaluated.

// ---------------------------------------------------------------- the oracle (the old engine)

interface Substituted {
  readonly text: string
  // Where each inserted value sits in `text`, as [start, end)
  readonly spans: ReadonlyArray<readonly [number, number]>
}

// The old substituteInString, recording where it inserted each value
const oracleSubstituteInString = (tctx: TemplateContext, str: string): Substituted => {
  if (!str.includes("{{")) return { text: str, spans: [] }
  const spans: Array<readonly [number, number]> = []
  let out = ""
  let at = 0
  let close = -1
  for (;;) {
    const open = str.indexOf("{{", at)
    if (open === -1) break
    if (close < open + 2) close = str.indexOf("}}", open + 2)
    if (close === -1) break
    let value: string | undefined
    let end = close
    if (str.startsWith("request.", open + 2) || str.startsWith("callbacks.", open + 2)) {
      const nextOpen = str.indexOf("{{", open + 1)
      const limit = nextOpen === -1 ? str.length : nextOpen
      for (let c = close; c !== -1 && (c === close || c < limit); c = str.indexOf("}}", c + 1)) {
        value = resolveTemplateKey(tctx, str.slice(open + 2, c))
        if (value !== undefined) {
          end = c
          break
        }
      }
    }
    if (value === undefined) {
      out += str.slice(at, open + 1)
      at = open + 1
    } else {
      out += str.slice(at, open)
      spans.push([out.length, out.length + value.length])
      out += value
      at = end + 2
    }
  }
  return { text: out + str.slice(at), spans }
}

const MAX_OUTPUT_SIZE = 1_048_576

const oracleExtract = (str: string, startIndex: number): [string, number] | null => {
  if (str[startIndex] !== "$" || str[startIndex + 1] !== "{") return null
  let depth = 1
  let i = startIndex + 2
  while (i < str.length && depth > 0) {
    if (str[i] === "{") depth++
    else if (str[i] === "}") depth--
    i++
  }
  if (depth !== 0) return null
  return [str.slice(startIndex + 2, i - 1), i]
}

const oracleEvaluate = async (expr: string, ctx: TemplateContext): Promise<unknown> => {
  try {
    const context = ctx.callbacks === undefined
      ? { request: ctx.request }
      : { request: ctx.request, callbacks: ctx.callbacks }
    return await jsonata(expr).evaluate(context)
  } catch {
    return undefined
  }
}

interface Rendered {
  readonly value: unknown
  // Whether a value met an expression
  readonly met: boolean
}

// The old processString, saying whether any `${` it tried met an inserted value
const oracleProcessString = async (
  str: string,
  spans: ReadonlyArray<readonly [number, number]>,
  ctx: TemplateContext
): Promise<Rendered> => {
  let met = false
  // The `${` tried at `i`, covering [i, end): its own two characters up to its `}`, or the rest
  // of the string when it never closed
  const tried = (i: number, extracted: [string, number] | null) => {
    const end = extracted === null ? str.length : extracted[1]
    if (spans.some(([s, e]) => s < end && e > i)) met = true
  }
  if (!str.includes("${")) return { value: str, met }
  const singleMatch = oracleExtract(str, 0)
  if (str.startsWith("${")) tried(0, singleMatch)
  if (singleMatch && singleMatch[1] === str.length) {
    // An empty value beside the expression made the whole string one expression here; the
    // template as written was not, so the new engine inserts the result as text
    if (spans.length > 0) met = true
    const result = await oracleEvaluate(singleMatch[0], ctx)
    return { value: result === undefined ? str : result, met }
  }
  let result = ""
  let i = 0
  while (i < str.length) {
    if (str[i] === "$" && i + 1 < str.length && str[i + 1] === "{") {
      const extracted = oracleExtract(str, i)
      tried(i, extracted)
      if (extracted) {
        const [exprContent, endIndex] = extracted
        const evalResult = await oracleEvaluate(exprContent, ctx)
        if (evalResult === undefined) {
          result += str.slice(i, endIndex)
        } else if (typeof evalResult === "object" && evalResult !== null) {
          result += JSON.stringify(evalResult)
        } else {
          result += String(evalResult)
        }
        i = endIndex
        if (result.length > MAX_OUTPUT_SIZE) return { value: result.slice(0, MAX_OUTPUT_SIZE), met }
        continue
      }
    }
    result += str.charAt(i)
    i++
  }
  return { value: result, met }
}

// The old applyTemplates on one string: {{key}} over the whole of it, then ${expr} over the result
const oracleRender = async (tctx: TemplateContext, template: string): Promise<Rendered> => {
  const { spans, text } = oracleSubstituteInString(tctx, template)
  return oracleProcessString(text, spans, tctx)
}

// ---------------------------------------------------------------- inputs

const Key = Schema.Literals(["a", "b", "0", "a.b"])
// Values with braces and dollars, never `${`
const Text = Schema.Literals(["v", "", "GET", "a b", "1", "{", "}", "$", "x$", "{a}", "$1", "}}", "{{", "'", "null"])
// And values that carry expressions, for the second property
const Hostile = Schema.Union([
  Text,
  Schema.Literals(["${request.method}", "${callbacks.cart.status}", "${", "{request.method}", "${'x'}", "$${1}"])
])

const contextOf = <T extends string>(text: Schema.Codec<T>) => {
  const Leaf = Schema.Union([text, Schema.Finite, Schema.Boolean, Schema.Null])
  const Json1 = Schema.Union([Leaf, Schema.Array(Leaf), Schema.Record(Key, Leaf)])
  const Json2 = Schema.Union([Leaf, Schema.Array(Json1), Schema.Record(Key, Json1)])
  return Schema.Struct({
    method: Schema.Literals(["GET", "POST"]),
    path: Schema.Literals(["/", "/a/b"]),
    headers: Schema.Record(Key, text),
    query: Schema.Record(Key, text),
    body: Schema.optional(Json2),
    callbacks: Schema.optional(Schema.Record(
      Schema.Literals(["cart", "a"]),
      Schema.Struct({
        ok: Schema.Boolean,
        status: Schema.optionalKey(Schema.Int),
        body: Schema.optionalKey(Json2),
        durationMs: Schema.Int,
        error: Schema.optionalKey(text)
      })
    ))
  })
}

const Context = contextOf(Text)
const HostileContext = contextOf(Hostile)

const REAL_KEYS = [
  "request.method",
  "request.path",
  "request.query.a",
  "request.query.b",
  "request.headers.a",
  "request.body",
  "request.body.a",
  "request.body.0",
  "request.body.a.b",
  "callbacks.cart.status",
  "callbacks.cart.body",
  "callbacks.cart.body.a",
  "callbacks.cart.ok",
  "callbacks.a.error"
] as const

const Real = Schema.TaggedStruct("Real", { key: Schema.Literals(REAL_KEYS) })
const Fake = Schema.TaggedStruct("Fake", {
  key: Schema.Literals(["request", "request.nope", "request.body.zz", "callbacks.nope.x", "callbacks"])
})
const Expr = Schema.TaggedStruct("Expr", {
  expr: Schema.Literals([
    "request.method",
    "request.path",
    "request.query",
    "request.query.a",
    "$count(request.query)",
    "request.body",
    "request.body.a",
    "callbacks.cart.body",
    "callbacks.cart.ok ? 'y' : 'n'",
    "1 + 2",
    "[1, 2]",
    "{'k': request.path}",
    "$$$bad",
    "",
    "nope",
    "request.method & '}'",
    "'{{request.method}}'",
    "true",
    "null",
    "$string(request.body)"
  ])
})
const Stray = Schema.TaggedStruct("Text", {
  text: Schema.Literals([" ", "x", "{", "}", "$", "${", "{{", "}}", "$$", "a.b", "'"])
})
// Text with no `$`, for the second property
const Plain = Schema.TaggedStruct("Text", { text: Schema.Literals([" ", "x", "{", "}", "{{", "}}", "a.b", "'"]) })

const Piece = Schema.Union([Real, Fake, Expr, Stray])
const PlainPiece = Schema.Union([Real, Fake, Plain])

type AnyPiece = Schema.Schema.Type<typeof Piece> | Schema.Schema.Type<typeof PlainPiece>

const toTemplate = (pieces: ReadonlyArray<AnyPiece>): string =>
  pieces.map((piece) => {
    switch (piece._tag) {
      case "Real":
      case "Fake":
        return `{{${piece.key}}}`
      case "Expr":
        return `\${${piece.expr}}`
      case "Text":
        return piece.text
    }
  }).join("")

const toContext = (input: Schema.Schema.Type<typeof HostileContext>): TemplateContext => {
  const request: RequestContext = {
    method: input.method,
    path: input.path,
    headers: input.headers,
    query: input.query,
    body: input.body,
    rawBody: new Uint8Array(0)
  }
  return input.callbacks === undefined ? { request } : { request, callbacks: input.callbacks }
}

describe("applyTemplates (property)", () => {
  it.effect.prop(
    "renders what the two-pass engine rendered wherever no inserted value meets an expression",
    { context: Context, pieces: Schema.Array(Piece), more: Schema.Array(Piece) },
    ({ context, more, pieces }) =>
      Effect.gen(function*() {
        const tctx = toContext(context)
        const first = toTemplate(pieces)
        const second = toTemplate(more)
        const one = yield* Effect.promise(() => oracleRender(tctx, first))
        const two = yield* Effect.promise(() => oracleRender(tctx, second))
        if (!one.met) expect(yield* Effect.promise(() => applyTemplates(tctx, first))).toEqual(one.value)
        if (!two.met) expect(yield* Effect.promise(() => applyTemplates(tctx, second))).toEqual(two.value)
        // Arrays and objects are walked as before
        if (one.met || two.met) return
        const data = { a: first, list: [second, 1, null, true, { nested: first }] }
        expect(yield* Effect.promise(() => applyTemplates(tctx, data))).toEqual({
          a: one.value,
          list: [two.value, 1, null, true, { nested: one.value }]
        })
      }),
    { arbitrary: { runs: 3000, size: 10 } }
  )

  it.effect.prop(
    "a template with no `$` of its own is plain {{key}} substitution, whatever the values hold",
    { context: HostileContext, pieces: Schema.Array(PlainPiece) },
    ({ context, pieces }) =>
      Effect.gen(function*() {
        const tctx = toContext(context)
        const template = toTemplate(pieces)
        expect(yield* Effect.promise(() => applyTemplates(tctx, template)))
          .toBe(substituteTemplateKeys(tctx, template))
      }),
    { arbitrary: { runs: 3000, size: 10 } }
  )
})
