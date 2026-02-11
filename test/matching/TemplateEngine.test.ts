import { describe, expect, it } from "vitest"
import { applyTemplates, flattenRequestContext } from "imposters/matching/TemplateEngine.js"
import type { RequestContext } from "imposters/matching/RequestMatcher.js"

const makeCtx = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  method: "GET",
  path: "/users/123",
  headers: { authorization: "Bearer abc", "content-type": "application/json" },
  query: { page: "1", name: "Alice" },
  body: undefined,
  ...overrides
})

describe("flattenRequestContext", () => {
  it("flattens method and path", () => {
    const result = flattenRequestContext(makeCtx())
    expect(result["request.method"]).toBe("GET")
    expect(result["request.path"]).toBe("/users/123")
  })

  it("flattens headers", () => {
    const result = flattenRequestContext(makeCtx())
    expect(result["request.headers.authorization"]).toBe("Bearer abc")
    expect(result["request.headers.content-type"]).toBe("application/json")
  })

  it("flattens query params", () => {
    const result = flattenRequestContext(makeCtx())
    expect(result["request.query.page"]).toBe("1")
    expect(result["request.query.name"]).toBe("Alice")
  })

  it("flattens simple body", () => {
    const ctx = makeCtx({ body: { name: "Alice", age: 30 } })
    const result = flattenRequestContext(ctx)
    expect(result["request.body.name"]).toBe("Alice")
    expect(result["request.body.age"]).toBe("30")
  })

  it("deep-flattens nested body", () => {
    const ctx = makeCtx({ body: { user: { name: "Bob", address: { city: "NYC" } } } })
    const result = flattenRequestContext(ctx)
    expect(result["request.body.user.name"]).toBe("Bob")
    expect(result["request.body.user.address.city"]).toBe("NYC")
  })

  it("flattens string body", () => {
    const ctx = makeCtx({ body: "plain text" })
    const result = flattenRequestContext(ctx)
    expect(result["request.body"]).toBe("plain text")
  })

  it("skips undefined body", () => {
    const ctx = makeCtx({ body: undefined })
    const result = flattenRequestContext(ctx)
    expect(result["request.body"]).toBeUndefined()
  })
})

describe("applyTemplates", () => {
  it("substitutes method in string", () => {
    const ctx = makeCtx({ method: "POST" })
    expect(applyTemplates(ctx, "Method is {{request.method}}")).toBe("Method is POST")
  })

  it("substitutes query param in string", () => {
    const ctx = makeCtx({ query: { name: "Alice" } })
    expect(applyTemplates(ctx, "Hello, {{request.query.name}}!")).toBe("Hello, Alice!")
  })

  it("substitutes body field in string", () => {
    const ctx = makeCtx({ body: { greeting: "Hi" } })
    expect(applyTemplates(ctx, "Says: {{request.body.greeting}}")).toBe("Says: Hi")
  })

  it("substitutes in object values recursively", () => {
    const ctx = makeCtx({ query: { name: "Alice" } })
    const data = { message: "Hello, {{request.query.name}}!", path: "{{request.path}}" }
    expect(applyTemplates(ctx, data)).toEqual({ message: "Hello, Alice!", path: "/users/123" })
  })

  it("substitutes in arrays", () => {
    const ctx = makeCtx({ method: "GET" })
    const data = ["{{request.method}}", "static"]
    expect(applyTemplates(ctx, data)).toEqual(["GET", "static"])
  })

  it("leaves non-string primitives unchanged", () => {
    const ctx = makeCtx()
    expect(applyTemplates(ctx, 42)).toBe(42)
    expect(applyTemplates(ctx, true)).toBe(true)
    expect(applyTemplates(ctx, null)).toBeNull()
  })

  it("handles multiple substitutions in one string", () => {
    const ctx = makeCtx({ method: "POST", path: "/api" })
    expect(applyTemplates(ctx, "{{request.method}} {{request.path}}")).toBe("POST /api")
  })

  it("preserves template if no matching key", () => {
    const ctx = makeCtx()
    expect(applyTemplates(ctx, "{{request.nonexistent}}")).toBe("{{request.nonexistent}}")
  })
})
