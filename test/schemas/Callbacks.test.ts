import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { stubIssueMessages } from "imposters/schemas/IssueMessages"
import { CreateStubRequest, ResponseConfig } from "imposters/schemas/StubSchema"
import { describe, expect, it } from "vitest"

const decodeResponse = Schema.decodeUnknownSync(ResponseConfig)
const decodeStub = Schema.decodeUnknownExit(CreateStubRequest, { errors: "all" })

// The plain-English messages for a stub whose first response has these callbacks
const messagesFor = (callbacks: unknown): ReadonlyArray<string> => {
  const input = { responses: [{ status: 200, callbacks }] }
  const exit = decodeStub(input)
  if (Exit.isSuccess(exit)) throw new Error("expected the schema to refuse it")
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
  if (!Schema.isSchemaError(error)) throw new Error("expected a SchemaError")
  return stubIssueMessages(error, input).map((m) => m.message)
}

const call = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  url: "http://127.0.0.1:3002/x",
  ...extra
})

describe("ResponseConfig.callbacks", () => {
  it("is absent unless given, so existing responses decode as before", () => {
    expect(decodeResponse({ status: 200 })).toEqual({ status: 200 })
  })

  it("fills the defaults: GET, 5 s, continue, sequential, empty lists", () => {
    const decoded = decodeResponse({ callbacks: { before: [call("cart")] } })
    expect(decoded.callbacks).toEqual({
      before: [{ name: "cart", method: "GET", url: "http://127.0.0.1:3002/x", timeout: 5000, onError: "continue" }],
      after: [],
      parallel: false
    })
  })

  it("an after callback has no onError", () => {
    const decoded = decodeResponse({ callbacks: { after: [call("notify", { method: "POST", body: { a: 1 } })] } })
    expect(decoded.callbacks?.after[0]).toEqual({
      name: "notify",
      method: "POST",
      url: "http://127.0.0.1:3002/x",
      body: { a: 1 },
      timeout: 5000
    })
  })

  it("accepts templated urls, headers and bodies after a literal scheme", () => {
    const decoded = decodeResponse({
      callbacks: {
        before: [call("cart", {
          url: "https://{{request.headers.host}}/carts/{{request.query.id}}",
          method: "PUT",
          headers: { authorization: "Bearer ${request.headers.token}" },
          body: "{{request.body}}",
          onError: "fail",
          timeout: 100
        })]
      }
    })
    expect(decoded.callbacks?.before[0]?.onError).toBe("fail")
  })

  it("accepts exactly 10 callbacks", () => {
    const before = Array.from({ length: 6 }, (_, i) => call(`b${i}`))
    const after = Array.from({ length: 4 }, (_, i) => call(`a${i}`))
    expect(decodeResponse({ callbacks: { before, after } }).callbacks?.before).toHaveLength(6)
  })
})

describe("callback schema messages", () => {
  it("a missing name", () => {
    expect(messagesFor({ before: [{ url: "http://x" }] })).toEqual([
      "responses[0].callbacks.before[0].name is missing: every callback needs a name, letters, digits and _ (no hyphens), starting with a letter or _, up to 64 characters, like \"cart\""
    ])
  })

  it("a name with a hyphen, or one too long", () => {
    expect(messagesFor({ before: [call("my-call"), call(`a${"b".repeat(64)}`)] })).toEqual([
      "responses[0].callbacks.before[0].name must be letters, digits and _ (no hyphens), starting with a letter or _, up to 64 characters, like \"cart\", not \"my-call\"",
      `responses[0].callbacks.before[1].name must be letters, digits and _ (no hyphens), starting with a letter or _, up to 64 characters, like "cart", not "a${
        "b".repeat(37)
      }…`
    ])
  })

  it("a name used twice, across phases too", () => {
    expect(messagesFor({ before: [call("cart"), call("cart")], after: [call("cart")] })).toEqual([
      "responses[0].callbacks.before[1].name \"cart\" is already used by another callback of this response: names must be unique",
      "responses[0].callbacks.after[0].name \"cart\" is already used by another callback of this response: names must be unique"
    ])
  })

  it("a url without a literal http:// or https://", () => {
    expect(messagesFor({ before: [call("a"), call("b", { url: "{{request.query.target}}" })] })).toEqual([
      "responses[0].callbacks.before[1].url must start with http:// or https://, not \"{{request.query.target}}\""
    ])
    expect(messagesFor({ after: [call("a", { url: "ftp://host/file" })] })).toEqual([
      "responses[0].callbacks.after[0].url must start with http:// or https://, not \"ftp://host/file\""
    ])
  })

  it("a body on a GET or a HEAD", () => {
    expect(messagesFor({ before: [call("a", { body: { x: 1 } })], after: [call("b", { method: "HEAD", body: "x" })] }))
      .toEqual([
        "responses[0].callbacks.before[0].body: a GET callback cannot send a body (use POST, PUT or PATCH to send one)",
        "responses[0].callbacks.after[0].body: a HEAD callback cannot send a body (use POST, PUT or PATCH to send one)"
      ])
  })

  it("more than 10 callbacks", () => {
    const before = Array.from({ length: 6 }, (_, i) => call(`b${i}`))
    const after = Array.from({ length: 5 }, (_, i) => call(`a${i}`))
    expect(messagesFor({ before, after })).toEqual([
      "responses[0].callbacks: a response makes at most 10 callbacks, before and after together, not 11"
    ])
  })

  it("onError on an after callback, and a bad one on a before callback", () => {
    expect(messagesFor({ before: [call("a", { onError: "retry" })], after: [call("b", { onError: "fail" })] }))
      .toEqual([
        "responses[0].callbacks.before[0].onError must be continue or fail, not \"retry\"",
        "responses[0].callbacks.after[0].onError: onError is for before callbacks only, since an after callback cannot change an answer already sent"
      ])
  })

  it("a bad method, timeout and parallel", () => {
    expect(messagesFor({ parallel: "yes", before: [call("a", { method: "FETCH", timeout: 50 })] })).toEqual([
      "responses[0].callbacks.before[0].method must be one of GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS, not \"FETCH\"",
      "responses[0].callbacks.before[0].timeout must be a whole number of milliseconds from 100 to 60000, like 2000, not 50",
      "responses[0].callbacks.parallel must be true or false, not \"yes\""
    ])
  })

  it("callbacks that are not an object, and a phase that is not a list", () => {
    expect(messagesFor([])).toEqual([
      "responses[0].callbacks must be an object with before and after lists (at most 10 callbacks in all), like { \"after\": [{ \"name\": \"notify\", \"method\": \"POST\", \"url\": \"http://127.0.0.1:3004/events\" }] }, not []"
    ])
    expect(messagesFor({ after: {} })).toEqual([
      "responses[0].callbacks.after must be a list of callbacks, like [{ \"name\": \"notify\", \"method\": \"POST\", \"url\": \"http://127.0.0.1:3004/events\" }], not {}"
    ])
  })
})
