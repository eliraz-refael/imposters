import { HttpRouter } from "effect/unstable/http"
import { makeFullLayer } from "imposters/server/AdminServer"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// Callbacks in the per-imposter UI, over real ports: a stub card names its calls, and a request's
// page lists them in its Outbound calls panel, a pending after call settling on a reload. This
// file owns 8401-8429 (8429 is never bound: a callback to it is refused).

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
  readonly request: { readonly path: string }
  readonly callbacks?: ReadonlyArray<{ readonly name: string; readonly state: string }>
}

const logged = async (id: string): Promise<Array<Logged>> => (await admin(`/imposters/${id}/requests?limit=500`)).json()

const url = (port: number, path = "") => `http://127.0.0.1:${String(port)}${path}`

const page = async (port: number, path: string): Promise<string> => {
  const response = await fetch(url(port, path))
  expect(response.status).toBe(200)
  return response.text()
}

// Polls `check` until it holds (an `after` call settles after the response is sent)
const eventually = async <A>(read: () => Promise<A>, check: (a: A) => boolean, timeoutMs = 5000): Promise<A> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (check(value) || Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// Imposters on these ports with these stubs, running for `body`, deleted after
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

// The row of one call on a request's page: from its attributes to the next row
const row = (html: string, name: string): string => {
  const start = html.indexOf(`data-call="${name}"`)
  if (start === -1) return ""
  const next = html.indexOf(`<div class="why-stub"`, start)
  return html.slice(start, next === -1 ? undefined : next)
}

describe("E2E: callbacks in the imposter UI", () => {
  it(
    "the stub card names the calls, and the request page lists them, the pending one settling on a reload",
    async () => {
      await withImposters([
        {
          port: 8401,
          stubs: [on("/checkout", {
            status: 200,
            callbacks: {
              before: [
                { name: "cart", url: url(8402, "/carts/7") },
                { name: "price", method: "POST", url: url(8429, "/quote"), body: { sku: "tea" }, timeout: 1000 }
              ],
              after: [{ name: "notify", method: "POST", url: url(8402, "/events"), body: { type: "checkout" } }]
            },
            body: { ok: "${callbacks.cart.ok}" }
          })]
        },
        {
          port: 8402,
          stubs: [
            on("/carts/7", { status: 200, body: { items: ["tea"] } }),
            // Slow enough that the after call is still pending when the page is first read
            on("/events", { status: 202, delay: 1000, body: "queued" })
          ]
        }
      ], async ([a = ""]) => {
        const stubs = await page(8401, "/_admin/stubs")
        expect(stubs).toContain(`<span class="label c-text-2">before → cart, price · after → notify</span>`)
        expect(stubs).toContain(`<span class="c-text-2">cart</span> GET 127.0.0.1:8402`)
        expect(stubs).toContain(`<span class="c-text-2">price</span> POST 127.0.0.1:8429`)
        expect(stubs).toContain(`<span class="c-text-2">notify</span> POST 127.0.0.1:8402`)

        const response = await fetch(url(8401, "/checkout"))
        expect(await response.json()).toEqual({ ok: true })
        const [entry] = await logged(a)
        expect(entry?.callbacks?.map((r) => [r.name, r.state])).toEqual([
          ["cart", "answered"],
          ["price", "failed"],
          ["notify", "pending"]
        ])

        const first = await page(8401, `/_admin/requests/${entry?.id ?? ""}`)
        expect(first).toContain("data-outbound")
        expect(first).toContain("3 calls · 1 pending: reload to see it settle")
        expect(row(first, "cart")).toContain(`data-state="answered"`)
        expect(row(first, "cart")).toContain(`<span class="c-ok">200 OK</span>`)
        expect(row(first, "cart")).toContain(`<summary class="label">response body</summary>`)
        expect(row(first, "price")).toContain(`data-state="failed"`)
        expect(row(first, "price")).toContain(`<span class="c-error">connection failed`)
        expect(row(first, "price")).toContain(`<summary class="label">request body</summary>`)
        expect(row(first, "notify")).toContain(`data-state="pending"`)
        expect(row(first, "notify")).toContain(`<span class="c-muted">pending</span>`)
        // before first, then after
        expect(first.indexOf(`data-call="cart"`)).toBeLessThan(first.indexOf(`data-call="price"`))
        expect(first.indexOf(`data-call="price"`)).toBeLessThan(first.indexOf(`data-call="notify"`))

        await eventually(() => logged(a), (entries) => entries[0]?.callbacks?.[2]?.state !== "pending")
        const reloaded = await page(8401, `/_admin/requests/${entry?.id ?? ""}`)
        expect(reloaded).toContain(`<span class="label">3 calls</span>`)
        expect(row(reloaded, "notify")).toContain(`data-state="answered"`)
        expect(row(reloaded, "notify")).toContain(`<span class="c-ok">202 Accepted</span>`)
        expect(row(reloaded, "notify")).toContain(`<pre class="code code-body">queued</pre>`)
      })
    },
    15_000
  )

  it("a request whose response made no calls has no Outbound calls panel", async () => {
    await withImposters([{ port: 8403, stubs: [on("/plain", { status: 200, body: "hi" })] }], async ([a = ""]) => {
      await (await fetch(url(8403, "/plain"))).text()
      const [entry] = await logged(a)
      const html = await page(8403, `/_admin/requests/${entry?.id ?? ""}`)
      expect(html).not.toContain("data-outbound")
      expect(await page(8403, "/_admin/stubs")).not.toContain("data-calls")
    })
  })
})
