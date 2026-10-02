import { Effect, ManagedRuntime } from "effect"
import * as Schema from "effect/Schema"
import { ImpostersClient, type ImpostersClientShape } from "imposters/client/ImpostersClient"
import { makeTestServer } from "imposters/client/testing"
import { CreateImposterRequest } from "imposters/schemas/ImposterSchema"
import { AddStubRequest, CreateStubRequest } from "imposters/schemas/StubSchema"
import { httpGet } from "imposters/test/helpers/net"
import { afterAll, describe, expect, it } from "vitest"

// Ports 9461-9469 belong to this file.

const server = makeTestServer()
const clientRuntime = ManagedRuntime.make(server.clientLayer)

afterAll(async () => {
  await clientRuntime.dispose()
  server.dispose()
})

// Runs one call against the typed client, so every answer is decoded by the client's schemas
const api = <A, E>(f: (client: ImpostersClientShape) => Effect.Effect<A, E>): Promise<A> =>
  clientRuntime.runPromise(Effect.gen(function*() {
    return yield* f(yield* ImpostersClient)
  }))

const decodeImposter = Schema.decodeUnknownSync(CreateImposterRequest)
const decodeStub = Schema.decodeUnknownSync(CreateStubRequest)
const decodeAddStub = Schema.decodeUnknownSync(AddStubRequest)

const createImposter = (fields: Record<string, unknown>) =>
  api((c) => c.imposters.createImposter({ payload: decodeImposter(fields) }))

const addStub = (imposterId: string, stub: Record<string, unknown>, index?: number) =>
  api((c) =>
    c.imposters.addStub({
      params: { imposterId },
      payload: decodeAddStub(index !== undefined ? { ...stub, index } : stub)
    })
  )

const setStatus = (id: string, status: "running" | "stopped") =>
  api((c) => c.imposters.updateImposter({ params: { id }, payload: { status } }))

const stats = (id: string) => api((c) => c.imposters.getImposterStats({ params: { id } }))

const listStubIds = async (imposterId: string) =>
  (await api((c) => c.imposters.listStubs({ params: { imposterId } }))).map((s) => s.id)

const requests = (id: string) => api((c) => c.imposters.listRequests({ params: { id }, query: { limit: 100 } }))

const explain = (id: string, requestId: string) => api((c) => c.imposters.explainRequest({ params: { id, requestId } }))

const preview = (imposterId: string, stub: Record<string, unknown>) =>
  api((c) => c.imposters.previewStub({ params: { imposterId }, payload: decodeStub(stub) }))

const remove = (id: string) => api((c) => c.imposters.deleteImposter({ params: { id }, query: { force: true } }))

const pathIs = (path: string) => [{ field: "path", operator: "equals", value: path }]

// A raw admin request, for the status and body the typed client would turn into an error
const raw = async (method: string, path: string, body?: unknown) => {
  const response = await server.handler(
    new Request(`http://localhost${path}`, {
      method,
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})
    })
  )
  return { status: response.status, body: await response.json() }
}

// A running imposter, deleted once `body` is done
const withRunning = async (
  fields: Record<string, unknown>,
  stubs: ReadonlyArray<Record<string, unknown>>,
  body: (id: string, stubIds: ReadonlyArray<string>) => Promise<void>
) => {
  const imp = await createImposter(fields)
  try {
    const stubIds: Array<string> = []
    for (const stub of stubs) stubIds.push((await addStub(imp.id, stub)).id)
    await setStatus(imp.id, "running")
    await body(imp.id, stubIds)
  } finally {
    await remove(imp.id)
  }
}

describe("E2E: addStub at an index", () => {
  it("inserts first, between and last on a running imposter, and every stub keeps its counters", async () => {
    const catchAll = { predicates: [], responses: [{ status: 200 }, { status: 201 }] }
    await withRunning({ port: 9461 }, [catchAll], async (id, [all = ""]) => {
      expect((await httpGet(9461, "/b")).status).toBe(200)
      expect((await httpGet(9461, "/b")).status).toBe(201)

      // First: it now takes /b ahead of the catch-all, at once (hot-reloaded)
      const first = await addStub(id, { predicates: pathIs("/b"), responses: [{ status: 202 }] }, 0)
      expect((await httpGet(9461, "/b")).status).toBe(202)
      // The catch-all's cycle carries on where it was
      expect((await httpGet(9461, "/x")).status).toBe(200)

      const s = await stats(id)
      expect(s.stubs.map((row) => row.stubId)).toEqual([first.id, all])
      expect(s.stubs[0]).toMatchObject({ hits: 1, byResponse: [1], nextResponseIndex: 0 })
      expect(s.stubs[1]).toMatchObject({ hits: 3, byResponse: [2, 1], nextResponseIndex: 1 })

      // Between, then last by count, then last by default
      const between = await addStub(id, { predicates: pathIs("/c"), responses: [{ status: 203 }] }, 1)
      const atCount = await addStub(id, { predicates: pathIs("/d"), responses: [{ status: 204 }] }, 3)
      const appended = await addStub(id, { predicates: pathIs("/e"), responses: [{ status: 205 }] })
      expect(await listStubIds(id)).toEqual([first.id, between.id, all, atCount.id, appended.id])
      expect((await httpGet(9461, "/c")).status).toBe(203)
      // Behind the catch-all, so never reached
      expect((await httpGet(9461, "/d")).status).toBe(201)
      expect((await stats(id)).stubs.map((row) => row.stubId)).toEqual(await listStubIds(id))
    })
  })

  it("answers 400 for an index past the end or not a non-negative integer, and 404 for no imposter", async () => {
    const imp = await createImposter({ port: 9462 })
    try {
      await addStub(imp.id, { responses: [{ status: 200 }] })

      // Through the typed client: a decoded ApiBadRequestError
      const error = await api((c) =>
        c.imposters.addStub({
          params: { imposterId: imp.id },
          payload: decodeAddStub({ responses: [{ status: 200 }], index: 2 })
        }).pipe(Effect.flip)
      )
      expect(error._tag).toBe("ApiBadRequestError")
      expect(error).toMatchObject({ message: expect.stringContaining("use 0 (first) to 1 (last)") })

      const stub = { responses: [{ status: 200 }] }
      const path = `/imposters/${imp.id}/stubs`
      expect((await raw("POST", path, { ...stub, index: 9 })).status).toBe(400)
      expect((await raw("POST", path, { ...stub, index: -1 })).status).toBe(400)
      expect((await raw("POST", path, { ...stub, index: 0.5 })).status).toBe(400)
      expect((await raw("POST", path, { ...stub, index: "first" })).status).toBe(400)
      // Nothing was added by the refused ones
      expect(await listStubIds(imp.id)).toHaveLength(1)

      expect(await raw("POST", "/imposters/nope/stubs", { ...stub, index: 0 })).toMatchObject({
        status: 404,
        body: { resourceType: "imposter", resourceId: "nope" }
      })
    } finally {
      await remove(imp.id)
    }
  })

  it("never stores or echoes the index, and an edit or preview ignores one like any unknown key", async () => {
    const imp = await createImposter({ port: 9467 })
    try {
      const a = await addStub(imp.id, { predicates: pathIs("/a"), responses: [{ status: 200 }] })
      const created = await raw("POST", `/imposters/${imp.id}/stubs`, { responses: [{ status: 201 }], index: 0 })
      expect(created.status).toBe(201)
      expect(created.body).not.toHaveProperty("index")
      const listed = await raw("GET", `/imposters/${imp.id}/stubs`)
      expect(listed.body.map((s: { id: string }) => s.id)).toEqual([created.body.id, a.id])
      for (const s of listed.body) expect(s).not.toHaveProperty("index")

      // PUT takes the edit and drops the index: the stub stays where it is
      const edited = await raw("PUT", `/imposters/${imp.id}/stubs/${a.id}`, { responses: [{ status: 202 }], index: 0 })
      expect(edited.status).toBe(200)
      expect(edited.body).toMatchObject({ id: a.id, responses: [{ status: 202 }] })
      expect(edited.body).not.toHaveProperty("index")
      expect(await listStubIds(imp.id)).toEqual([created.body.id, a.id])

      const previewed = await raw("POST", `/imposters/${imp.id}/stubs/preview`, {
        responses: [{ status: 200 }],
        index: 5
      })
      expect(previewed).toEqual({ status: 200, body: { matched: 0, total: 0 } })
    } finally {
      await remove(imp.id)
    }
  })
})

describe("E2E: explain a logged request", () => {
  it("explains each stub against the current ones, and flags when they no longer agree with the log", async () => {
    const stubs = [
      { predicates: [{ field: "method", operator: "equals", value: "POST" }], responses: [{ status: 201 }] },
      { predicates: [{ field: "path", operator: "startsWith", value: "/orders" }], responses: [{ status: 200 }] }
    ]
    await withRunning({ port: 9463 }, stubs, async (id, [post = "", orders = ""]) => {
      await httpGet(9463, "/orders/1")
      await httpGet(9463, "/nope")
      const log = await requests(id)
      const ordersEntry = log.find((e) => e.request.path === "/orders/1")
      const nopeEntry = log.find((e) => e.request.path === "/nope")
      expect(ordersEntry?.response.matchedStubId).toBe(orders)

      const matched = await explain(id, ordersEntry?.id ?? "")
      expect(matched).toEqual({
        requestId: ordersEntry?.id,
        stubs: [
          {
            stubId: post,
            matched: false,
            predicates: [
              {
                field: "method",
                operator: "equals",
                caseSensitive: true,
                expected: "POST",
                actual: "GET",
                matched: false
              }
            ]
          },
          {
            stubId: orders,
            matched: true,
            predicates: [{
              field: "path",
              operator: "startsWith",
              caseSensitive: true,
              expected: "/orders",
              actual: "/orders/1",
              matched: true
            }]
          }
        ],
        matchedStubId: orders,
        loggedMatchedStubId: orders,
        agreesWithLog: true
      })

      // Unmatched then and now
      const unmatched = await explain(id, nopeEntry?.id ?? "")
      expect(unmatched.matchedStubId).toBeUndefined()
      expect(unmatched.loggedMatchedStubId).toBeUndefined()
      expect(unmatched.agreesWithLog).toBe(true)
      expect(unmatched.stubs.map((s) => s.matched)).toEqual([false, false])

      // A stub inserted ahead now takes both: the explanations follow the current stubs
      const ahead = await addStub(id, { predicates: [], responses: [{ status: 204 }] }, 0)
      const changed = await explain(id, ordersEntry?.id ?? "")
      expect(changed).toMatchObject({ matchedStubId: ahead.id, loggedMatchedStubId: orders, agreesWithLog: false })
      expect(changed.stubs.map((s) => s.stubId)).toEqual([ahead.id, post, orders])
      expect(await explain(id, nopeEntry?.id ?? "")).toMatchObject({ matchedStubId: ahead.id, agreesWithLog: false })
    })
  })

  it("answers 404 for an unknown imposter or request", async () => {
    const imp = await createImposter({ port: 9464 })
    try {
      expect(await raw("GET", `/imposters/${imp.id}/requests/missing/explain`)).toMatchObject({
        status: 404,
        body: { _tag: "ApiNotFoundError", resourceType: "request", resourceId: "missing" }
      })
      expect(await raw("GET", "/imposters/nope/requests/missing/explain")).toMatchObject({
        status: 404,
        body: { resourceType: "imposter", resourceId: "nope" }
      })
      const error = await api((c) =>
        c.imposters.explainRequest({ params: { id: imp.id, requestId: "missing" } }).pipe(Effect.flip)
      )
      expect(error._tag).toBe("ApiNotFoundError")
    } finally {
      await remove(imp.id)
    }
  })
})

describe("E2E: preview a stub against the unmatched requests", () => {
  it("counts what the candidate would catch and shows its first answer, without adding it", async () => {
    await withRunning({ port: 9465 }, [{ predicates: pathIs("/known"), responses: [{ status: 200 }] }], async (id) => {
      await httpGet(9465, "/missing")
      await httpGet(9465, "/missing")
      expect((await fetch("http://127.0.0.1:9465/missing", { method: "POST" })).status).toBe(404)
      await httpGet(9465, "/other")
      await httpGet(9465, "/known")

      const candidate = {
        predicates: pathIs("/missing"),
        responses: [{ status: 418, body: { saw: "{{request.method}} {{request.path}}" }, delay: 60000 }]
      }
      const result = await preview(id, candidate)
      expect(result.matched).toBe(3)
      expect(result.total).toBe(4)
      expect(result.error).toBeUndefined()
      // The most recently seen group it matches; the delay is not waited out
      expect(result.sample).toEqual({
        request: { method: "POST", path: "/missing" },
        response: {
          status: 418,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ saw: "POST /missing" })
        }
      })
      // A preview adds nothing
      expect(await listStubIds(id)).toHaveLength(1)
      expect((await httpGet(9465, "/missing")).status).toBe(404)

      // Once a stub answers /other, its group is no longer unmatched traffic
      await addStub(id, { predicates: pathIs("/other"), responses: [{ status: 200 }] })
      expect(await preview(id, { responses: [{ status: 200 }] })).toMatchObject({ matched: 4, total: 4 })

      // An invalid regex is reported, not a 500
      const invalid = await preview(id, {
        predicates: [{ field: "path", operator: "matches", value: "(" }],
        responses: [{ status: 200 }]
      })
      expect(invalid).toMatchObject({ matched: 0, total: 4, error: expect.stringMatching(/regular expression/i) })
    })
  })

  it("answers 404 for an unknown imposter and 400 for an invalid stub", async () => {
    const imp = await createImposter({ port: 9466 })
    try {
      // Never started: nothing unmatched yet
      expect(await preview(imp.id, { responses: [{ status: 200 }] })).toEqual({ matched: 0, total: 0 })
      expect(await raw("POST", "/imposters/nope/stubs/preview", { responses: [{ status: 200 }] })).toMatchObject({
        status: 404,
        body: { resourceType: "imposter", resourceId: "nope" }
      })
      expect((await raw("POST", `/imposters/${imp.id}/stubs/preview`, { responses: [] })).status).toBe(400)
      expect((await raw("POST", `/imposters/${imp.id}/stubs/preview`, { responses: [{ status: "ok" }] })).status)
        .toBe(400)
    } finally {
      await remove(imp.id)
    }
  })
})

describe("E2E: OpenAPI", () => {
  it("documents the preview and explain endpoints and the index in addStub's body", async () => {
    const response = await server.handler(new Request("http://localhost/openapi.json"))
    const spec: unknown = await response.json()
    const text = JSON.stringify(spec)
    expect(text).toContain("/imposters/{imposterId}/stubs/preview")
    expect(text).toContain("/imposters/{id}/requests/{requestId}/explain")
    // addStub's body schema has the index; it is not a query parameter
    expect(text).not.toMatch(/"name":"index"/)
    expect(text).toMatch(/"index":\{[^}]*"type":"integer"/)
  })
})
