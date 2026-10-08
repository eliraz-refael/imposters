import { it } from "@effect/vitest"
import { Clock, Effect, Fiber, Layer } from "effect"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import { type BeforePhase, type CallbackRun, makeInFlight, runAfter, runBefore } from "imposters/matching/Callbacks"
import type { RequestContext } from "imposters/matching/RequestMatcher"
import type { CallbackRecord } from "imposters/schemas/RequestLogSchema"
import { Callbacks } from "imposters/schemas/StubSchema"
import type { OutboundSample } from "imposters/services/OutboundEdges"
import { OutboundError, OutboundHttp, type OutboundRequest } from "imposters/services/OutboundHttp"
import { describe, expect } from "vitest"

// Callbacks.ts against a fake OutboundHttp: each exchange is answered by `answer` after a
// virtual wait, so timeouts and parallel timing run on the TestClock.

interface Sent {
  readonly url: string
  readonly method: string
  readonly hop: string | null
  readonly xq: string | null
  readonly body?: string
  readonly at: number
}

interface Fake {
  readonly sent: Array<Sent>
  readonly samples: Array<OutboundSample>
  readonly layer: Layer.Layer<OutboundHttp>
}

type Answer = { readonly after: number; readonly response: () => Response }

const fake = (answer: (request: OutboundRequest) => Answer, maxHops = 8): Fake => {
  const sent: Array<Sent> = []
  const samples: Array<OutboundSample> = []
  const layer = Layer.succeed(OutboundHttp)({
    maxHops,
    exchange: (request, read) =>
      Effect.gen(function*() {
        const { after, response } = answer(request)
        const at = yield* Clock.currentTimeMillis
        sent.push({
          url: request.url.href,
          method: request.method,
          hop: request.headers.get("x-imposters-hop"),
          xq: request.headers.get("x-q"),
          ...(typeof request.body === "string" ? { body: request.body } : {}),
          at
        })
        yield* Effect.sleep(after)
        const read_ = yield* Effect.promise(() => read(response()))
        // As the live exchange does: a read that refuses the answer is an OutboundError
        if (read_._tag === "Failure") {
          return yield* Effect.fail(new OutboundError({ kind: "read", reason: read_.failure }))
        }
        return read_.success
      }),
    record: (_imposterId, sample) => Effect.sync(() => void samples.push(sample))
  })
  return { sent, samples, layer }
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

const request: RequestContext = {
  method: "GET",
  path: "/checkout",
  headers: {},
  query: { cart: "7" },
  body: undefined,
  rawBody: new Uint8Array(0)
}

const callbacks = (input: unknown) => Schema.decodeUnknownSync(Callbacks)(input)

const makeRun = (hop = 0, cap?: number) =>
  makeInFlight(cap).pipe(Effect.map((inFlight): CallbackRun => ({ imposterId: "imp", hop, inFlight })))

// Runs the before phase on the TestClock, advancing it by `ms`
const before = (f: Fake, input: unknown, ms: number, hop = 0, cap?: number) =>
  Effect.gen(function*() {
    const run = yield* makeRun(hop, cap)
    const fiber = yield* Effect.forkChild(runBefore(callbacks(input), request, run).pipe(Effect.provide(f.layer)), {
      startImmediately: true
    })
    yield* TestClock.adjust(ms)
    return yield* Fiber.join(fiber)
  })

const continued = (phase: BeforePhase) => {
  if (phase._tag !== "Continue") throw new Error(`expected Continue, got ${phase._tag}`)
  return phase
}
const stopped = (phase: BeforePhase) => {
  if (phase._tag !== "Stop") throw new Error("expected Stop")
  return phase
}

describe("runBefore", () => {
  it.effect("sequential: each call sees the ones before it, and sends the next hop", () =>
    Effect.gen(function*() {
      const f = fake((r) =>
        r.url.pathname === "/token"
          ? { after: 10, response: jsonResponse({ access_token: "t-1" }) }
          : { after: 20, response: jsonResponse({ items: [1, 2] }) }
      )
      const phase = continued(
        yield* before(
          f,
          {
            before: [
              { name: "token", method: "POST", url: "http://auth/token", body: { cart: "{{request.query.cart}}" } },
              { name: "cart", url: "http://carts/carts/{{request.query.cart}}?t=${callbacks.token.body.access_token}" }
            ]
          },
          30,
          2
        )
      )
      expect(f.sent.map((s) => [s.url, s.hop, s.at])).toEqual([
        ["http://auth/token", "3", 0],
        ["http://carts/carts/7?t=t-1", "3", 10]
      ])
      expect(f.sent[0]?.body).toBe("{\"cart\":\"7\"}")
      expect(phase.results.cart).toMatchObject({ ok: true, status: 200, body: { items: [1, 2] }, durationMs: 20 })
      expect(phase.records.map((r) => [r.name, r.state, r.durationMs])).toEqual([["token", "answered", 10], [
        "cart",
        "answered",
        20
      ]])
      expect(f.samples.map((s) => [s.host, s.via, s.status])).toEqual([["auth", "callback", 200], [
        "carts",
        "callback",
        200
      ]])
    }))

  it.effect("parallel: the calls overlap, and each sees only the request", () =>
    Effect.gen(function*() {
      const f = fake(() => ({ after: 100, response: jsonResponse({ ok: 1 }) }))
      const phase = continued(
        yield* before(f, {
          parallel: true,
          before: [
            { name: "a", url: "http://a/x" },
            { name: "b", url: "http://b/x" },
            { name: "c", url: "http://c/${callbacks.a.status}" }
          ]
        }, 100)
      )
      // Both started at once and both ended after 100 ms: in sequence they would take 200
      expect(f.sent.map((s) => [s.url, s.at])).toEqual([["http://a/x", 0], ["http://b/x", 0]])
      expect([phase.results.a?.durationMs, phase.results.b?.durationMs]).toEqual([100, 100])
      // `c` could not see `a`, so its url kept the expression and was refused without sending
      expect(phase.results.c?.error).toContain("still holds a template")
    }))

  it.effect("a timeout is an error result after exactly the timeout, and a failed edge", () =>
    Effect.gen(function*() {
      const f = fake(() => ({ after: 60_000, response: jsonResponse({}) }))
      const phase = continued(yield* before(f, { before: [{ name: "price", url: "http://p/q", timeout: 2000 }] }, 2000))
      expect(phase.results.price).toEqual({ ok: false, error: "timed out after 2000 ms", durationMs: 2000 })
      expect(f.samples).toEqual([{ host: "p", via: "callback", atMs: 0, durationMs: 2000 }])
    }))

  it.effect("onError fail: a 5xx answers 502, and the rest are skipped", () =>
    Effect.gen(function*() {
      const f = fake(() => ({ after: 5, response: jsonResponse({ e: 1 }, 503) }))
      const phase = stopped(
        yield* before(f, {
          before: [{ name: "price", url: "http://p/q", onError: "fail" }, { name: "cart", url: "http://c/x" }]
        }, 5)
      )
      expect(phase.response.status).toBe(502)
      expect(yield* Effect.promise(() => phase.response.json())).toEqual({
        error: "Callback failed",
        callback: "price",
        status: 503
      })
      expect(phase.records.map((r) => [r.name, r.state, r.error])).toEqual([
        ["price", "answered", undefined],
        ["cart", "skipped", "not sent: callback \"price\" failed"]
      ])
      expect(phase.reason).toBe("not sent: callback \"price\" failed")
      expect(f.sent).toHaveLength(1)
    }))

  it.effect("parallel with onError fail: the first failure interrupts its siblings", () =>
    Effect.gen(function*() {
      const f = fake((r) =>
        r.url.host === "fast"
          ? { after: 10, response: jsonResponse({}, 500) }
          : { after: 1000, response: jsonResponse({}) }
      )
      const phase = stopped(
        yield* before(f, {
          parallel: true,
          before: [{ name: "slow", url: "http://slow/x" }, { name: "fast", url: "http://fast/x", onError: "fail" }]
        }, 10)
      )
      expect(phase.response.status).toBe(502)
      expect(phase.records.map((r) => [r.name, r.state, r.error])).toEqual([
        ["slow", "failed", "interrupted: callback \"fast\" failed"],
        ["fast", "answered", undefined]
      ])
    }))

  it.effect("a 508 with the loop header becomes this response's 508, whatever onError says", () =>
    Effect.gen(function*() {
      const f = fake(() => ({ after: 1, response: jsonResponse({}, 508, { "x-imposters-loop": "8" }) }))
      const phase = stopped(yield* before(f, { before: [{ name: "self", url: "http://me/x" }] }, 1, 3))
      expect(phase.response.status).toBe(508)
      expect(phase.response.headers.get("x-imposters-loop")).toBe("8")
      expect(yield* Effect.promise(() => phase.response.json())).toEqual({ error: "Loop detected", hop: 3, limit: 8 })
    }))

  it.effect("at the hop limit nothing is sent: 508, every record skipped", () =>
    Effect.gen(function*() {
      const f = fake(() => ({ after: 1, response: jsonResponse({}) }), 4)
      const phase = stopped(yield* before(f, { before: [{ name: "a", url: "http://a/x" }] }, 0, 4))
      expect(phase.response.status).toBe(508)
      expect(phase.records).toEqual([{
        name: "a",
        phase: "before",
        method: "GET",
        url: "http://a/x",
        state: "skipped",
        error: "hop limit 4 reached"
      }])
      expect(f.sent).toEqual([])
    }))

  it.effect("over the in-flight cap a call fails at once, and never queues", () =>
    Effect.gen(function*() {
      const f = fake(() => ({ after: 50, response: jsonResponse({}) }))
      const phase = continued(
        yield* before(
          f,
          { parallel: true, before: [{ name: "a", url: "http://a/x" }, { name: "b", url: "http://b/x" }] },
          50,
          0,
          1
        )
      )
      expect(phase.results.a?.ok).toBe(true)
      expect(phase.results.b).toEqual({ ok: false, error: "too many callbacks in flight", durationMs: 0 })
      expect(f.samples.map((s) => [s.host, s.status])).toEqual([["b", undefined], ["a", 200]])
    }))

  it.effect("a body over 1 MiB is a failure", () =>
    Effect.gen(function*() {
      const big = () =>
        new Response(new Uint8Array(1_048_577), { headers: { "content-type": "application/octet-stream" } })
      const f = fake(() => ({ after: 1, response: big }))
      const phase = continued(yield* before(f, { before: [{ name: "a", url: "http://a/x" }] }, 1))
      expect(phase.results.a).toEqual({ ok: false, error: "response body over 1 MiB", durationMs: 1 })
      expect(phase.records[0]).toMatchObject({ state: "failed", error: "response body over 1 MiB" })
    }))
})

describe("runAfter", () => {
  it.effect("runs in order, each settled as it ends, seeing the before results", () =>
    Effect.gen(function*() {
      const f = fake(() => ({ after: 10, response: jsonResponse({ got: true }, 202) }))
      const settled: Array<CallbackRecord> = []
      const run = yield* makeRun(1)
      const list = callbacks({
        after: [
          { name: "notify", method: "POST", url: "http://hooks/e", body: { total: "${callbacks.price.body.total}" } },
          { name: "audit", url: "http://audit/a" }
        ]
      }).after
      const fiber = yield* Effect.forkChild(
        runAfter(
          list,
          {
            request,
            callbacks: { price: { ok: true, status: 200, body: { total: 42 }, durationMs: 1 } }
          },
          run,
          (r) => Effect.sync(() => void settled.push(r))
        ).pipe(Effect.provide(f.layer)),
        { startImmediately: true }
      )
      yield* TestClock.adjust(10)
      expect(settled.map((r) => r.name)).toEqual(["notify"])
      yield* TestClock.adjust(10)
      yield* Fiber.join(fiber)
      expect(settled.map((r) => [r.name, r.state, r.status, r.requestBody])).toEqual([
        ["notify", "answered", 202, "{\"total\":42}"],
        ["audit", "answered", 202, undefined]
      ])
      expect(f.sent.map((s) => s.hop)).toEqual(["2", "2"])
    }))

  it.effect("past the hop limit each is skipped, and records no outbound edge", () =>
    Effect.gen(function*() {
      const f = fake(() => ({ after: 1, response: jsonResponse({}) }), 2)
      const settled: Array<CallbackRecord> = []
      const run = yield* makeRun(2)
      yield* runAfter(callbacks({ after: [{ name: "n", url: "http://h/e" }] }).after, { request }, run, (r) =>
        Effect.sync(() =>
          void settled.push(r)
        )).pipe(Effect.provide(f.layer))
      expect(settled).toEqual([{
        name: "n",
        phase: "after",
        method: "GET",
        url: "http://h/e",
        state: "skipped",
        error: "hop limit 2 reached"
      }])
      expect(f.sent).toEqual([])
      expect(f.samples).toEqual([])
    }))

  it.effect("past the hop limit with no slot free, it is still skipped, not a failed call", () =>
    Effect.gen(function*() {
      const f = fake(() => ({ after: 1, response: jsonResponse({}) }), 2)
      const settled: Array<CallbackRecord> = []
      const run = yield* makeRun(2, 0)
      yield* runAfter(
        callbacks({ after: [{ name: "n", url: "http://h/e" }] }).after,
        { request },
        run,
        (r) => Effect.sync(() => void settled.push(r))
      ).pipe(Effect.provide(f.layer))
      expect(settled.map((r) => [r.state, r.error])).toEqual([["skipped", "hop limit 2 reached"]])
      expect(f.samples).toEqual([])
    }))

  it.effect("a header fetch cannot send fails that call, and the next one still runs", () =>
    Effect.gen(function*() {
      const f = fake(() => ({ after: 1, response: jsonResponse({}) }))
      const settled: Array<CallbackRecord> = []
      const run = yield* makeRun()
      const list = callbacks({
        after: [
          { name: "bad", url: "http://h/a", headers: { "not a header": "x" } },
          { name: "good", url: "http://h/b" }
        ]
      }).after
      const fiber = yield* Effect.forkChild(
        runAfter(list, { request }, run, (r) => Effect.sync(() => void settled.push(r))).pipe(
          Effect.provide(f.layer)
        ),
        { startImmediately: true }
      )
      yield* TestClock.adjust(1)
      yield* Fiber.join(fiber)
      expect(settled.map((r) => [r.name, r.state])).toEqual([["bad", "failed"], ["good", "answered"]])
      expect(settled[0]?.error).toContain("invalid headers")
      expect(f.sent.map((s) => s.url)).toEqual(["http://h/b"])
    }))
})

describe("a url template that throws", () => {
  // A JSON answer nested deeper than the stack: stringifying it (as `{{callbacks.deep.body}}`
  // must) throws a RangeError
  const DEPTH = 100_000
  const deepJson = () =>
    new Response(`${"{\"a\":".repeat(DEPTH)}1${"}".repeat(DEPTH)}`, { headers: { "content-type": "application/json" } })

  it.effect("before: fails that call only; the others are still recorded, and the phase does not die", () =>
    Effect.gen(function*() {
      const f = fake((r) => ({ after: 1, response: r.url.host === "deep" ? deepJson : jsonResponse({ ok: 1 }) }))
      const phase = continued(
        yield* before(f, {
          before: [
            { name: "deep", url: "http://deep/x" },
            { name: "uses", url: "http://h/{{callbacks.deep.body}}" },
            { name: "after_it", url: "http://h/plain" }
          ]
        }, 10)
      )
      expect(phase.records.map((r) => r.name)).toEqual(["deep", "uses", "after_it"])
      expect(phase.records[0]?.state).toBe("answered")
      expect(phase.records[1]).toMatchObject({ state: "failed", url: "http://h/{{callbacks.deep.body}}" })
      expect(phase.records[1]?.error).toMatch(/^the url template failed: /)
      expect(phase.records.every((r) => r.state !== "pending")).toBe(true)
    }))

  it.effect("after: every record settles, none is left pending", () =>
    Effect.gen(function*() {
      const f = fake(() => ({ after: 1, response: jsonResponse({}) }))
      const deep = yield* Effect.promise(() => deepJson().json())
      const settled: Array<CallbackRecord> = []
      const run = yield* makeRun()
      const list = callbacks({
        after: [{ name: "uses", url: "http://h/{{callbacks.deep.body}}" }, { name: "next", url: "http://h/plain" }]
      }).after
      const fiber = yield* Effect.forkChild(
        runAfter(
          list,
          { request, callbacks: { deep: { ok: true, status: 200, body: deep, durationMs: 1 } } },
          run,
          (r) => Effect.sync(() => void settled.push(r))
        ).pipe(Effect.provide(f.layer)),
        { startImmediately: true }
      )
      yield* TestClock.adjust(10)
      yield* Fiber.join(fiber)
      expect(settled.map((r) => r.name)).toEqual(["uses", "next"])
      expect(settled[0]?.error).toMatch(/^the url template failed: /)
      expect(settled.every((r) => r.state !== "pending")).toBe(true)
    }))
})

describe("a request value in a callback is never evaluated", () => {
  // A client sends `${…}` in a query value that a callback's url, header or body echoes
  const tctx = {
    request: { ...request, query: { q: "${callbacks.token.body.token}" } },
    callbacks: { token: { ok: true, status: 200, body: { token: "s3cret" }, durationMs: 1 } }
  }
  const after = (input: unknown) =>
    Effect.gen(function*() {
      const f = fake(() => ({ after: 1, response: jsonResponse({}) }))
      const settled: Array<CallbackRecord> = []
      const run = yield* makeRun()
      const fiber = yield* Effect.forkChild(
        runAfter(callbacks(input).after, tctx, run, (r) => Effect.sync(() => void settled.push(r))).pipe(
          Effect.provide(f.layer)
        ),
        { startImmediately: true }
      )
      yield* TestClock.adjust(10)
      yield* Fiber.join(fiber)
      return { f, settled }
    })

  it.effect("in a header and a body, it is sent as written", () =>
    Effect.gen(function*() {
      const { f } = yield* after({
        after: [{
          name: "n",
          method: "POST",
          url: "http://h/e",
          headers: { "x-q": "{{request.query.q}}" },
          body: { q: "{{request.query.q}}", whole: "{{request.query.q}}!" }
        }]
      })
      expect(f.sent.map((s) => [s.xq, s.body])).toEqual([[
        "${callbacks.token.body.token}",
        "{\"q\":\"${callbacks.token.body.token}\",\"whole\":\"${callbacks.token.body.token}!\"}"
      ]])
    }))

  it.effect("in a url, it is refused as still holding a template, and nothing is sent", () =>
    Effect.gen(function*() {
      const { f, settled } = yield* after({ after: [{ name: "n", url: "http://h/e?q={{request.query.q}}" }] })
      expect(f.sent).toEqual([])
      expect(settled[0]).toMatchObject({ state: "failed", url: "http://h/e?q=${callbacks.token.body.token}" })
      expect(settled[0]?.error).toContain("still holds a template")
    }))
})
