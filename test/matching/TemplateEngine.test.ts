import type { RequestContext } from "imposters/matching/RequestMatcher.js"
import { applyTemplates, flattenRequestContext } from "imposters/matching/TemplateEngine.js"
import { describe, expect, it } from "vitest"

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
  it("substitutes method in string", async () => {
    const ctx = makeCtx({ method: "POST" })
    expect(await applyTemplates(ctx, "Method is {{request.method}}")).toBe("Method is POST")
  })

  it("substitutes query param in string", async () => {
    const ctx = makeCtx({ query: { name: "Alice" } })
    expect(await applyTemplates(ctx, "Hello, {{request.query.name}}!")).toBe("Hello, Alice!")
  })

  it("substitutes body field in string", async () => {
    const ctx = makeCtx({ body: { greeting: "Hi" } })
    expect(await applyTemplates(ctx, "Says: {{request.body.greeting}}")).toBe("Says: Hi")
  })

  it("substitutes in object values recursively", async () => {
    const ctx = makeCtx({ query: { name: "Alice" } })
    const data = { message: "Hello, {{request.query.name}}!", path: "{{request.path}}" }
    expect(await applyTemplates(ctx, data)).toEqual({ message: "Hello, Alice!", path: "/users/123" })
  })

  it("substitutes in arrays", async () => {
    const ctx = makeCtx({ method: "GET" })
    const data = ["{{request.method}}", "static"]
    expect(await applyTemplates(ctx, data)).toEqual(["GET", "static"])
  })

  it("leaves non-string primitives unchanged", async () => {
    const ctx = makeCtx()
    expect(await applyTemplates(ctx, 42)).toBe(42)
    expect(await applyTemplates(ctx, true)).toBe(true)
    expect(await applyTemplates(ctx, null)).toBeNull()
  })

  it("handles multiple substitutions in one string", async () => {
    const ctx = makeCtx({ method: "POST", path: "/api" })
    expect(await applyTemplates(ctx, "{{request.method}} {{request.path}}")).toBe("POST /api")
  })

  it("preserves template if no matching key", async () => {
    const ctx = makeCtx()
    expect(await applyTemplates(ctx, "{{request.nonexistent}}")).toBe("{{request.nonexistent}}")
  })

  // ${expr} JSONata expressions
  it("evaluates ${expr} JSONata expression", async () => {
    const ctx = makeCtx({ query: { name: "Alice" } })
    expect(await applyTemplates(ctx, "${$uppercase(request.query.name)}")).toBe("ALICE")
  })

  it("evaluates ${expr} in object values", async () => {
    const ctx = makeCtx({ body: { price: 10, quantity: 3 } })
    const data = { total: "${request.body.price * request.body.quantity}" }
    expect(await applyTemplates(ctx, data)).toEqual({ total: 30 })
  })

  it("coexists: {{key}} runs first, then ${expr}", async () => {
    const ctx = makeCtx({ method: "POST", query: { name: "Alice" } })
    const data = {
      template: "{{request.query.name}}",
      expression: "${$uppercase(request.query.name)}"
    }
    const result = await applyTemplates(ctx, data) as Record<string, unknown>
    expect(result.template).toBe("Alice")
    expect(result.expression).toBe("ALICE")
  })

  it("preserves ${expr} on evaluation failure", async () => {
    const ctx = makeCtx()
    expect(await applyTemplates(ctx, "${$$$bad}")).toBe("${$$$bad}")
  })

  it("handles mixed {{key}} and ${expr} in same string", async () => {
    const ctx = makeCtx({ method: "GET", query: { name: "Alice" } })
    expect(await applyTemplates(ctx, "{{request.method}} to ${$uppercase(request.query.name)}"))
      .toBe("GET to ALICE")
  })
})
