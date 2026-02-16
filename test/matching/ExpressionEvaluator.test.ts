import { evaluateExpression, processExpressions } from "imposters/matching/ExpressionEvaluator"
import type { RequestContext } from "imposters/matching/RequestMatcher"
import { describe, expect, it } from "vitest"

const makeCtx = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  method: "POST",
  path: "/users/123",
  headers: { "content-type": "application/json", authorization: "Bearer abc" },
  query: { name: "Alice", page: "2" },
  body: { price: 10, quantity: 3, items: ["a", "b", "c"] },
  ...overrides
})

describe("evaluateExpression", () => {
  it("evaluates simple field access", async () => {
    const ctx = makeCtx()
    expect(await evaluateExpression("request.method", ctx)).toBe("POST")
  })

  it("evaluates query param access", async () => {
    const ctx = makeCtx()
    expect(await evaluateExpression("request.query.name", ctx)).toBe("Alice")
  })

  it("evaluates body field access", async () => {
    const ctx = makeCtx()
    expect(await evaluateExpression("request.body.price", ctx)).toBe(10)
  })

  it("evaluates arithmetic expression", async () => {
    const ctx = makeCtx()
    expect(await evaluateExpression("request.body.price * request.body.quantity", ctx)).toBe(30)
  })

  it("evaluates JSONata $count function", async () => {
    const ctx = makeCtx()
    expect(await evaluateExpression("$count(request.body.items)", ctx)).toBe(3)
  })

  it("evaluates JSONata $uppercase function", async () => {
    const ctx = makeCtx()
    expect(await evaluateExpression("$uppercase(request.query.name)", ctx)).toBe("ALICE")
  })

  it("evaluates conditional expression", async () => {
    const ctx = makeCtx({ method: "POST" })
    expect(await evaluateExpression("request.method = 'POST' ? 'yes' : 'no'", ctx)).toBe("yes")
  })

  it("returns undefined on invalid expression", async () => {
    const ctx = makeCtx()
    expect(await evaluateExpression("$$$invalid", ctx)).toBeUndefined()
  })
})

describe("processExpressions", () => {
  it("replaces ${expr} in string with evaluated result", async () => {
    const ctx = makeCtx()
    expect(await processExpressions(ctx, "Hello ${request.query.name}")).toBe("Hello Alice")
  })

  it("preserves type for single expression", async () => {
    const ctx = makeCtx()
    expect(await processExpressions(ctx, "${request.body.price * request.body.quantity}")).toBe(30)
  })

  it("handles multiple expressions in a string", async () => {
    const ctx = makeCtx()
    expect(await processExpressions(ctx, "${request.method} ${request.path}")).toBe("POST /users/123")
  })

  it("recursively processes objects", async () => {
    const ctx = makeCtx()
    const data = {
      greeting: "Hello ${request.query.name}",
      total: "${request.body.price * request.body.quantity}"
    }
    const result = await processExpressions(ctx, data) as Record<string, unknown>
    expect(result.greeting).toBe("Hello Alice")
    expect(result.total).toBe(30)
  })

  it("recursively processes arrays", async () => {
    const ctx = makeCtx()
    const data = ["${request.method}", "static", "${request.query.name}"]
    expect(await processExpressions(ctx, data)).toEqual(["POST", "static", "Alice"])
  })

  it("leaves non-string primitives unchanged", async () => {
    const ctx = makeCtx()
    expect(await processExpressions(ctx, 42)).toBe(42)
    expect(await processExpressions(ctx, true)).toBe(true)
    expect(await processExpressions(ctx, null)).toBeNull()
  })

  it("preserves raw expression on evaluation failure", async () => {
    const ctx = makeCtx()
    expect(await processExpressions(ctx, "${$$$bad_expression}")).toBe("${$$$bad_expression}")
  })

  it("handles string without expressions unchanged", async () => {
    const ctx = makeCtx()
    expect(await processExpressions(ctx, "plain text")).toBe("plain text")
  })

  it("handles nested braces in ternary", async () => {
    const ctx = makeCtx({ method: "GET" })
    expect(await processExpressions(ctx, "${request.method = 'POST' ? 'yes' : 'no'}")).toBe("no")
  })

  it("mixed text and expression", async () => {
    const ctx = makeCtx()
    expect(await processExpressions(ctx, "Method: ${request.method}, Name: ${request.query.name}"))
      .toBe("Method: POST, Name: Alice")
  })

  it("handles JSONata $now function", async () => {
    const ctx = makeCtx()
    const result = await processExpressions(ctx, "${$now()}")
    expect(typeof result).toBe("string")
    expect(String(result)).toMatch(/^\d{4}-\d{2}-/)
  })

  it("handles string concatenation with &", async () => {
    const ctx = makeCtx()
    expect(await processExpressions(ctx, "${'Hello' & ' ' & request.query.name}")).toBe("Hello Alice")
  })
})
