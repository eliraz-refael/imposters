import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { RequestContext } from "imposters/matching/RequestMatcher"
import { applyTemplates, substituteTemplateKeys, type TemplateContext } from "imposters/matching/TemplateEngine"
import { describe, expect, vi } from "vitest"

// `{{key}}` substitution resolves keys on demand. This pins it to the eager engine it replaced,
// copied here as the oracle: flatten the whole context into a map (every nested level
// stringified), then replaceAll each `{{key}}`, key by key. Over random contexts (nested objects
// and arrays, keys with dots, digits, spaces, empty keys, the same path reachable two ways) and
// templates mixing real keys, fake keys and stray braces, both give the same bytes.
//
// Two oracle quirks are left out of the inputs on purpose, and the new engine does not copy them
// (see the plain tests below): the oracle re-scanned an inserted value for keys later in its
// order (a value holding `{{…}}` was templated again), and replaceAll read `$&`, `$$`, `` $` ``
// and `$'` in a value as replacement patterns. So generated keys and values hold no braces and
// no `$`.

// ---------------------------------------------------------------- the oracle (the old engine)

const oracleFlattenObject = (obj: unknown, prefix: string, result: Record<string, string>): void => {
  if (obj === null || obj === undefined) return
  if (typeof obj === "string") {
    result[prefix] = obj
    return
  }
  if (typeof obj === "number" || typeof obj === "boolean") {
    result[prefix] = String(obj)
    return
  }
  if (Array.isArray(obj)) {
    result[prefix] = JSON.stringify(obj)
    obj.forEach((item, i) => oracleFlattenObject(item, `${prefix}.${i}`, result))
    return
  }
  if (typeof obj === "object") {
    result[prefix] = JSON.stringify(obj)
    for (const [key, val] of Object.entries(obj)) {
      oracleFlattenObject(val, `${prefix}.${key}`, result)
    }
  }
}

const oracleFlatten = (tctx: TemplateContext): Record<string, string> => {
  const ctx = tctx.request
  const result: Record<string, string> = { "request.method": ctx.method, "request.path": ctx.path }
  for (const [key, val] of Object.entries(ctx.headers)) result[`request.headers.${key}`] = val
  for (const [key, val] of Object.entries(ctx.query)) result[`request.query.${key}`] = val
  if (ctx.body !== undefined && ctx.body !== null) oracleFlattenObject(ctx.body, "request.body", result)
  if (tctx.callbacks !== undefined) {
    for (const [name, callback] of Object.entries(tctx.callbacks)) {
      oracleFlattenObject(callback, `callbacks.${name}`, result)
    }
  }
  return result
}

const oracleSubstitute = (params: Record<string, string>) => (body: unknown): unknown => {
  if (typeof body === "string") {
    return Object.entries(params).reduce((acc, [key, value]) => acc.replaceAll(`{{${key}}}`, value), body)
  }
  if (Array.isArray(body)) return body.map(oracleSubstitute(params))
  if (body !== null && typeof body === "object") {
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, oracleSubstitute(params)(v)]))
  }
  return body
}

// ---------------------------------------------------------------- inputs

// Keys that collide and nest: "a.b" beside a: { b }, array indices beside object keys "0"/"1"
const Key = Schema.Literals(["a", "b", "a.b", "0", "1", "10", "", "x y", "é", "a.", ".b", "items", "__proto__"])
const Text = Schema.Literals(["v", "w", "", "GET", "a b", "1", "true", "null", "é", "}", "{", "x.y", "[1]"])
const Leaf = Schema.Union([Text, Schema.Finite, Schema.Boolean, Schema.Null])
const Json1 = Schema.Union([Leaf, Schema.Array(Leaf), Schema.Record(Key, Leaf)])
const Json2 = Schema.Union([Leaf, Schema.Array(Json1), Schema.Record(Key, Json1)])
const Json3 = Schema.Union([Leaf, Schema.Array(Json2), Schema.Record(Key, Json2)])

const Context = Schema.Struct({
  method: Schema.Literals(["GET", "POST"]),
  path: Schema.Literals(["/", "/a/b", "/x y"]),
  headers: Schema.Record(Key, Text),
  query: Schema.Record(Key, Text),
  body: Schema.optional(Json3),
  callbacks: Schema.optional(Schema.Record(
    Schema.Literals(["cart", "price", "a"]),
    Schema.Struct({
      ok: Schema.Boolean,
      status: Schema.optionalKey(Schema.Int),
      headers: Schema.optionalKey(Schema.Record(Key, Text)),
      body: Schema.optionalKey(Json3),
      durationMs: Schema.Int,
      error: Schema.optionalKey(Text)
    })
  ))
})

// A template is pieces: a key the context has (by index into the oracle's keys), a key it may
// not have, or plain text and stray braces
const Piece = Schema.Union([
  Schema.TaggedStruct("Real", { index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })) }),
  Schema.TaggedStruct("Fake", {
    key: Schema.Literals([
      "request",
      "request.headers",
      "request.query",
      "request.body.zz",
      "request.body.a.b.c",
      "callbacks",
      "callbacks.nope",
      "callbacks.cart.body.9",
      "request.body.0.0",
      "request.body."
    ])
  }),
  Schema.TaggedStruct("Text", { text: Schema.Literals([" ", "x", "{", "}", "{{", "}}", "{{{", "}}}", ".", "a.b"]) })
])

const toContext = (input: Schema.Schema.Type<typeof Context>): TemplateContext => {
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

const toTemplate = (pieces: ReadonlyArray<Schema.Schema.Type<typeof Piece>>, keys: ReadonlyArray<string>): string =>
  pieces.map((piece) => {
    switch (piece._tag) {
      case "Real":
        return keys.length === 0 ? "{{request.method}}" : `{{${keys[piece.index % keys.length] ?? ""}}}`
      case "Fake":
        return `{{${piece.key}}}`
      case "Text":
        return piece.text
    }
  }).join("")

describe("{{key}} substitution (property)", () => {
  it.prop(
    "renders exactly what the eager engine rendered",
    { context: Context, pieces: Schema.Array(Piece), more: Schema.Array(Piece) },
    ({ context, more, pieces }) => {
      const tctx = toContext(context)
      const flat = oracleFlatten(tctx)
      const keys = Object.keys(flat)
      const template = toTemplate(pieces, keys)
      const data = { a: template, list: [toTemplate(more, keys), 1, null, { nested: template }] }
      expect(substituteTemplateKeys(tctx, template)).toBe(oracleSubstitute(flat)(template))
      expect(substituteTemplateKeys(tctx, data)).toEqual(oracleSubstitute(flat)(data))
    },
    { arbitrary: { runs: 2000, size: 12 } }
  )
})

describe("{{key}} substitution: where it parts from the eager engine", () => {
  const request: RequestContext = {
    method: "GET",
    path: "/",
    headers: { h: "{{request.query.q}}" },
    query: { q: "secret", price: "$&$$" },
    body: undefined,
    rawBody: new Uint8Array(0)
  }
  const tctx: TemplateContext = { request }

  it("an inserted value is not templated again", () => {
    expect(substituteTemplateKeys(tctx, "{{request.headers.h}}")).toBe("{{request.query.q}}")
    expect(oracleSubstitute(oracleFlatten(tctx))("{{request.headers.h}}")).toBe("secret")
  })

  it("a value is inserted verbatim, never read as a replacement pattern", () => {
    expect(substituteTemplateKeys(tctx, "{{request.query.price}}")).toBe("$&$$")
    expect(oracleSubstitute(oracleFlatten(tctx))("{{request.query.price}}")).toBe("{{request.query.price}}$")
  })
})

describe("{{key}} substitution: a large answer is never stringified whole", () => {
  // Nested deeper than JSON.stringify can go: the eager engine threw on any template at all
  const DEPTH = 100_000
  const deep: unknown = JSON.parse(`${"{\"a\":".repeat(DEPTH)}1${"}".repeat(DEPTH)}`)
  // And wide: 50 000 keys, each a 1 KiB string
  const wide = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`k${i}`, "x".repeat(1024)]))
  const tctx: TemplateContext = {
    request: { method: "GET", path: "/", headers: {}, query: {}, body: undefined, rawBody: new Uint8Array(0) },
    callbacks: {
      deep: { ok: true, status: 200, body: deep, durationMs: 1 },
      wide: { ok: true, status: 200, body: wide, durationMs: 1 }
    }
  }

  it.effect("a template naming one leaf, or none, renders without touching the rest", () =>
    Effect.gen(function*() {
      const stringify = vi.spyOn(JSON, "stringify")
      try {
        const rendered = yield* Effect.promise(() =>
          applyTemplates(tctx, { a: "{{callbacks.deep.status}} {{callbacks.wide.body.k49999}}", b: "plain" })
        )
        expect(rendered).toEqual({ a: `200 ${"x".repeat(1024)}`, b: "plain" })
        // A leaf deep down is a walk of the path, nothing more
        const leaf = `{{callbacks.deep.body${".a".repeat(DEPTH)}}}`
        expect(substituteTemplateKeys(tctx, leaf)).toBe("1")
        expect(stringify).not.toHaveBeenCalled()
      } finally {
        stringify.mockRestore()
      }
    }))
})
