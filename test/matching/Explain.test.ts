import * as Schema from "effect/Schema"
import { contextFromCaptured, explainPredicate, explainStubs } from "imposters/matching/Explain"
import {
  evaluatePredicate,
  extractRequestContext,
  findMatchingStub,
  type RequestContext
} from "imposters/matching/RequestMatcher"
import { Predicate, Stub } from "imposters/schemas/StubSchema"
import { describe, expect, it } from "vitest"

const encoder = new TextEncoder()

const makeCtx = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  method: "GET",
  path: "/",
  headers: {},
  query: {},
  body: undefined,
  rawBody: new Uint8Array(0),
  ...overrides
})

const decodePredicate = Schema.decodeUnknownSync(Predicate)
const p = (
  field: Predicate["field"],
  operator: Predicate["operator"],
  value?: unknown,
  caseSensitive = true
): Predicate => decodePredicate({ field, operator, value, caseSensitive })

const stub = (id: string, predicates: ReadonlyArray<Predicate>): Stub =>
  Schema.decodeUnknownSync(Stub)({ id, predicates, responses: [{ status: 200 }] })

const users = makeCtx({
  method: "GET",
  path: "/users/42",
  headers: { "content-type": "application/json", "x-id": "Abc" },
  query: { page: "2", q: "Hello" },
  body: { name: "Ada", tags: ["a", "b"], n: 1 },
  rawBody: encoder.encode(JSON.stringify({ name: "Ada", tags: ["a", "b"], n: 1 }))
})
const orders = makeCtx({
  method: "POST",
  path: "/orders",
  headers: { "content-type": "text/plain" },
  body: "plain text Body",
  rawBody: encoder.encode("plain text Body")
})
const empty = makeCtx({ method: "DELETE", path: "/orders/7", query: { page: "x" } })
const contexts: ReadonlyArray<RequestContext> = [users, orders, empty]

// Every field with every operator, each meant to pass on some request above and fail on another
const predicates: ReadonlyArray<Predicate> = [
  p("method", "equals", "GET"),
  p("method", "equals", "get", false),
  p("method", "equals", "get"),
  p("method", "contains", "OS"),
  p("method", "startsWith", "DEL"),
  p("method", "matches", "^G.T$"),
  p("method", "matches", "^p", false),
  p("method", "exists"),
  p("method", "equals", 1),
  p("path", "equals", "/users/42"),
  p("path", "equals", "/USERS/42", false),
  p("path", "contains", "orders"),
  p("path", "startsWith", "/orders"),
  p("path", "matches", "^/users/\\d+$"),
  p("path", "exists"),
  p("headers", "equals", { "x-id": "Abc" }),
  p("headers", "equals", { "X-ID": "abc" }, false),
  p("headers", "equals", { "X-ID": "Abc" }),
  p("headers", "equals", { "x-id": 1 }),
  p("headers", "equals", "not-an-object"),
  p("headers", "contains", { "content-type": "json" }),
  p("headers", "startsWith", { "content-type": "text" }),
  p("headers", "matches", { "x-id": "^A" }),
  p("headers", "exists", { "x-id": true }),
  p("headers", "exists", { "X-Id": true }),
  p("headers", "exists", { missing: true }),
  p("headers", "exists"),
  p("query", "equals", { page: "2" }),
  p("query", "contains", { q: "ell" }),
  p("query", "startsWith", { q: "he" }, false),
  p("query", "matches", { page: "^\\d$" }),
  p("query", "exists", { page: true }),
  p("query", "exists", { nope: true }),
  p("body", "equals", { name: "Ada" }),
  p("body", "equals", { name: "ada" }, false),
  p("body", "equals", { tags: ["a"] }),
  p("body", "equals", { name: "Bob" }),
  p("body", "equals", "plain text body", false),
  p("body", "equals", null),
  p("body", "contains", "Ada"),
  p("body", "contains", { n: 1 }),
  p("body", "startsWith", "{\"name\""),
  p("body", "startsWith", "plain"),
  p("body", "matches", "ada|TEXT", false),
  p("body", "matches", "^plain"),
  p("body", "exists")
]

// A pattern `new RegExp` throws on, for every field that can reach it
const invalidRegex: ReadonlyArray<Predicate> = [
  p("method", "matches", "("),
  p("path", "matches", "("),
  p("headers", "matches", { "x-id": "(" }),
  p("query", "matches", { page: "(" }),
  p("body", "matches", "(")
]

const evaluateOrThrow = (ctx: RequestContext, predicate: Predicate): boolean | "throws" => {
  try {
    return evaluatePredicate(ctx, predicate)
  } catch {
    return "throws"
  }
}

describe("explainPredicate", () => {
  it("decides exactly as evaluatePredicate does, for every field and operator", () => {
    for (const ctx of contexts) {
      for (const predicate of predicates) {
        const explained = explainPredicate(ctx, predicate)
        expect({ predicate, matched: explained.matched }).toEqual({
          predicate,
          matched: evaluatePredicate(ctx, predicate)
        })
        expect(explained.error).toBeUndefined()
      }
    }
  })

  it("covers a pass and a fail for every operator", () => {
    const seen = new Set<string>()
    for (const ctx of contexts) {
      for (const predicate of predicates) {
        seen.add(`${predicate.operator}:${explainPredicate(ctx, predicate).matched}`)
      }
    }
    for (const operator of ["equals", "contains", "startsWith", "matches", "exists"]) {
      expect(seen).toContain(`${operator}:true`)
      expect(seen).toContain(`${operator}:false`)
    }
  })

  it("turns an invalid regex into an error, where evaluatePredicate throws", () => {
    const ctx = users
    for (const predicate of invalidRegex) {
      expect(evaluateOrThrow(ctx, predicate)).toBe("throws")
      const explained = explainPredicate(ctx, predicate)
      expect(explained.matched).toBe(false)
      expect(explained.error).toMatch(/regular expression/i)
    }
  })

  it("echoes the predicate and the request's value for the field", () => {
    const ctx = users
    expect(explainPredicate(ctx, p("path", "startsWith", "/users"))).toEqual({
      field: "path",
      operator: "startsWith",
      caseSensitive: true,
      expected: "/users",
      actual: "/users/42",
      matched: true
    })
    expect(explainPredicate(ctx, p("body", "equals", { name: "Bob" }))).toMatchObject({
      expected: { name: "Bob" },
      actual: { name: "Ada", tags: ["a", "b"], n: 1 },
      matched: false
    })
  })

  it("shows only the headers and query keys the predicate names, near misses included", () => {
    const ctx = users
    // Case-sensitive, so "X-ID" does not match "x-id", but the value sent is shown
    expect(explainPredicate(ctx, p("headers", "equals", { "X-ID": "Abc", missing: "1" }))).toMatchObject({
      actual: { "x-id": "Abc" },
      matched: false
    })
    expect(explainPredicate(ctx, p("query", "equals", { page: "2" }))).toMatchObject({
      actual: { page: "2" },
      matched: true
    })
    // Not an object: there are no keys to pick, so the whole record is shown
    expect(explainPredicate(ctx, p("query", "equals", "page"))).toMatchObject({
      actual: { page: "2", q: "Hello" },
      matched: false
    })
  })

  it("leaves out an absent expected value and an absent body", () => {
    const explained = explainPredicate(empty, p("body", "exists"))
    expect(explained).toEqual({ field: "body", operator: "exists", caseSensitive: true, matched: false })
  })
})

describe("explainStubs", () => {
  // Stubs of two predicates each, mixed so that some requests match several and some none
  const stubs = predicates.map((first, i) => {
    const second = (i * 7 + 3) % predicates.length
    return stub(`s${i}`, [first, ...predicates.slice(second, second + 1)])
  })

  it("picks the stub findMatchingStub picks, for every request and many stub orders", () => {
    for (let shift = 0; shift < stubs.length; shift++) {
      const ordered = [...stubs.slice(shift), ...stubs.slice(0, shift)]
      for (const ctx of contexts) {
        const result = explainStubs(ctx, ordered)
        expect(result.match).toBe(findMatchingStub(ctx, ordered))
        expect(result.error).toBeUndefined()
        expect(result.stubs.map((s) => s.stubId)).toEqual(ordered.map((s) => s.id))
      }
    }
  })

  it("explains every stub, and every predicate past the first that fails", () => {
    const ctx = users
    const result = explainStubs(ctx, [
      stub("miss", [p("method", "equals", "POST"), p("path", "equals", "/users/42")]),
      stub("hit", [p("path", "startsWith", "/users")]),
      stub("later", [])
    ])
    expect(result.match?.id).toBe("hit")
    expect(result.stubs.map((s) => [s.stubId, s.matched])).toEqual([["miss", false], ["hit", true], ["later", true]])
    expect(result.stubs[0]?.predicates.map((e) => e.matched)).toEqual([false, true])
  })

  it("matches nothing when no stub matches, or there are no stubs", () => {
    expect(explainStubs(empty, [stub("a", [p("method", "equals", "GET")])])).toEqual({
      stubs: [expect.objectContaining({ stubId: "a", matched: false })]
    })
    expect(explainStubs(users, [])).toEqual({ stubs: [] })
  })

  it("reports the error findMatchingStub throws on an invalid regex it reaches", () => {
    const ctx = users
    const ordered = [stub("bad", [p("path", "matches", "(")]), stub("good", [])]
    expect(() => findMatchingStub(ctx, ordered)).toThrow()
    const result = explainStubs(ctx, ordered)
    expect(result.match).toBeUndefined()
    expect(result.error).toMatch(/regular expression/i)
    expect(result.stubs[0]).toMatchObject({ stubId: "bad", matched: false, error: result.error })
    // The stub after it is still explained
    expect(result.stubs[1]).toMatchObject({ stubId: "good", matched: true })
  })

  it("ignores an invalid regex the matcher never reaches", () => {
    const ctx = users
    // Behind a failing predicate in its own stub, then behind a match
    const ordered = [
      stub("guarded", [p("method", "equals", "DELETE"), p("path", "matches", "(")]),
      stub("good", []),
      stub("bad", [p("path", "matches", "(")])
    ]
    expect(findMatchingStub(ctx, ordered)?.id).toBe("good")
    const result = explainStubs(ctx, ordered)
    expect(result.match?.id).toBe("good")
    expect(result.error).toBeUndefined()
    expect(result.stubs[0]?.error).toBeUndefined()
    expect(result.stubs[0]?.predicates[1]?.error).toMatch(/regular expression/i)
    expect(result.stubs[2]?.error).toMatch(/regular expression/i)
  })
})

describe("contextFromCaptured", () => {
  const captured = (ctx: RequestContext) => ({
    method: ctx.method,
    path: ctx.path,
    headers: ctx.headers,
    query: ctx.query,
    body: ctx.body
  })

  it("rebuilds the context a request was matched with, so every predicate decides the same", async () => {
    const requests = [
      new Request("http://localhost/users/42?page=2&q=Hello", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Id": "Abc" },
        body: JSON.stringify({ name: "Ada", tags: ["a", "b"], n: 1 })
      }),
      new Request("http://localhost/orders", { method: "PUT", body: "plain text Body" }),
      new Request("http://localhost/empty")
    ]
    for (const request of requests) {
      const original = await extractRequestContext(request)
      const rebuilt = contextFromCaptured(captured(original))
      expect(rebuilt).toEqual(original)
      for (const predicate of predicates) {
        expect(explainPredicate(rebuilt, predicate)).toEqual(explainPredicate(original, predicate))
      }
    }
  })
})
