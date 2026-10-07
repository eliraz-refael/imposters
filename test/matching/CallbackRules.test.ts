import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import {
  answered,
  checkCallbackUrl,
  decodeBody,
  failed,
  failResponse,
  pendingRecord,
  RECORD_BODY_BYTES,
  recordOf,
  recordText,
  resultOf,
  skipped,
  stopReason,
  verdictOf
} from "imposters/matching/CallbackRules"
import {
  DEFAULT_MAX_HOPS,
  isLoopAnswer,
  loopResponse,
  mayCallOut,
  nextHop,
  parseHop,
  resolveMaxHops
} from "imposters/matching/Hops"
import { AfterCallback, BeforeCallback } from "imposters/schemas/StubSchema"
import { describe, expect, it } from "vitest"

const before = (extra: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(BeforeCallback)({ name: "price", url: "http://127.0.0.1:3003/quote", ...extra })
const after = Schema.decodeUnknownSync(AfterCallback)({ name: "notify", method: "POST", url: "http://h/e" })
const text = (s: string) => new TextEncoder().encode(s)
const json = { "content-type": "application/json" }

describe("checkCallbackUrl", () => {
  it("accepts a templated http or https url", () => {
    expect(Result.getOrThrow(checkCallbackUrl("http://127.0.0.1:3002/carts/7")).host).toBe("127.0.0.1:3002")
    expect(Result.isSuccess(checkCallbackUrl("https://example.test/x?y=1"))).toBe(true)
  })

  it("refuses what is left half-templated, does not parse, or is not http(s)", () => {
    expect(checkCallbackUrl("http://{{request.query.host}}/x")).toEqual(
      Result.fail("the url still holds a template after templating: \"http://{{request.query.host}}/x\"")
    )
    expect(checkCallbackUrl("http://h/${callbacks.a.body.id}")).toEqual(
      Result.fail("the url still holds a template after templating: \"http://h/${callbacks.a.body.id}\"")
    )
    expect(checkCallbackUrl("http://")).toEqual(Result.fail("invalid url: \"http://\""))
    expect(checkCallbackUrl("file:///etc/passwd")).toEqual(
      Result.fail("the url must use http or https: \"file:///etc/passwd\"")
    )
    expect(checkCallbackUrl(42)).toEqual(Result.fail("the url template did not give text"))
  })
})

describe("decodeBody and resultOf", () => {
  it("JSON when declared and valid, else text, else absent", () => {
    expect(decodeBody("application/json; charset=utf-8", text("{\"a\":1}"))).toEqual({ a: 1 })
    expect(decodeBody("application/problem+json", text("[1]"))).toEqual([1])
    expect(decodeBody("application/json", text("not json"))).toBe("not json")
    expect(decodeBody("text/plain", text("{\"a\":1}"))).toBe("{\"a\":1}")
    expect(decodeBody(undefined, new Uint8Array([0xff, 0xfe, 0x00]))).toBeUndefined()
    expect(decodeBody("application/json", new Uint8Array(0))).toBeUndefined()
  })

  it("an answer: ok for 2xx only, with status, headers, body and duration", () => {
    expect(resultOf(answered(200, json, text("{\"items\":[]}"), 4))).toEqual({
      ok: true,
      status: 200,
      headers: json,
      body: { items: [] },
      durationMs: 4
    })
    expect(resultOf(answered(404, {}, new Uint8Array(0), 2))).toEqual({
      ok: false,
      status: 404,
      headers: {},
      durationMs: 2
    })
  })

  it("no answer: an error, no status", () => {
    expect(resultOf(failed("timed out after 2000 ms", 2000))).toEqual({
      ok: false,
      error: "timed out after 2000 ms",
      durationMs: 2000
    })
    expect(resultOf(skipped("hop limit 8 reached"))).toEqual({ ok: false, error: "hop limit 8 reached", durationMs: 0 })
  })
})

describe("records", () => {
  it("keeps the first 2 KiB of a body as text, marking the cut", () => {
    expect(recordText("short")).toBe("short")
    const long = "x".repeat(RECORD_BODY_BYTES + 10)
    expect(recordText(long)).toBe(`${"x".repeat(RECORD_BODY_BYTES)}…`)
    // A cut inside a two-byte character drops the half
    const accents = "é".repeat(RECORD_BODY_BYTES)
    expect(recordText(accents)).toBe(`${"é".repeat(RECORD_BODY_BYTES / 2)}…`)
    expect(recordText(new Uint8Array([0xff, 0x00]))).toBeUndefined()
    expect(recordText("")).toBeUndefined()
  })

  it("an answered, a failed and a skipped record", () => {
    const callback = before({ method: "POST" })
    expect(recordOf(callback, "before", "http://h/q", answered(201, json, text("{\"t\":1}"), 3), "{\"cart\":7}"))
      .toEqual({
        name: "price",
        phase: "before",
        method: "POST",
        url: "http://h/q",
        state: "answered",
        status: 201,
        durationMs: 3,
        requestBody: "{\"cart\":7}",
        responseBody: "{\"t\":1}"
      })
    expect(recordOf(callback, "before", "http://h/q", failed("connection failed: refused", 1))).toEqual({
      name: "price",
      phase: "before",
      method: "POST",
      url: "http://h/q",
      state: "failed",
      error: "connection failed: refused",
      durationMs: 1
    })
    expect(recordOf(after, "after", "http://h/e", skipped("hop limit 8 reached"))).toMatchObject({
      state: "skipped",
      error: "hop limit 8 reached"
    })
  })

  it("an after call is logged pending with its url template", () => {
    expect(pendingRecord(after)).toEqual({
      name: "notify",
      phase: "after",
      method: "POST",
      url: "http://h/e",
      state: "pending"
    })
  })
})

describe("the failure policy", () => {
  const loopHeaders = { "x-imposters-loop": "8" }

  it("continue (the default): every outcome is data, except a detected loop", () => {
    const callback = before()
    expect(verdictOf(callback, answered(503, {}, new Uint8Array(0), 1))._tag).toBe("Continue")
    expect(verdictOf(callback, failed("timed out after 5000 ms", 5000))._tag).toBe("Continue")
    expect(verdictOf(callback, answered(508, loopHeaders, new Uint8Array(0), 1))).toEqual({
      _tag: "Loop",
      callback: "price"
    })
  })

  it("fail: a 5xx or no response is a 502; 2xx–4xx is data", () => {
    const callback = before({ onError: "fail" })
    expect(verdictOf(callback, answered(404, {}, new Uint8Array(0), 1))._tag).toBe("Continue")
    expect(verdictOf(callback, answered(500, {}, new Uint8Array(0), 1))).toEqual({
      _tag: "Fail",
      callback: "price",
      status: 500
    })
    expect(verdictOf(callback, failed("connection failed: refused", 1))).toEqual({
      _tag: "Fail",
      callback: "price",
      reason: "connection failed: refused"
    })
    expect(verdictOf(callback, answered(508, loopHeaders, new Uint8Array(0), 1))._tag).toBe("Loop")
  })

  it("a stub's own 508 (no loop header) is ordinary data", () => {
    expect(isLoopAnswer(508, {})).toBe(false)
    expect(verdictOf(before(), answered(508, {}, new Uint8Array(0), 1))._tag).toBe("Continue")
  })

  it("the 502 body, and why the rest were not sent", async () => {
    const response = failResponse({ _tag: "Fail", callback: "price", reason: "timed out after 2000 ms" })
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: "Callback failed",
      callback: "price",
      reason: "timed out after 2000 ms"
    })
    expect(stopReason({ _tag: "Fail", callback: "price", status: 503 })).toBe("not sent: callback \"price\" failed")
    expect(stopReason({ _tag: "Loop", callback: "cart" })).toBe("not sent: callback \"cart\" detected a loop")
  })
})

describe("hops", () => {
  it("parses the incoming hop: absent or malformed is 0", () => {
    expect(parseHop(undefined)).toBe(0)
    expect(parseHop("3")).toBe(3)
    expect(parseHop(" 7 ")).toBe(7)
    expect(parseHop("-1")).toBe(0)
    expect(parseHop("2.5")).toBe(0)
    expect(parseHop("abc")).toBe(0)
    expect(nextHop(0)).toBe(1)
  })

  it("may call out below the limit only", () => {
    expect(mayCallOut(7, 8)).toBe(true)
    expect(mayCallOut(8, 8)).toBe(false)
  })

  it("the 508 carries the loop header and says where", async () => {
    const response = loopResponse(8, 8)
    expect(response.status).toBe(508)
    expect(response.headers.get("x-imposters-loop")).toBe("8")
    expect(await response.json()).toEqual({ error: "Loop detected", hop: 8, limit: 8 })
  })

  it("resolves --max-hops, then IMPOSTERS_MAX_HOPS, then the default", () => {
    expect(resolveMaxHops(undefined, undefined)).toEqual({ ok: true, value: DEFAULT_MAX_HOPS })
    expect(resolveMaxHops(undefined, " 3 ")).toEqual({ ok: true, value: 3 })
    expect(resolveMaxHops(5, "3")).toEqual({ ok: true, value: 5 })
    expect(resolveMaxHops(0, undefined)).toEqual({
      ok: false,
      error: "--max-hops must be a whole number from 1 to 100, not 0"
    })
    expect(resolveMaxHops(undefined, "lots")).toEqual({
      ok: false,
      error: "IMPOSTERS_MAX_HOPS must be a whole number from 1 to 100, not \"lots\""
    })
  })
})
