import { Effect, ManagedRuntime, Schema } from "effect"
import { createConfiguredImposters, loadConfigFile } from "imposters/cli/ConfigLoader"
import { ImpostersClient, type ImpostersClientShape } from "imposters/client/ImpostersClient"
import { makeTestServer, withImposter } from "imposters/client/testing"
import { PortNumber } from "imposters/schemas/common"
import { CreateImposterRequest } from "imposters/schemas/ImposterSchema"
import { httpGet } from "imposters/test/helpers/net"
import * as path from "node:path"
import { afterAll, describe, expect, it } from "vitest"

// Ports 8671-8679 belong to this file.

const server = makeTestServer()
const clientRuntime = ManagedRuntime.make(server.clientLayer)

afterAll(async () => {
  await clientRuntime.dispose()
  server.dispose()
})

const api = <A, E>(f: (client: ImpostersClientShape) => Effect.Effect<A, E>): Promise<A> =>
  clientRuntime.runPromise(Effect.gen(function*() {
    return yield* f(yield* ImpostersClient)
  }))

const createImposter = (fields: Record<string, unknown>) =>
  api((c) => c.imposters.createImposter({ payload: Schema.decodeUnknownSync(CreateImposterRequest)(fields) }))

const remove = (id: string) => api((c) => c.imposters.deleteImposter({ params: { id }, query: { force: true } }))

// A raw admin request, for the wire form and the status the typed client would turn into an error
const raw = async (method: string, urlPath: string, body?: unknown) => {
  const response = await server.handler(
    new Request(`http://localhost${urlPath}`, {
      method,
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})
    })
  )
  const json: unknown = await response.json()
  return { status: response.status, body: json }
}

const EXAMPLE = path.join(__dirname, "../../examples/fault-injection.json")

describe("E2E: delay ranges", () => {
  it("the typed client takes both forms, and GET gives each back as it was given", async () => {
    const imp = await createImposter({ name: "delay-roundtrip" })
    try {
      const stub = await api((c) =>
        c.imposters.addStub({
          params: { imposterId: imp.id },
          payload: {
            predicates: [],
            responseMode: "sequential",
            responses: [
              { status: 200, delay: { min: 100, max: 500 } },
              { status: 201, delay: 250 },
              { status: 202, delay: { min: 40, max: 40 } },
              { status: 203 }
            ]
          }
        })
      )
      const expected = [
        { status: 200, delay: { min: 100, max: 500 } },
        { status: 201, delay: 250 },
        { status: 202, delay: { min: 40, max: 40 } },
        { status: 203 }
      ]
      expect(stub.responses).toEqual(expected)

      const listed = await api((c) => c.imposters.listStubs({ params: { imposterId: imp.id } }))
      expect(listed.map((s) => s.responses)).toEqual([expected])

      // The wire form, not just the client's decoding of it
      const wire = await raw("GET", `/imposters/${imp.id}/stubs`)
      expect(wire).toMatchObject({ status: 200, body: [{ responses: expected }] })

      // PUT replaces a fixed delay with a range, and back
      const updated = await api((c) =>
        c.imposters.updateStub({
          params: { imposterId: imp.id, stubId: stub.id },
          payload: { responses: [{ status: 200, delay: { min: 0, max: 60000 } }] }
        })
      )
      expect(updated.responses).toEqual([{ status: 200, delay: { min: 0, max: 60000 } }])
    } finally {
      await remove(imp.id)
    }
  })

  it("answers 400, naming the field, when min is above max", async () => {
    const imp = await createImposter({ name: "delay-reject" })
    try {
      const rejected = await raw("POST", `/imposters/${imp.id}/stubs`, {
        responses: [{ status: 200, delay: { min: 500, max: 100 } }]
      })
      expect(rejected.status).toBe(400)
      expect(rejected.body).toMatchObject({
        _tag: "HttpApiDecodeError",
        issues: [{
          path: ["responses", 0, "delay", "max"],
          message: "max (100) must be greater than or equal to min (500)"
        }]
      })

      for (const delay of [{ min: -1, max: 10 }, { min: 1, max: 60001 }, { min: 1.5, max: 10 }, { min: 10 }, "fast"]) {
        const bad = await raw("POST", `/imposters/${imp.id}/stubs`, { responses: [{ status: 200, delay }] })
        expect(bad.status, JSON.stringify(delay)).toBe(400)
      }

      // Nothing was added by the rejected requests
      expect(await api((c) => c.imposters.listStubs({ params: { imposterId: imp.id } }))).toEqual([])
    } finally {
      await remove(imp.id)
    }
  })

  it("a running imposter answers a stub with a delay range", async () => {
    const imp = await createImposter({ name: "delay-live", port: 8671 })
    try {
      await api((c) =>
        c.imposters.addStub({
          params: { imposterId: imp.id },
          payload: {
            predicates: [],
            responseMode: "sequential",
            responses: [{ status: 200, body: "late", delay: { min: 1, max: 5 } }]
          }
        })
      )
      await api((c) => c.imposters.updateImposter({ params: { id: imp.id }, payload: { status: "running" } }))
      const first = await httpGet(8671, "/anything")
      const second = await httpGet(8671, "/anything")
      expect([first.status, first.body, second.status, second.body]).toEqual([200, "late", 200, "late"])
    } finally {
      await remove(imp.id)
    }
  })

  it("withImposter takes a delay range", async () => {
    await clientRuntime.runPromise(
      withImposter(
        { port: 8672, stubs: [{ responses: [{ status: 204, delay: { min: 1, max: 3 } }] }] },
        (ctx) =>
          Effect.gen(function*() {
            const stubs = yield* (yield* ImpostersClient).imposters.listStubs({ params: { imposterId: ctx.id } })
            expect(stubs[0]?.responses).toEqual([{ status: 204, delay: { min: 1, max: 3 } }])
            const answer = yield* Effect.promise(() => httpGet(8672, "/"))
            expect(answer.status).toBe(204)
          })
      )
    )
  })

  it("a config file's delay range loads through the CLI's config path", async () => {
    const config = await clientRuntime.runPromise(loadConfigFile(EXAMPLE))
    const jittery = config.imposters[0]?.stubs.find((s) =>
      s.predicates.some((p) => p.field === "path" && p.value === "/jittery")
    )
    expect(jittery?.responses[0].delay).toEqual({ min: 100, max: 800 })

    // The example, moved off 3001
    const port = Schema.decodeUnknownSync(PortNumber)(8673)
    await clientRuntime.runPromise(createConfiguredImposters(config.imposters.map((i) => ({ ...i, port }))))
    const list = await api((c) => c.imposters.listImposters({ query: { limit: 50, offset: 0 } }))
    const loaded = list.imposters.find((i) => i.port === 8673)
    try {
      expect(loaded?.status).toBe("running")
      const stubs = await api((c) => c.imposters.listStubs({ params: { imposterId: loaded?.id ?? "" } }))
      expect(stubs.flatMap((s) => s.responses).map((r) => r.delay)).toEqual([
        undefined,
        undefined,
        2000,
        { min: 100, max: 800 }
      ])
    } finally {
      if (loaded !== undefined) await remove(loaded.id)
    }
  })

  it("the OpenAPI document describes delay as a number or a { min, max } range", async () => {
    const response = await server.handler(new Request("http://localhost/openapi.json"))
    expect(response.status).toBe(200)
    const spec: unknown = await response.json()
    // Every stub payload and answer shares ResponseConfig, so the first `delay` found stands for all
    const findDelay = (node: unknown): unknown => {
      if (typeof node !== "object" || node === null) return undefined
      for (const [key, value] of Object.entries(node)) {
        const found = key === "delay" ? value : findDelay(value)
        if (found !== undefined) return found
      }
      return undefined
    }
    const bound = { type: "integer", minimum: 0, maximum: 60000 }
    const range = { type: "object", properties: { min: bound, max: bound }, required: ["min", "max"] }
    // Every `anyOf` under a node: an optional field is wrapped in one with null, the union sits inside it
    const unions = (node: unknown): Array<unknown> =>
      typeof node !== "object" || node === null
        ? []
        : Object.entries(node).flatMap(([key, value]) => [...(key === "anyOf" ? [value] : []), ...unions(value)])
    expect(unions(findDelay(spec))).toContainEqual([bound, expect.objectContaining(range)])
  })
})
