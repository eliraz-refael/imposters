import { HttpRouter } from "effect/unstable/http"
import { makeFullLayer } from "imposters/server/AdminServer"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// A client cannot make a stub evaluate an expression by sending one in a value the stub
// echoes. This file owns 8541-8549.

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

const url = (port: number, path = "") => `http://127.0.0.1:${String(port)}${path}`

const on = (path: string, response: Record<string, unknown>) => ({
  predicates: [{ field: "path", operator: "equals", value: path }],
  responses: [response]
})

const start = async (port: number, stubs: ReadonlyArray<Record<string, unknown>>): Promise<string> => {
  const created = await admin("/imposters", "POST", { port })
  expect(created.status).toBe(201)
  const imp: { id: string } = await created.json()
  for (const stub of stubs) expect((await admin(`/imposters/${imp.id}/stubs`, "POST", stub)).status).toBe(201)
  expect((await admin(`/imposters/${imp.id}`, "PATCH", { status: "running" })).status).toBe(200)
  return imp.id
}

describe("E2E: request values are data", () => {
  it("a client cannot read a callback's answer through a query value", async () => {
    const ids: Array<string> = []
    try {
      ids.push(await start(8542, [on("/token", { status: 200, body: { token: "s3cret" } })]))
      ids.push(
        await start(8541, [on("/echo", {
          status: 200,
          headers: { "x-echo": "{{request.query.q}}" },
          callbacks: { before: [{ name: "token", url: url(8542, "/token") }] },
          body: { echo: "{{request.query.q}}", own: "${callbacks.token.body.token = 's3cret'}" }
        })])
      )
      const q = "${callbacks.token.body.token}"
      const response = await fetch(url(8541, `/echo?q=${encodeURIComponent(q)}`))
      expect(response.status).toBe(200)
      expect(response.headers.get("x-echo")).toBe(q)
      const text = await response.text()
      expect(text).not.toContain("s3cret")
      // The stub's own expression still sees the callback
      expect(JSON.parse(text)).toEqual({ echo: q, own: true })
    } finally {
      for (const id of ids) await admin(`/imposters/${id}?force=true`, "DELETE")
    }
  }, 15_000)
})
