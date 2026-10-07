import { Effect } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { loadConfigFile } from "imposters/cli/ConfigLoader"
import { makeFullLayer } from "imposters/server/AdminServer"
import * as path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const EXAMPLE = path.join(__dirname, "../../examples/callbacks.json")

// Stub callbacks over real ports: imposters calling imposters. This file owns 8901-8929
// (8929 is never bound: a callback to it is refused).

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

const admin = (path: string, method = "GET", body?: unknown) =>
  adminHandler(
    new Request(`http://localhost:2525${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    })
  )

interface Logged {
  readonly id: string
  readonly request: { readonly path: string; readonly headers: Record<string, string>; readonly body?: unknown }
  readonly response: { readonly status: number }
  readonly duration: number
  readonly callbacks?: ReadonlyArray<{
    readonly name: string
    readonly phase: string
    readonly url: string
    readonly state: string
    readonly status?: number
    readonly error?: string
    readonly requestBody?: string
    readonly responseBody?: string
  }>
}

const logged = async (id: string): Promise<Array<Logged>> => (await admin(`/imposters/${id}/requests?limit=500`)).json()

const SAME_ORIGIN = { "sec-fetch-site": "same-origin" }

const url = (port: number, path = "") => `http://127.0.0.1:${String(port)}${path}`

// Imposters on these ports with these stubs, running for `body`, stopped after
const withImposters = async (
  specs: ReadonlyArray<{ readonly port: number; readonly stubs: ReadonlyArray<Record<string, unknown>> }>,
  body: (ids: ReadonlyArray<string>) => Promise<void>
) => {
  const ids: Array<string> = []
  try {
    for (const spec of specs) {
      const created = await admin("/imposters", "POST", { port: spec.port })
      expect(created.status).toBe(201)
      const imp: { id: string } = await created.json()
      ids.push(imp.id)
      for (const stub of spec.stubs) expect((await admin(`/imposters/${imp.id}/stubs`, "POST", stub)).status).toBe(201)
      await admin(`/imposters/${imp.id}`, "PATCH", { status: "running" })
    }
    await body(ids)
  } finally {
    for (const id of ids) await admin(`/imposters/${id}?force=true`, "DELETE")
  }
}

const on = (path: string, response: Record<string, unknown>) => ({
  predicates: [{ field: "path", operator: "equals", value: path }],
  responses: [response]
})

// Polls `check` until it holds (an `after` call settles after the response is sent)
const eventually = async <A>(read: () => Promise<A>, check: (a: A) => boolean, timeoutMs = 3000): Promise<A> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (check(value) || Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe("E2E: callbacks", () => {
  it("A aggregates B and C in a chain: later calls see earlier ones, each sends the next hop", async () => {
    await withImposters([
      {
        port: 8901,
        stubs: [on("/checkout", {
          status: 200,
          callbacks: {
            before: [
              { name: "cart", url: url(8902, "/carts/{{request.query.cart}}") },
              {
                name: "price",
                method: "POST",
                url: url(8903, "/quote"),
                headers: { "x-cart": "${callbacks.cart.body.id}" },
                body: { items: "${callbacks.cart.body.items}" }
              }
            ]
          },
          body: {
            items: "${callbacks.cart.body.items}",
            total: "${callbacks.price.body.total}",
            via: "{{callbacks.price.status}}"
          }
        })]
      },
      { port: 8902, stubs: [on("/carts/7", { status: 200, body: { id: "c-7", items: ["a", "b"] } })] },
      { port: 8903, stubs: [on("/quote", { status: 200, body: { total: "${$count(request.body.items) * 10}" } })] }
    ], async ([a = "", b = "", c = ""]) => {
      const response = await fetch(url(8901, "/checkout?cart=7"))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ items: ["a", "b"], total: 20, via: "200" })

      const [carts] = await logged(b)
      expect(carts?.request.headers["x-imposters-hop"]).toBe("1")
      const [quote] = await logged(c)
      expect(quote?.request.headers["x-cart"]).toBe("c-7")
      expect(quote?.request.body).toEqual({ items: ["a", "b"] })

      const [entry] = await logged(a)
      expect(entry?.callbacks?.map((r) => [r.name, r.phase, r.state, r.status])).toEqual([
        ["cart", "before", "answered", 200],
        ["price", "before", "answered", 200]
      ])
      expect(entry?.callbacks?.[0]?.url).toBe(url(8902, "/carts/7"))
      expect(entry?.callbacks?.[1]?.requestBody).toBe("{\"items\":[\"a\",\"b\"]}")

      // Both targets are outbound edges of A
      const stats: { outbound: ReadonlyArray<{ host: string; via: string; calls: number }> } =
        await (await admin(`/imposters/${a}/stats`)).json()
      expect(stats.outbound.map((e) => [e.host, e.via, e.calls]).sort()).toEqual([
        ["127.0.0.1:8902", "callback", 1],
        ["127.0.0.1:8903", "callback", 1]
      ])
    })
  }, 15_000)

  it("parallel calls overlap; sequential ones add up, and the delay adds to them", async () => {
    const slow = (port: number, path: string) => ({ port, stubs: [on(path, { status: 200, delay: 300, body: "ok" })] })
    const before = [{ name: "b", url: url(8905, "/b") }, { name: "c", url: url(8906, "/c") }]
    await withImposters([
      {
        port: 8904,
        stubs: [
          on("/parallel", { status: 200, callbacks: { parallel: true, before }, body: "${callbacks.b.body}" }),
          on("/sequential", { status: 200, delay: 100, callbacks: { before }, body: "${callbacks.c.body}" })
        ]
      },
      slow(8905, "/b"),
      slow(8906, "/c")
    ], async ([a = ""]) => {
      const timed = async (path: string) => {
        const start = performance.now()
        const response = await fetch(url(8904, path))
        expect(await response.text()).toBe("ok")
        return performance.now() - start
      }
      const parallel = await timed("/parallel")
      const sequential = await timed("/sequential")
      expect(parallel).toBeGreaterThanOrEqual(290)
      expect(parallel).toBeLessThan(580)
      // 300 + 300 + the stub's own 100
      expect(sequential).toBeGreaterThanOrEqual(690)
      const entries = await logged(a)
      expect(entries.map((e) => e.duration >= 290)).toEqual([true, true])
    })
  }, 15_000)

  it("onError fail turns a 5xx or no response into a 502; continue exposes the error", async () => {
    await withImposters([
      {
        port: 8907,
        stubs: [
          on("/down", {
            status: 200,
            callbacks: {
              before: [{ name: "price", url: url(8929, "/quote"), onError: "fail" }, {
                name: "never",
                url: url(8908, "/x")
              }],
              after: [{ name: "notify", url: url(8908, "/x") }]
            },
            body: "unreachable"
          }),
          on("/5xx", {
            status: 200,
            callbacks: { before: [{ name: "price", url: url(8908, "/busy"), onError: "fail" }] }
          }),
          on("/soft", {
            status: 200,
            callbacks: { before: [{ name: "price", url: url(8929, "/quote") }] },
            body: "${callbacks.price.ok ? 'priced' : 'unpriced'}"
          })
        ]
      },
      { port: 8908, stubs: [on("/busy", { status: 503, body: { error: "busy" } })] }
    ], async ([a = "", b = ""]) => {
      const down = await fetch(url(8907, "/down"))
      expect(down.status).toBe(502)
      const body: { error: string; callback: string; reason: string } = await down.json()
      expect(body).toMatchObject({ error: "Callback failed", callback: "price" })
      expect(body.reason).toContain("connection failed")

      const busy = await fetch(url(8907, "/5xx"))
      expect(busy.status).toBe(502)
      expect(await busy.json()).toEqual({ error: "Callback failed", callback: "price", status: 503 })

      const soft = await fetch(url(8907, "/soft"))
      expect(soft.status).toBe(200)
      expect(await soft.text()).toBe("unpriced")

      const entries = await logged(a)
      expect(entries[0]?.callbacks?.map((r) => [r.name, r.state])).toEqual([
        ["price", "failed"],
        ["never", "skipped"],
        ["notify", "skipped"]
      ])
      // Neither the skipped before call nor the after call was sent
      expect((await logged(b)).map((e) => e.request.path)).toEqual(["/busy"])
    })
  }, 15_000)

  it("an after webhook reaches D once the answer is sent, and its pending record settles", async () => {
    await withImposters([
      {
        port: 8910,
        stubs: [on("/order", {
          status: 201,
          callbacks: {
            after: [{
              name: "notify",
              method: "POST",
              url: url(8911, "/events"),
              body: { type: "order", id: "{{request.query.id}}" }
            }]
          },
          body: { created: true }
        })]
      },
      { port: 8911, stubs: [on("/events", { status: 202, delay: 300, body: "queued" })] }
    ], async ([a = "", d = ""]) => {
      const response = await fetch(url(8910, "/order?id=42"))
      expect(response.status).toBe(201)
      const [pending] = await logged(a)
      expect(pending?.callbacks).toEqual([{
        name: "notify",
        phase: "after",
        method: "POST",
        url: url(8911, "/events"),
        state: "pending"
      }])

      const events = await eventually(() => logged(d), (entries) => entries.length > 0)
      expect(events[0]?.request.body).toEqual({ type: "order", id: "42" })
      expect(events[0]?.request.headers["x-imposters-hop"]).toBe("1")

      const settled = await eventually(() => logged(a), (entries) => entries[0]?.callbacks?.[0]?.state !== "pending")
      expect(settled[0]?.callbacks?.[0]).toMatchObject({
        state: "answered",
        status: 202,
        responseBody: "queued",
        requestBody: "{\"type\":\"order\",\"id\":\"42\"}"
      })
      expect(settled[0]?.id).toBe(pending?.id)
    })
  }, 15_000)

  it("stop interrupts a slow after call: it does not wait for it, and nothing settles later", async () => {
    await withImposters([
      {
        port: 8912,
        stubs: [on("/fire", {
          status: 200,
          callbacks: { after: [{ name: "slow", url: url(8913, "/slow"), timeout: 30000 }] }
        })]
      },
      { port: 8913, stubs: [on("/slow", { status: 200, delay: 5000 })] }
    ], async ([a = ""]) => {
      expect((await fetch(url(8912, "/fire"))).status).toBe(200)
      expect((await logged(a))[0]?.callbacks?.[0]?.state).toBe("pending")
      const start = performance.now()
      await admin(`/imposters/${a}`, "PATCH", { status: "stopped" })
      expect(performance.now() - start).toBeLessThan(2000)
      await admin(`/imposters/${a}`, "PATCH", { status: "running" })
      // The stopped run's log is gone, and its interrupted call never lands in the new one
      expect(await logged(a)).toEqual([])
      const stats: { outbound: ReadonlyArray<unknown> } = await (await admin(`/imposters/${a}/stats`)).json()
      expect(stats.outbound).toEqual([])
    })
  }, 15_000)

  it("preview never calls out; a replay fires the callbacks like a real request", async () => {
    const counted = { name: "count", url: url(8915, "/hit") }
    const stub = {
      predicates: [{ field: "path", operator: "equals", value: "/thing" }],
      responses: [{ status: 200, callbacks: { before: [counted], after: [{ ...counted, name: "after_count" }] } }]
    }
    await withImposters([
      { port: 8914, stubs: [] },
      { port: 8915, stubs: [on("/hit", { status: 200, body: "hit" })] }
    ], async ([a = "", d = ""]) => {
      // An unmatched request for the preview to try the candidate on
      expect((await fetch(url(8914, "/thing"))).status).toBe(404)
      const preview: { matched: number } = await (await admin(`/imposters/${a}/stubs/preview`, "POST", stub)).json()
      expect(preview.matched).toBe(1)
      expect(await logged(d)).toEqual([])

      expect((await admin(`/imposters/${a}/stubs`, "POST", stub)).status).toBe(201)
      expect((await fetch(url(8914, "/thing"))).status).toBe(200)
      await eventually(() => logged(d), (entries) => entries.length === 2)
      const [original] = (await logged(a)).filter((e) => e.response.status === 200)
      const replayed = await fetch(url(8914, `/_admin/requests/${original?.id ?? ""}/replay`), {
        method: "POST",
        redirect: "manual",
        headers: SAME_ORIGIN
      })
      expect(replayed.status).toBe(303)
      const hits = await eventually(() => logged(d), (entries) => entries.length === 4)
      expect(hits).toHaveLength(4)
    })
  }, 15_000)

  it("examples/callbacks.json loads through the CLI's config path and runs as described", async () => {
    const config = await Effect.runPromise(loadConfigFile(EXAMPLE))
    // The example, moved from 3301-3304 to 8921-8924 (its callback urls too)
    const moved: Array<{ port: number; stubs: Array<Record<string, unknown>> }> = JSON.parse(
      JSON.stringify(config.imposters).replaceAll(/\b330([1-4])\b/g, "892$1")
    )
    expect(moved.map((i) => i.port)).toEqual([8921, 8922, 8923, 8924])
    await withImposters(moved, async ([checkout = "", , , events = ""]) => {
      const response = await fetch(url(8921, "/checkout?cart=9"), { method: "POST" })
      expect(response.status).toBe(201)
      expect(await response.json()).toEqual({
        cart: "9",
        items: [{ sku: "tea", price: 4 }, { sku: "cake", price: 6 }],
        total: 10
      })
      const notified = await eventually(() => logged(events), (entries) => entries.length > 0)
      expect(notified[0]?.request.body).toEqual({ type: "checkout", cart: "9", total: 10 })
      const settled = await eventually(
        () => logged(checkout),
        (entries) => entries[0]?.callbacks?.[2]?.state === "answered"
      )
      expect(settled[0]?.callbacks?.map((r) => [r.name, r.state, r.status])).toEqual([
        ["cart", "answered", 200],
        ["price", "answered", 200],
        ["notify", "answered", 202]
      ])
    })
  }, 15_000)
})
