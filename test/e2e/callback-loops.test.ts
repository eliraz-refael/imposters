import { HttpRouter } from "effect/unstable/http"
import { makeFullLayer } from "imposters/server/AdminServer"
import * as http from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// Loop protection over real ports: the hop header, the 508 that travels up, the proxy joining
// in, and the in-flight cap. This file owns 8931-8949. The hop limit is the default, 8.

let adminHandler: (request: Request) => Promise<Response>
let dispose: () => void

beforeAll(() => {
  const result = HttpRouter.toWebHandler(makeFullLayer(), { disableLogger: true })
  adminHandler = result.handler
  dispose = result.dispose
})

afterAll(() => {
  dispose()
})

const MAX_HOPS = 8

const admin = (path: string, method = "GET", body?: unknown) =>
  adminHandler(
    new Request(`http://localhost:2525${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    })
  )

interface Logged {
  readonly request: { readonly path: string; readonly headers: Record<string, string> }
  readonly response: { readonly status: number; readonly headers: Record<string, string> }
  readonly callbacks?: ReadonlyArray<
    { readonly name: string; readonly state: string; readonly error?: string; readonly status?: number }
  >
}

const logged = async (id: string): Promise<Array<Logged>> => (await admin(`/imposters/${id}/requests?limit=500`)).json()

const url = (port: number, path = "") => `http://127.0.0.1:${String(port)}${path}`

const hopsOf = (entries: ReadonlyArray<Logged>) =>
  entries.map((e) => Number(e.request.headers["x-imposters-hop"] ?? "0")).sort((a, b) => a - b)

const withImposters = async (
  specs: ReadonlyArray<{
    readonly port: number
    readonly stubs?: ReadonlyArray<Record<string, unknown>>
    readonly proxy?: Record<string, unknown>
  }>,
  body: (ids: ReadonlyArray<string>) => Promise<void>
) => {
  const ids: Array<string> = []
  try {
    for (const spec of specs) {
      const created = await admin("/imposters", "POST", {
        port: spec.port,
        ...(spec.proxy !== undefined ? { proxy: spec.proxy } : {})
      })
      expect(created.status).toBe(201)
      const imp: { id: string } = await created.json()
      ids.push(imp.id)
      for (const stub of spec.stubs ?? []) {
        expect((await admin(`/imposters/${imp.id}/stubs`, "POST", stub)).status).toBe(201)
      }
      await admin(`/imposters/${imp.id}`, "PATCH", { status: "running" })
    }
    await body(ids)
  } finally {
    for (const id of ids) await admin(`/imposters/${id}?force=true`, "DELETE")
  }
}

const eventually = async <A>(read: () => Promise<A>, check: (a: A) => boolean, timeoutMs = 5000): Promise<A> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (check(value) || Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// A promise and the function that resolves it
const signal = () => {
  let done = () => {}
  const promise = new Promise<void>((resolve) => {
    done = resolve
  })
  return { promise, resolve: () => done() }
}

const calling = (target: string, extra: Record<string, unknown> = {}) => ({
  predicates: [{ field: "path", operator: "equals", value: "/loop" }],
  responses: [{ status: 200, callbacks: { before: [{ name: "next", url: target }] }, body: "never", ...extra }]
})

describe("E2E: callback loops", () => {
  it("A calling A answers 508 at the client, with an entry for every hop up to the limit", async () => {
    await withImposters([{ port: 8931, stubs: [calling(url(8931, "/loop"))] }], async ([a = ""]) => {
      const response = await fetch(url(8931, "/loop"))
      expect(response.status).toBe(508)
      expect(response.headers.get("x-imposters-loop")).toBe(String(MAX_HOPS))
      // The outermost answer says where the loop was first seen from: hop 0
      expect(await response.json()).toEqual({ error: "Loop detected", hop: 0, limit: MAX_HOPS })

      const entries = await logged(a)
      expect(entries).toHaveLength(MAX_HOPS + 1)
      expect(hopsOf(entries)).toEqual(Array.from({ length: MAX_HOPS + 1 }, (_, i) => i))
      expect(entries.every((e) => e.response.status === 508)).toBe(true)
      // The deepest refused without calling; every other one saw the 508 come back
      const deepest = entries.find((e) => e.request.headers["x-imposters-hop"] === String(MAX_HOPS))
      expect(deepest?.callbacks).toEqual([expect.objectContaining({ state: "skipped", error: "hop limit 8 reached" })])
      const outer = entries.find((e) => e.request.headers["x-imposters-hop"] === undefined)
      expect(outer?.callbacks).toEqual([expect.objectContaining({ state: "answered", status: 508 })])
    })
  }, 15_000)

  it("A and B calling each other: the loop is seen on both, hop by hop", async () => {
    await withImposters([
      { port: 8932, stubs: [calling(url(8933, "/loop"))] },
      { port: 8933, stubs: [calling(url(8932, "/loop"))] }
    ], async ([a = "", b = ""]) => {
      expect((await fetch(url(8932, "/loop"))).status).toBe(508)
      expect(hopsOf(await logged(a))).toEqual([0, 2, 4, 6, 8])
      expect(hopsOf(await logged(b))).toEqual([1, 3, 5, 7])
    })
  }, 15_000)

  it("a request that needs no outbound call is served at any hop", async () => {
    await withImposters([{
      port: 8934,
      stubs: [{ predicates: [], responses: [{ status: 200, body: "plain" }] }]
    }], async () => {
      const response = await fetch(url(8934, "/x"), { headers: { "x-imposters-hop": "50" } })
      expect(response.status).toBe(200)
    })
  })

  it("a proxy pointed at itself answers 508 instead of recursing", async () => {
    await withImposters([{ port: 8935, proxy: { targetUrl: url(8935) } }], async ([a = ""]) => {
      const response = await fetch(url(8935, "/anything"))
      expect(response.status).toBe(508)
      expect(response.headers.get("x-imposters-loop")).toBe(String(MAX_HOPS))
      const entries = await logged(a)
      expect(hopsOf(entries)).toEqual(Array.from({ length: MAX_HOPS + 1 }, (_, i) => i))
      const stats: { outbound: ReadonlyArray<{ host: string; via: string; calls: number; failed: number }> } =
        await (await admin(`/imposters/${a}/stats`)).json()
      expect(stats.outbound).toEqual([
        // The forwards from hop 0 to 7, each answered 508; the one refused at hop 8 was never sent
        expect.objectContaining({
          host: "127.0.0.1:8935",
          via: "proxy",
          calls: MAX_HOPS,
          failed: 0,
          serverErrors: MAX_HOPS
        })
      ])
    })
  }, 15_000)

  it("an after call to itself ends at the limit, and every answer is sent", async () => {
    const stub = {
      predicates: [],
      responses: [{ status: 200, body: "ok", callbacks: { after: [{ name: "again", url: url(8936, "/again") }] } }]
    }
    await withImposters([{ port: 8936, stubs: [stub] }], async ([a = ""]) => {
      expect((await fetch(url(8936, "/start"))).status).toBe(200)
      const entries = await eventually(
        () => logged(a),
        (es) => es.length === MAX_HOPS + 1 && es.every((e) => e.callbacks?.[0]?.state !== "pending")
      )
      expect(hopsOf(entries)).toEqual(Array.from({ length: MAX_HOPS + 1 }, (_, i) => i))
      expect(entries.every((e) => e.response.status === 200)).toBe(true)
      const deepest = entries.find((e) => e.request.headers["x-imposters-hop"] === String(MAX_HOPS))
      expect(deepest?.callbacks?.[0]).toMatchObject({ state: "skipped", error: "hop limit 8 reached" })
    })
  }, 15_000)

  it("past 64 calls in flight a call fails at once instead of queueing", async () => {
    const fanOut = Array.from({ length: 10 }, (_, i) => ({ name: `c${i}`, url: url(8938, "/slow") }))
    await withImposters([
      {
        port: 8937,
        stubs: [{
          predicates: [],
          responses: [{ status: 200, callbacks: { parallel: true, before: fanOut }, body: "done" }]
        }]
      },
      { port: 8938, stubs: [{ predicates: [], responses: [{ status: 200, delay: 1500 }] }] }
    ], async ([a = ""]) => {
      // 7 requests × 10 calls, all held by the slow target: 64 get a slot, 6 fail fast
      const answers = await Promise.all(Array.from({ length: 7 }, () => fetch(url(8937, "/fan"))))
      expect(answers.map((r) => r.status)).toEqual(Array.from({ length: 7 }, () => 200))
      const records = (await logged(a)).flatMap((e) => e.callbacks ?? [])
      expect(records).toHaveLength(70)
      const refused = records.filter((r) => r.error === "too many callbacks in flight")
      expect(refused).toHaveLength(6)
      expect(refused.every((r) => r.state === "failed")).toBe(true)
      expect(records.filter((r) => r.state === "answered")).toHaveLength(64)
    })
  }, 15_000)

  it("a forward still in flight from a stopped run never counts in the new run's outbound edges", async () => {
    // A target owned by the test: it says when the forward arrived, and answers only when released
    const arrived = signal()
    const released = signal()
    const sent = signal()
    const target = http.createServer((_req, res) => {
      arrived.resolve()
      void released.promise.then(() => {
        res.on("finish", () => sent.resolve())
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("late")
      })
    })
    await new Promise<void>((resolve) => target.listen(8940, "127.0.0.1", resolve))
    try {
      await withImposters([{ port: 8939, proxy: { targetUrl: url(8940) } }], async ([a = ""]) => {
        // Sent, then the proxy's run is stopped under it: the client's socket closes with it
        const inFlight = fetch(url(8939, "/slow")).catch(() => undefined)
        await arrived.promise
        await admin(`/imposters/${a}`, "PATCH", { status: "stopped" })
        await admin(`/imposters/${a}`, "PATCH", { status: "running" })
        await admin(`/imposters/${a}/stats`, "DELETE")
        await inFlight
        released.resolve()
        await sent.promise
        // The old forward records its sample (if it does) just after the answer reaches it, and
        // nothing signals that, so the absence can only be checked after a short settle
        await new Promise((resolve) => setTimeout(resolve, 200))
        const stats: { outbound: ReadonlyArray<unknown>; totalRequests: number } =
          await (await admin(`/imposters/${a}/stats`)).json()
        expect(stats.totalRequests).toBe(0)
        expect(stats.outbound).toEqual([])
      })
    } finally {
      released.resolve()
      target.closeAllConnections()
      await new Promise((resolve) => target.close(resolve))
    }
  }, 15_000)
})
