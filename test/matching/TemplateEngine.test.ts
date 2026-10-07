import * as Schema from "effect/Schema"
import type { CallbackResult } from "imposters/matching/CallbackRules"
import type { RequestContext } from "imposters/matching/RequestMatcher"
import { buildResponse } from "imposters/matching/ResponseGenerator"
import {
  applyTemplates,
  flattenRequestContext,
  requestOnly,
  resolveTemplateKey,
  type TemplateContext
} from "imposters/matching/TemplateEngine"
import { ResponseConfig } from "imposters/schemas/StubSchema"
import { describe, expect, it } from "vitest"

const makeCtx = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  method: "GET",
  path: "/users/123",
  headers: { authorization: "Bearer abc", "content-type": "application/json" },
  query: { page: "1", name: "Alice" },
  body: undefined,
  rawBody: new Uint8Array(0),
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
    expect(await applyTemplates(requestOnly(ctx), "Method is {{request.method}}")).toBe("Method is POST")
  })

  it("substitutes query param in string", async () => {
    const ctx = makeCtx({ query: { name: "Alice" } })
    expect(await applyTemplates(requestOnly(ctx), "Hello, {{request.query.name}}!")).toBe("Hello, Alice!")
  })

  it("substitutes body field in string", async () => {
    const ctx = makeCtx({ body: { greeting: "Hi" } })
    expect(await applyTemplates(requestOnly(ctx), "Says: {{request.body.greeting}}")).toBe("Says: Hi")
  })

  it("substitutes in object values recursively", async () => {
    const ctx = makeCtx({ query: { name: "Alice" } })
    const data = { message: "Hello, {{request.query.name}}!", path: "{{request.path}}" }
    expect(await applyTemplates(requestOnly(ctx), data)).toEqual({ message: "Hello, Alice!", path: "/users/123" })
  })

  it("substitutes in arrays", async () => {
    const ctx = makeCtx({ method: "GET" })
    const data = ["{{request.method}}", "static"]
    expect(await applyTemplates(requestOnly(ctx), data)).toEqual(["GET", "static"])
  })

  it("leaves non-string primitives unchanged", async () => {
    const ctx = makeCtx()
    expect(await applyTemplates(requestOnly(ctx), 42)).toBe(42)
    expect(await applyTemplates(requestOnly(ctx), true)).toBe(true)
    expect(await applyTemplates(requestOnly(ctx), null)).toBeNull()
  })

  it("handles multiple substitutions in one string", async () => {
    const ctx = makeCtx({ method: "POST", path: "/api" })
    expect(await applyTemplates(requestOnly(ctx), "{{request.method}} {{request.path}}")).toBe("POST /api")
  })

  it("preserves template if no matching key", async () => {
    const ctx = makeCtx()
    expect(await applyTemplates(requestOnly(ctx), "{{request.nonexistent}}")).toBe("{{request.nonexistent}}")
  })

  // ${expr} JSONata expressions
  it("evaluates ${expr} JSONata expression", async () => {
    const ctx = makeCtx({ query: { name: "Alice" } })
    expect(await applyTemplates(requestOnly(ctx), "${$uppercase(request.query.name)}")).toBe("ALICE")
  })

  it("evaluates ${expr} in object values", async () => {
    const ctx = makeCtx({ body: { price: 10, quantity: 3 } })
    const data = { total: "${request.body.price * request.body.quantity}" }
    expect(await applyTemplates(requestOnly(ctx), data)).toEqual({ total: 30 })
  })

  it("coexists: {{key}} runs first, then ${expr}", async () => {
    const ctx = makeCtx({ method: "POST", query: { name: "Alice" } })
    const data = {
      template: "{{request.query.name}}",
      expression: "${$uppercase(request.query.name)}"
    }
    const result = await applyTemplates(requestOnly(ctx), data) as Record<string, unknown>
    expect(result.template).toBe("Alice")
    expect(result.expression).toBe("ALICE")
  })

  it("preserves ${expr} on evaluation failure", async () => {
    const ctx = makeCtx()
    expect(await applyTemplates(requestOnly(ctx), "${$$$bad}")).toBe("${$$$bad}")
  })

  it("handles mixed {{key}} and ${expr} in same string", async () => {
    const ctx = makeCtx({ method: "GET", query: { name: "Alice" } })
    expect(await applyTemplates(requestOnly(ctx), "{{request.method}} to ${$uppercase(request.query.name)}"))
      .toBe("GET to ALICE")
  })
})

describe("templates with callbacks", () => {
  const cart: CallbackResult = {
    ok: true,
    status: 200,
    headers: { "content-type": "application/json" },
    body: { items: [{ sku: "a" }, { sku: "b" }], total: 42 },
    durationMs: 4
  }
  const price: CallbackResult = { ok: false, error: "timed out after 2000 ms", durationMs: 2000 }
  const tctx: TemplateContext = { request: makeCtx(), callbacks: { cart, price } }

  it("resolves callbacks.<name>.* beside request.*", () => {
    const key = (k: string) => resolveTemplateKey(tctx, k)
    expect(key("request.method")).toBe("GET")
    expect(key("callbacks.cart.status")).toBe("200")
    expect(key("callbacks.cart.ok")).toBe("true")
    expect(key("callbacks.cart.body.total")).toBe("42")
    expect(key("callbacks.cart.body.items.1.sku")).toBe("b")
    expect(key("callbacks.cart.body.items")).toBe("[{\"sku\":\"a\"},{\"sku\":\"b\"}]")
    expect(key("callbacks.cart.headers.content-type")).toBe("application/json")
    expect(key("callbacks.price.error")).toBe("timed out after 2000 ms")
    expect(key("callbacks.price.status")).toBeUndefined()
    expect(key("callbacks")).toBeUndefined()
  })

  it("resolves no callbacks key when there are none", () => {
    expect(resolveTemplateKey(requestOnly(makeCtx()), "callbacks.cart.status")).toBeUndefined()
  })

  it("{{callbacks.x}} substitutes text; ${callbacks.x} keeps the type", async () => {
    expect(await applyTemplates(tctx, "status {{callbacks.cart.status}}")).toBe("status 200")
    expect(await applyTemplates(tctx, "${callbacks.cart.body.items}")).toEqual([{ sku: "a" }, { sku: "b" }])
    expect(await applyTemplates(tctx, "${callbacks.cart.body.total * 2}")).toBe(84)
  })

  it("a failed call's missing fields stay raw, and ok lets a template branch", async () => {
    expect(await applyTemplates(tctx, "${callbacks.price.body.total}")).toBe("${callbacks.price.body.total}")
    expect(await applyTemplates(tctx, "{{callbacks.price.body.total}}")).toBe("{{callbacks.price.body.total}}")
    expect(await applyTemplates(tctx, "${callbacks.price.ok ? 'priced' : 'unpriced: ' & callbacks.price.error}"))
      .toBe("unpriced: timed out after 2000 ms")
  })

  it("without callbacks, a template naming them renders as it always has", async () => {
    const plain = requestOnly(makeCtx())
    expect(await applyTemplates(plain, "{{callbacks.cart.status}}")).toBe("{{callbacks.cart.status}}")
    expect(await applyTemplates(plain, "${callbacks.cart.status}")).toBe("${callbacks.cart.status}")
  })
})

describe("current stubs render byte-identically", () => {
  // Responses written before callbacks existed: a request-only context must give the same bytes
  const responses = [
    { status: 200, body: "plain {{request.path}}" },
    { status: 201, headers: { "x-who": "{{request.query.name}}" }, body: { echo: "${request.query}", n: 1 } },
    { status: 200, body: { list: ["{{request.method}}", "${$count(request.query)}"], missing: "{{nope}}" } },
    { status: 204, headers: { "x-a": "${request.method & '!'}" } },
    { status: 200, headers: { "content-type": "text/csv" }, body: "a,b\n${request.path}" }
  ]

  it.each(responses)("%j", async (raw) => {
    const config = Schema.decodeUnknownSync(ResponseConfig)(raw)
    const ctx = makeCtx({ method: "POST", path: "/orders/7", query: { name: "Al" } })
    const a = await buildResponse(config, requestOnly(ctx))
    // The callbacks key, when present but empty, must not change anything either
    const b = await buildResponse(config, { request: ctx, callbacks: {} })
    expect(a.status).toBe(b.status)
    expect([...a.headers]).toEqual([...b.headers])
    expect(await a.text()).toBe(await b.text())
  })

  it("matches the bytes rendered before the change", async () => {
    const config = Schema.decodeUnknownSync(ResponseConfig)(responses[1])
    const response = await buildResponse(config, requestOnly(makeCtx({ query: { name: "Al" } })))
    expect(response.headers.get("x-who")).toBe("Al")
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(await response.text()).toBe(`{"echo":{"name":"Al"},"n":1}`)
  })
})
