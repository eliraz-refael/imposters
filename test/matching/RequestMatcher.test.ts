import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  decodeBody,
  evaluatePredicate,
  evaluatePredicates,
  extractRequestContext,
  findMatchingStub
} from "imposters/matching/RequestMatcher"
import type { RequestContext } from "imposters/matching/RequestMatcher"
import { Stub } from "imposters/schemas/StubSchema"
import type { Predicate } from "imposters/schemas/StubSchema"
import { describe, expect } from "vitest"

const makeCtx = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  method: "GET",
  path: "/users",
  headers: {},
  query: {},
  body: undefined,
  rawBody: new Uint8Array(0),
  ...overrides
})

const makePredicate = (overrides: Partial<Predicate> & Pick<Predicate, "field" | "operator">): Predicate => ({
  caseSensitive: true,
  value: undefined,
  ...overrides
})

const makeStub = (id: string, predicates: ReadonlyArray<Predicate> = [], status = 200) =>
  Schema.decodeUnknownSync(Stub)({
    id,
    predicates,
    responses: [{ status }]
  })

describe("extractRequestContext", () => {
  it("parses a simple GET request", async () => {
    const req = new Request("http://localhost:3000/users?page=1&limit=10")
    const ctx = await extractRequestContext(req)
    expect(ctx.method).toBe("GET")
    expect(ctx.path).toBe("/users")
    expect(ctx.query).toEqual({ page: "1", limit: "10" })
    expect(ctx.body).toBeUndefined()
  })

  it("parses JSON body", async () => {
    const req = new Request("http://localhost:3000/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Alice", age: 30 })
    })
    const ctx = await extractRequestContext(req)
    expect(ctx.method).toBe("POST")
    expect(ctx.body).toEqual({ name: "Alice", age: 30 })
  })

  it("falls back to text body for non-JSON", async () => {
    const req = new Request("http://localhost:3000/data", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello world"
    })
    const ctx = await extractRequestContext(req)
    expect(ctx.body).toBe("hello world")
  })

  it("lowercases header keys", async () => {
    const req = new Request("http://localhost:3000/users", {
      headers: { "Authorization": "Bearer abc", "X-Custom": "value" }
    })
    const ctx = await extractRequestContext(req)
    expect(ctx.headers["authorization"]).toBe("Bearer abc")
    expect(ctx.headers["x-custom"]).toBe("value")
  })
})

const postBody = (contentType: string, body: Uint8Array<ArrayBuffer>) =>
  new Request("http://localhost:3000/upload", { method: "POST", headers: { "content-type": contentType }, body })

const utf8 = (s: string) => new TextEncoder().encode(s)

// A JPEG header: 0xff is never valid in UTF-8
const jpegHeader = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])

describe("extractRequestContext - binary-safe bodies", () => {
  it.effect.prop(
    "rawBody is exactly the bytes sent, whatever the content type",
    {
      bytes: Schema.Uint8Array,
      contentType: Schema.Literals(["application/octet-stream", "application/json", "text/plain"])
    },
    ({ bytes, contentType }) =>
      Effect.gen(function*() {
        const sent = new Uint8Array(bytes)
        const ctx = yield* Effect.promise(() => extractRequestContext(postBody(contentType, sent)))
        expect(ctx.rawBody).toEqual(sent)
      }),
    { arbitrary: { runs: 50 } }
  )

  it.effect.prop(
    "text/plain body is the UTF-8 text sent (lone surrogates arrive as U+FFFD)",
    { s: Schema.String },
    ({ s }) =>
      Effect.gen(function*() {
        const ctx = yield* Effect.promise(() => extractRequestContext(postBody("text/plain", utf8(s))))
        expect(ctx.body).toBe(s === "" ? undefined : new TextDecoder().decode(utf8(s)))
      }),
    { arbitrary: { runs: 50 } }
  )

  it.effect.prop(
    "application/json body round-trips a JSON value",
    { value: Schema.Json },
    ({ value }) =>
      Effect.gen(function*() {
        const text = JSON.stringify(value)
        const ctx = yield* Effect.promise(() => extractRequestContext(postBody("application/json", utf8(text))))
        expect(JSON.stringify(ctx.body)).toBe(text)
      }),
    { arbitrary: { runs: 50 } }
  )

  it("binary body has no parsed view, but keeps its bytes", async () => {
    const ctx = await extractRequestContext(postBody("image/jpeg", new Uint8Array(jpegHeader)))
    expect(ctx.body).toBeUndefined()
    expect(ctx.rawBody).toEqual(jpegHeader)
  })

  it("request without a body has an empty rawBody", async () => {
    const ctx = await extractRequestContext(new Request("http://localhost:3000/users"))
    expect(ctx.body).toBeUndefined()
    expect(ctx.rawBody).toEqual(new Uint8Array(0))
  })
})

describe("decodeBody", () => {
  it("is undefined for empty bytes", () => {
    expect(decodeBody("application/json", new Uint8Array(0))).toBeUndefined()
  })

  it("is undefined for non-UTF-8 bytes, even when labelled JSON or text", () => {
    expect(decodeBody("application/json", jpegHeader)).toBeUndefined()
    expect(decodeBody("text/plain", jpegHeader)).toBeUndefined()
  })

  it("falls back to text for malformed JSON", () => {
    expect(decodeBody("application/json", utf8("{not json"))).toBe("{not json")
  })

  it("keeps JSON-looking text as text when not labelled JSON", () => {
    expect(decodeBody("text/plain", utf8("{\"a\":1}"))).toBe("{\"a\":1}")
  })
})

describe("evaluatePredicate - method", () => {
  it("equals matches exact method", () => {
    const ctx = makeCtx({ method: "POST" })
    expect(evaluatePredicate(ctx, makePredicate({ field: "method", operator: "equals", value: "POST" }))).toBe(true)
    expect(evaluatePredicate(ctx, makePredicate({ field: "method", operator: "equals", value: "GET" }))).toBe(false)
  })

  it("contains matches substring", () => {
    const ctx = makeCtx({ method: "POST" })
    expect(evaluatePredicate(ctx, makePredicate({ field: "method", operator: "contains", value: "OS" }))).toBe(true)
  })

  it("startsWith matches prefix", () => {
    const ctx = makeCtx({ method: "DELETE" })
    expect(evaluatePredicate(ctx, makePredicate({ field: "method", operator: "startsWith", value: "DEL" }))).toBe(true)
  })

  it("matches evaluates regex", () => {
    const ctx = makeCtx({ method: "GET" })
    expect(evaluatePredicate(ctx, makePredicate({ field: "method", operator: "matches", value: "^G.T$" }))).toBe(true)
  })

  it("exists returns true for method (always present)", () => {
    const ctx = makeCtx()
    expect(evaluatePredicate(ctx, makePredicate({ field: "method", operator: "exists" }))).toBe(true)
  })

  it("case insensitive equals", () => {
    const ctx = makeCtx({ method: "GET" })
    expect(
      evaluatePredicate(ctx, makePredicate({ field: "method", operator: "equals", value: "get", caseSensitive: false }))
    ).toBe(true)
  })
})

describe("evaluatePredicate - path", () => {
  it("equals matches exact path", () => {
    const ctx = makeCtx({ path: "/users/123" })
    expect(evaluatePredicate(ctx, makePredicate({ field: "path", operator: "equals", value: "/users/123" }))).toBe(true)
  })

  it("startsWith matches path prefix", () => {
    const ctx = makeCtx({ path: "/api/v1/users" })
    expect(evaluatePredicate(ctx, makePredicate({ field: "path", operator: "startsWith", value: "/api" }))).toBe(true)
  })

  it("matches evaluates regex on path", () => {
    const ctx = makeCtx({ path: "/users/456" })
    expect(evaluatePredicate(ctx, makePredicate({ field: "path", operator: "matches", value: "/users/\\d+" }))).toBe(
      true
    )
  })
})

describe("evaluatePredicate - headers", () => {
  it("equals matches header value exactly", () => {
    const ctx = makeCtx({ headers: { authorization: "Bearer token123" } })
    expect(evaluatePredicate(
      ctx,
      makePredicate({
        field: "headers",
        operator: "equals",
        value: { authorization: "Bearer token123" }
      })
    )).toBe(true)
  })

  it("contains matches substring in header value", () => {
    const ctx = makeCtx({ headers: { authorization: "Bearer token123" } })
    expect(evaluatePredicate(
      ctx,
      makePredicate({
        field: "headers",
        operator: "contains",
        value: { authorization: "token" }
      })
    )).toBe(true)
  })

  it("exists checks header key presence", () => {
    const ctx = makeCtx({ headers: { authorization: "Bearer abc" } })
    expect(evaluatePredicate(
      ctx,
      makePredicate({
        field: "headers",
        operator: "exists",
        value: { authorization: true }
      })
    )).toBe(true)
    expect(evaluatePredicate(
      ctx,
      makePredicate({
        field: "headers",
        operator: "exists",
        value: { "x-missing": true }
      })
    )).toBe(false)
  })

  it("case insensitive header matching", () => {
    const ctx = makeCtx({ headers: { "content-type": "Application/JSON" } })
    expect(evaluatePredicate(
      ctx,
      makePredicate({
        field: "headers",
        operator: "equals",
        value: { "content-type": "application/json" },
        caseSensitive: false
      })
    )).toBe(true)
  })
})

describe("evaluatePredicate - query", () => {
  it("equals matches query parameter", () => {
    const ctx = makeCtx({ query: { page: "1", limit: "10" } })
    expect(evaluatePredicate(
      ctx,
      makePredicate({
        field: "query",
        operator: "equals",
        value: { page: "1" }
      })
    )).toBe(true)
  })

  it("matches validates regex on query values", () => {
    const ctx = makeCtx({ query: { id: "abc123" } })
    expect(evaluatePredicate(
      ctx,
      makePredicate({
        field: "query",
        operator: "matches",
        value: { id: "^[a-z]+\\d+$" }
      })
    )).toBe(true)
  })
})

describe("evaluatePredicate - body", () => {
  it("equals does deep subset match on object body", () => {
    const ctx = makeCtx({ body: { name: "Alice", age: 30, nested: { x: 1 } } })
    expect(evaluatePredicate(
      ctx,
      makePredicate({
        field: "body",
        operator: "equals",
        value: { name: "Alice" }
      })
    )).toBe(true)
    expect(evaluatePredicate(
      ctx,
      makePredicate({
        field: "body",
        operator: "equals",
        value: { name: "Bob" }
      })
    )).toBe(false)
  })

  it("contains checks substring in JSON.stringify", () => {
    const ctx = makeCtx({ body: { name: "Alice" } })
    expect(evaluatePredicate(
      ctx,
      makePredicate({
        field: "body",
        operator: "contains",
        value: "Alice"
      })
    )).toBe(true)
  })

  it("exists checks body is non-null/undefined", () => {
    expect(evaluatePredicate(
      makeCtx({ body: { x: 1 } }),
      makePredicate({
        field: "body",
        operator: "exists"
      })
    )).toBe(true)
    expect(evaluatePredicate(
      makeCtx({ body: undefined }),
      makePredicate({
        field: "body",
        operator: "exists"
      })
    )).toBe(false)
  })

  it("contains, startsWith and matches fail on an empty body instead of throwing", () => {
    const ctx = makeCtx({ body: undefined })
    for (const operator of ["contains", "startsWith", "matches"] as const) {
      for (const caseSensitive of [true, false]) {
        // "undefined" is what the missing body used to be searched as
        expect(evaluatePredicate(ctx, makePredicate({ field: "body", operator, value: "undefined", caseSensitive })))
          .toBe(false)
      }
    }
  })

  it("matches evaluates regex on body JSON", () => {
    const ctx = makeCtx({ body: { name: "Alice" } })
    expect(evaluatePredicate(
      ctx,
      makePredicate({
        field: "body",
        operator: "matches",
        value: "Alice"
      })
    )).toBe(true)
  })
})

describe("evaluatePredicates", () => {
  it("empty predicates match everything (catch-all)", () => {
    expect(evaluatePredicates(makeCtx(), [])).toBe(true)
  })

  it("AND-combines predicates", () => {
    const ctx = makeCtx({ method: "GET", path: "/users" })
    const predicates = [
      makePredicate({ field: "method", operator: "equals", value: "GET" }),
      makePredicate({ field: "path", operator: "equals", value: "/users" })
    ]
    expect(evaluatePredicates(ctx, predicates)).toBe(true)
  })

  it("fails when any predicate fails", () => {
    const ctx = makeCtx({ method: "GET", path: "/users" })
    const predicates = [
      makePredicate({ field: "method", operator: "equals", value: "GET" }),
      makePredicate({ field: "path", operator: "equals", value: "/posts" })
    ]
    expect(evaluatePredicates(ctx, predicates)).toBe(false)
  })
})

describe("findMatchingStub", () => {
  it("returns first matching stub", () => {
    const ctx = makeCtx({ method: "GET", path: "/users" })
    const stubs = [
      makeStub("s1", [makePredicate({ field: "method", operator: "equals", value: "POST" })], 201),
      makeStub("s2", [makePredicate({ field: "method", operator: "equals", value: "GET" })], 200),
      makeStub("s3", [], 404) // catch-all
    ]
    const match = findMatchingStub(ctx, stubs)
    expect(match?.id).toBe("s2")
  })

  it("returns undefined when no stub matches", () => {
    const ctx = makeCtx({ method: "DELETE" })
    const stubs = [
      makeStub("s1", [makePredicate({ field: "method", operator: "equals", value: "GET" })])
    ]
    expect(findMatchingStub(ctx, stubs)).toBeUndefined()
  })

  it("catch-all stub matches anything", () => {
    const ctx = makeCtx({ method: "PATCH", path: "/anything" })
    const stubs = [makeStub("catch-all", [], 200)]
    const match = findMatchingStub(ctx, stubs)
    expect(match?.id).toBe("catch-all")
  })
})
