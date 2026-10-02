import { Effect, ManagedRuntime } from "effect"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { ImpostersClient, type ImpostersClientShape } from "imposters/client/ImpostersClient"
import { makeTestServer } from "imposters/client/testing"
import { CreateImposterRequest } from "imposters/schemas/ImposterSchema"
import { CreateStubRequest, UpdateStubRequest } from "imposters/schemas/StubSchema"
import { httpGet } from "imposters/test/helpers/net"
import { EchoExtension } from "imposters/test/helpers/TestExtensions"
import { afterAll, describe, expect, it } from "vitest"

// Ports 9341-9348 belong to this file (9349 to test/server/StubChangeResets.test.ts).

const server = makeTestServer({ extensions: [EchoExtension] })
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
const decodePatch = Schema.decodeUnknownSync(UpdateStubRequest)

const createImposter = (fields: Record<string, unknown>) =>
  api((c) => c.imposters.createImposter({ payload: decodeImposter(fields) }))

const addStub = (imposterId: string, stub: Record<string, unknown>) =>
  api((c) => c.imposters.addStub({ params: { imposterId }, payload: decodeStub(stub) }))

const setStatus = (id: string, status: "running" | "stopped") =>
  api((c) => c.imposters.updateImposter({ params: { id }, payload: { status } }))

const stats = (id: string) => api((c) => c.imposters.getImposterStats({ params: { id } }))

const requests = (id: string) => api((c) => c.imposters.listRequests({ params: { id }, query: { limit: 100 } }))

const remove = (id: string) => api((c) => c.imposters.deleteImposter({ params: { id }, query: { force: true } }))

const pathIs = (path: string) => [{ field: "path", operator: "equals", value: path }]

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

describe("E2E: imposter stats (typed client)", () => {
  it("counts hits per response, the next response, unmatched groups and a 15-minute timeline", async () => {
    const before = DateTime.nowUnsafe()
    await withRunning({ port: 9341 }, [
      { predicates: pathIs("/orders"), responses: [{ status: 200 }, { status: 503 }] },
      { predicates: pathIs("/dice"), responses: [{ status: 200 }, { status: 201 }], responseMode: "random" }
    ], async (id, [orders, dice]) => {
      expect((await httpGet(9341, "/orders")).status).toBe(200)
      expect((await httpGet(9341, "/orders")).status).toBe(503)
      expect((await httpGet(9341, "/orders")).status).toBe(200)
      expect((await httpGet(9341, "/missing")).status).toBe(404)
      expect((await httpGet(9341, "/missing")).status).toBe(404)
      expect((await fetch("http://127.0.0.1:9341/missing", { method: "POST" })).status).toBe(404)

      const s = await stats(id)
      expect(s.totalRequests).toBe(6)
      // 4xx and 5xx (4 of 6) vs 5xx only (1 of 6)
      expect(s.errorRate).toBe(0.6667)
      expect(s.serverErrorRate).toBe(0.1667)

      expect(s.stubs).toHaveLength(2)
      expect(s.stubs[0]).toMatchObject({ stubId: orders, hits: 3, byResponse: [2, 1], nextResponseIndex: 1 })
      expect(s.stubs[0]?.lastHitAt).toSatisfy(DateTime.isDateTime)
      // Never hit, and random: no next response
      expect(s.stubs[1]).toEqual({ stubId: dice, hits: 0, byResponse: [0, 0] })

      expect(s.unmatched).toHaveLength(2)
      expect(s.unmatched).toContainEqual(expect.objectContaining({ method: "GET", path: "/missing", count: 2 }))
      expect(s.unmatched).toContainEqual(expect.objectContaining({ method: "POST", path: "/missing", count: 1 }))
      for (const group of s.unmatched) {
        expect(DateTime.toEpochMillis(group.lastSeenAt)).toBeGreaterThanOrEqual(DateTime.toEpochMillis(before))
      }

      expect(s.timeline).toHaveLength(30)
      const first = DateTime.toEpochMillis(s.timeline[0]?.start ?? before)
      const last = DateTime.toEpochMillis(s.timeline[29]?.start ?? before)
      expect(last - first).toBe(29 * 30_000)
      expect(last).toBeLessThanOrEqual(Date.now())
      expect(last + 30_000).toBeGreaterThan(DateTime.toEpochMillis(before))
      expect(s.last15Minutes).toEqual({ requests: 6, serverErrors: 1, unmatched: 3 })

      // The log says what answered each request, and which response a stub gave
      const log = await requests(id)
      const ordersLog = log.filter((e) => e.request.path === "/orders")
      expect(ordersLog.map((e) => [e.response.outcome, e.response.responseIndex])).toEqual([
        ["stub", 0],
        ["stub", 1],
        ["stub", 0]
      ])
      const missing = log.filter((e) => e.request.path === "/missing")
      expect(missing).toHaveLength(3)
      for (const e of missing) {
        expect(e.response.outcome).toBe("unmatched")
        expect(e.response.responseIndex).toBeUndefined()
        expect(e.response.proxied).toBe(false)
      }
    })
  })

  it("logs proxy and extension outcomes, which are not unmatched; ?stats=true fills statistics", async () => {
    await withRunning(
      { port: 9342 },
      [{ predicates: [], responses: [{ status: 200, body: "upstream" }] }],
      async (upstream) => {
        await withRunning({ port: 9343, proxy: { targetUrl: "http://127.0.0.1:9342" } }, [], async (proxyId) => {
          await withRunning({ port: 9344, protocol: "ECHO" }, [], async (echoId) => {
            const proxied = await httpGet(9343, "/via-proxy")
            expect(proxied).toMatchObject({ status: 200, body: "upstream" })
            expect((await httpGet(9344, "/echoed")).status).toBe(200)

            const [proxyEntry] = await requests(proxyId)
            expect(proxyEntry?.response).toMatchObject({ outcome: "proxy", proxied: true })
            expect(proxyEntry?.response.responseIndex).toBeUndefined()
            const [echoEntry] = await requests(echoId)
            expect(echoEntry?.response).toMatchObject({ outcome: "extension", proxied: false })
            const [upstreamEntry] = await requests(upstream)
            expect(upstreamEntry?.response).toMatchObject({ outcome: "stub", responseIndex: 0 })

            for (const id of [proxyId, echoId]) {
              const s = await stats(id)
              expect(s.totalRequests).toBe(1)
              expect(s.unmatched).toEqual([])
              expect(s.last15Minutes).toEqual({ requests: 1, serverErrors: 0, unmatched: 0 })
            }

            const withStats = await api((c) =>
              c.imposters.listImposters({ query: { limit: 50, offset: 0, stats: true } })
            )
            const statsOf = (id: string) => withStats.imposters.find((imp) => imp.id === id)?.statistics
            expect(statsOf(proxyId)?.totalRequests).toBe(1)
            expect(statsOf(echoId)?.timeline).toHaveLength(30)
            expect(statsOf(upstream)?.stubs[0]).toMatchObject({ hits: 1, byResponse: [1], nextResponseIndex: 0 })

            const plain = await api((c) => c.imposters.listImposters({ query: { limit: 50, offset: 0 } }))
            for (const imp of plain.imposters) expect(imp.statistics).toBeUndefined()
          })
        })
      }
    )
  })
})

describe("E2E: what resets the stats", () => {
  const updateStub = (imposterId: string, stubId: string, patch: Record<string, unknown>) =>
    api((c) => c.imposters.updateStub({ params: { imposterId, stubId }, payload: decodePatch(patch) }))

  const stubStats = async (id: string, stubId: string) => (await stats(id)).stubs.find((s) => s.stubId === stubId)

  it("API: a predicate-only edit keeps a stub's counters and cycle; new responses or mode reset both", async () => {
    const responses = [{ status: 200 }, { status: 201 }, { status: 202 }]
    await withRunning({ port: 9345 }, [{ predicates: pathIs("/r"), responses }], async (id, [sid = ""]) => {
      await httpGet(9345, "/r")
      await httpGet(9345, "/r")
      expect(await stubStats(id, sid)).toMatchObject({ hits: 2, byResponse: [1, 1, 0], nextResponseIndex: 2 })

      // Predicates only (and the same responses sent again): nothing resets, the cycle carries on
      await updateStub(id, sid, { predicates: pathIs("/r2"), responses })
      expect(await stubStats(id, sid)).toMatchObject({ hits: 2, byResponse: [1, 1, 0], nextResponseIndex: 2 })
      expect((await httpGet(9345, "/r2")).status).toBe(202)

      // New responses: counters and cycle start over
      await updateStub(id, sid, { responses: [{ status: 210 }, { status: 211 }] })
      expect(await stubStats(id, sid)).toEqual({ stubId: sid, hits: 0, byResponse: [0, 0], nextResponseIndex: 0 })
      expect((await httpGet(9345, "/r2")).status).toBe(210)
      expect(await stubStats(id, sid)).toMatchObject({ hits: 1, nextResponseIndex: 1 })

      // A new responseMode alone resets too
      await updateStub(id, sid, { responseMode: "repeat" })
      expect(await stubStats(id, sid)).toEqual({ stubId: sid, hits: 0, byResponse: [0, 0], nextResponseIndex: 0 })
      expect((await httpGet(9345, "/r2")).status).toBe(210)

      // DELETE /stats clears every count; the response cycle is behaviour, not stats, so it carries on
      await httpGet(9345, "/nothing-here")
      await api((c) => c.imposters.resetImposterStats({ params: { id } }))
      const cleared = await stats(id)
      expect(cleared.totalRequests).toBe(0)
      expect(cleared.unmatched).toEqual([])
      expect(cleared.last15Minutes).toEqual({ requests: 0, serverErrors: 0, unmatched: 0 })
      expect(cleared.stubs).toEqual([{ stubId: sid, hits: 0, byResponse: [0, 0], nextResponseIndex: 1 }])

      // Deleting the stub drops its row
      await api((c) => c.imposters.deleteStub({ params: { imposterId: id, stubId: sid } }))
      expect((await stats(id)).stubs).toEqual([])
    })
  })

  it("/_admin UI: stub edits and deletes go through the same reset rules", async () => {
    const form = (method: string, fields: Record<string, string>): RequestInit => ({
      method,
      headers: { "content-type": "application/x-www-form-urlencoded", "hx-request": "true" },
      body: new URLSearchParams(fields).toString()
    })
    const ui = (path: string, init: RequestInit) => fetch(`http://127.0.0.1:9346/_admin${path}`, init)
    const responses = JSON.stringify([{ status: 200 }, { status: 201 }])

    await withRunning({ port: 9346 }, [
      { predicates: pathIs("/u"), responses: [{ status: 200 }, { status: 201 }] },
      { predicates: pathIs("/other"), responses: [{ status: 200 }] }
    ], async (id, [sid = "", otherId]) => {
      await httpGet(9346, "/u")
      await httpGet(9346, "/other")

      // The edit form sends every field; only the predicates differ, so nothing resets
      const keep = await ui(
        `/stubs/${sid}`,
        form("PUT", {
          predicates: JSON.stringify(pathIs("/u2")),
          responses,
          responseMode: "sequential"
        })
      )
      expect(keep.status).toBe(200)
      expect(await stubStats(id, sid)).toMatchObject({ hits: 1, byResponse: [1, 0], nextResponseIndex: 1 })

      const reset = await ui(`/stubs/${sid}`, form("PUT", { responses: JSON.stringify([{ status: 299 }]) }))
      expect(reset.status).toBe(200)
      expect(await stubStats(id, sid)).toEqual({ stubId: sid, hits: 0, byResponse: [0], nextResponseIndex: 0 })
      expect((await httpGet(9346, "/u2")).status).toBe(299)

      const deleted = await ui(`/stubs/${sid}`, { method: "DELETE", headers: { "hx-request": "true" } })
      expect(deleted.status).toBe(200)
      const after = await stats(id)
      expect(after.stubs.map((s) => s.stubId)).toEqual([otherId])
      expect(after.stubs[0]?.hits).toBe(1)
    })
  })

  it("starting an imposter starts its stats over; stopping keeps them", async () => {
    await withRunning(
      { port: 9347 },
      [{ predicates: [], responses: [{ status: 200 }, { status: 500 }] }],
      async (id, [stubId]) => {
        await httpGet(9347, "/a")
        await setStatus(id, "stopped")

        const stopped = await stats(id)
        expect(stopped.totalRequests).toBe(1)
        // A stopped imposter starts every cycle over, so its next answer is the first
        expect(stopped.stubs).toEqual([
          expect.objectContaining({ stubId, hits: 1, byResponse: [1, 0], nextResponseIndex: 0 })
        ])

        await setStatus(id, "running")
        const restarted = await stats(id)
        expect(restarted.totalRequests).toBe(0)
        expect(restarted.last15Minutes.requests).toBe(0)
        expect(restarted.stubs).toEqual([{ stubId, hits: 0, byResponse: [0, 0], nextResponseIndex: 0 }])
        expect((await httpGet(9347, "/a")).status).toBe(200)
      }
    )
  })
})
