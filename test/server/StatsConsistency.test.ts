import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { ImposterConfig } from "imposters/domain/imposter"
import { Extensions, type ImposterExtension } from "imposters/extensions/Extension"
import { ImposterRepository, ImposterRepositoryLive } from "imposters/repositories/ImposterRepository"
import { Stub, UpdateStubRequest } from "imposters/schemas/StubSchema"
import { FiberManager, FiberManagerLive } from "imposters/server/FiberManager"
import { ImposterServer, ImposterServerLive, type ImposterServerShape } from "imposters/server/ImposterServer"
import { ServerFactory } from "imposters/server/ServerFactory"
import { StubChange } from "imposters/server/StubChange"
import { MetricsService, MetricsServiceLive } from "imposters/services/MetricsService"
import { ProxyServiceLive } from "imposters/services/ProxyService"
import { RequestLogger, RequestLoggerLive } from "imposters/services/RequestLogger"
import { UuidLive } from "imposters/services/UuidLive"
import { afterAll, afterEach, describe, expect, it } from "vitest"

// Races between a request in flight and a stub change or restart, made deterministic: no socket
// is bound (the server factory hands the test each imposter's fetch handler), and the test parks
// a request or a stub change at a chosen point with gates it opens itself.

// A point an effect stops at: it completes `reached`, then waits for the test to complete `release`
interface Gate {
  readonly reached: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}
const makeGate = (): Gate => ({ reached: Deferred.makeUnsafe(), release: Deferred.makeUnsafe() })
const pass = (gate: Gate) => Effect.andThen(Deferred.succeed(gate.reached, undefined), Deferred.await(gate.release))

// Each gate is used once: whatever reaches its point first takes it
let gateNextGetStubs: Gate | undefined
let gateGetStubsAfterUpdate: Gate | undefined
// The repository read after the change's own reload: the /_admin UI's read for rendering
let gateNextLog: Gate | undefined
let gateNextExtension: Gate | undefined
let gateAfterFiberStop: Gate | undefined
let gateNextResetStats: Gate | undefined
afterEach(() => {
  gateNextGetStubs = undefined
  gateGetStubsAfterUpdate = undefined
  gateNextLog = undefined
  gateNextExtension = undefined
  gateAfterFiberStop = undefined
  gateNextResetStats = undefined
})

const takeAndPass = (gate: Gate | undefined): Effect.Effect<void> => gate === undefined ? Effect.void : pass(gate)

// stop() parks once the imposter's fiber is gone, before the rest of stop runs
const GatedFiberManager = Layer.effect(
  FiberManager,
  Effect.gen(function*() {
    const live = yield* FiberManager
    return {
      ...live,
      stop: (id: string) =>
        live.stop(id).pipe(Effect.andThen(Effect.suspend(() => {
          const gate = gateAfterFiberStop
          gateAfterFiberStop = undefined
          return takeAndPass(gate)
        })))
    }
  })
).pipe(Layer.provide(FiberManagerLive))

// An extension whose answer can be held, parking a request before it is logged or counted
const GatedExtension: ImposterExtension = {
  protocol: "GATED",
  make: () =>
    Effect.succeed({
      handle: () =>
        Effect.suspend(() => {
          const gate = gateNextExtension
          gateNextExtension = undefined
          return takeAndPass(gate)
        }).pipe(Effect.as(new Response("gated")))
    })
}

// getStubs reads first and then waits, so it returns what the repository held when it got there
const GatedRepository = Layer.effect(
  ImposterRepository,
  Effect.gen(function*() {
    const live = yield* ImposterRepository
    return {
      ...live,
      getStubs: (id: string) =>
        live.getStubs(id).pipe(Effect.tap(() => {
          const gate = gateNextGetStubs
          gateNextGetStubs = undefined
          return gate === undefined ? Effect.void : pass(gate)
        })),
      updateStub: (imposterId: string, stubId: string, fn: (s: Stub) => Stub) =>
        live.updateStub(imposterId, stubId, fn).pipe(Effect.tap(() =>
          Effect.sync(() => {
            if (gateGetStubsAfterUpdate !== undefined) {
              gateNextGetStubs = gateGetStubsAfterUpdate
              gateGetStubsAfterUpdate = undefined
            }
          })
        ))
    }
  })
).pipe(Layer.provide(ImposterRepositoryLive))

// log runs after the response is built and before the request is counted in the stats
const GatedRequestLogger = Layer.effect(
  RequestLogger,
  Effect.gen(function*() {
    const live = yield* RequestLogger
    return {
      ...live,
      log: (entry: Parameters<typeof live.log>[0]) =>
        live.log(entry).pipe(Effect.tap(() => {
          const gate = gateNextLog
          gateNextLog = undefined
          return gate === undefined ? Effect.void : pass(gate)
        }))
    }
  })
).pipe(Layer.provide(RequestLoggerLive))

// resetStats waits before it resets, so a request answered while it is parked is recorded first
const GatedMetricsService = Layer.effect(
  MetricsService,
  Effect.gen(function*() {
    const live = yield* MetricsService
    return {
      ...live,
      resetStats: (imposterId: string) =>
        Effect.suspend(() => {
          const gate = gateNextResetStats
          gateNextResetStats = undefined
          return takeAndPass(gate)
        }).pipe(Effect.andThen(live.resetStats(imposterId)))
    }
  })
).pipe(Layer.provide(MetricsServiceLive))

const handlers = new Map<number, (request: Request) => Promise<Response>>()
const CapturingServerFactory = Layer.succeed(ServerFactory)({
  create: ({ fetch, port }) =>
    Effect.sync(() => {
      handlers.set(port, fetch)
      return { port, host: "127.0.0.1", stop: () => Effect.void }
    })
})

const TestLayer = ImposterServerLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      GatedFiberManager,
      GatedRepository,
      CapturingServerFactory,
      GatedRequestLogger,
      GatedMetricsService,
      ProxyServiceLive.pipe(Layer.provide(UuidLive)),
      Extensions.layer([GatedExtension])
    )
  )
)

const runtime = ManagedRuntime.make(TestLayer)
afterAll(async () => {
  await runtime.dispose()
})

const run = <A, E>(effect: Effect.Effect<A, E, ImposterServer | ImposterRepository | MetricsService>) =>
  runtime.runPromise(effect)

const decodeStub = Schema.decodeUnknownSync(Stub)
const decodePatch = Schema.decodeUnknownSync(UpdateStubRequest)

let nextPort = 1
// A started imposter with one stub `s` on `path`; the port is only the key of its handler
const startImposter = async (id: string, path: string, responses: ReadonlyArray<unknown>, protocol = "HTTP") => {
  const port = nextPort++
  await run(Effect.gen(function*() {
    const repo = yield* ImposterRepository
    yield* repo.create(
      ImposterConfig({ id, name: id, port, protocol, status: "stopped", createdAt: DateTime.nowUnsafe() })
    )
    yield* repo.addStub(
      id,
      decodeStub({ id: "s", predicates: [{ field: "path", operator: "equals", value: path }], responses })
    )
    yield* (yield* ImposterServer).start(id)
  }))
  const send = (init?: RequestInit & { readonly path?: string }) => {
    const handler = handlers.get(port)
    if (handler === undefined) throw new Error(`no handler on ${port}`)
    return handler(new Request(`http://127.0.0.1:${port}${init?.path ?? path}`, init))
  }
  return { send }
}

const changeStub = (id: string, patch: Record<string, unknown>) =>
  run(Effect.gen(function*() {
    return yield* (yield* ImposterServer).applyStubChange(
      id,
      StubChange.Update({ stubId: "s", patch: decodePatch(patch) })
    )
  }))

const statsOf = (id: string) =>
  run(Effect.gen(function*() {
    return yield* (yield* MetricsService).getStats(id)
  }))
const nextIndex = (id: string) =>
  run(Effect.gen(function*() {
    return yield* (yield* ImposterServer).nextResponseIndex(id, "s")
  }))
const reached = (gate: Gate) => runtime.runPromise(Deferred.await(gate.reached))
const release = (gate: Gate) => runtime.runPromise(Deferred.succeed(gate.release, undefined))

describe("stats stay consistent with what was served", () => {
  // Finding 1: counters and cycle were reset before the running server had the new stubs
  it("a request in the gap of a stub change is not counted against the new version", async () => {
    const id = "race-change-gap"
    const imp = await startImposter(id, "/c", [{ status: 200 }, { status: 201 }])
    const gate = makeGate()
    gateGetStubsAfterUpdate = gate

    // Park the change after the repository write, before the running server reloads
    const change = changeStub(id, { responses: [{ status: 210 }, { status: 211 }] })
    await reached(gate)
    // The server still holds the old stub, so the old one answers
    expect((await imp.send()).status).toBe(200)
    await release(gate)
    await change

    expect((await statsOf(id)).stubs.has("s")).toBe(false)
    expect(await nextIndex(id)).toEqual(Option.some(0))
    expect((await imp.send()).status).toBe(210)
  })

  // Finding 2: the stub list was read before the request body was awaited
  it("a request whose body is still uploading is matched against the stubs current when it is read", async () => {
    const id = "race-slow-body"
    const imp = await startImposter(id, "/b", [{ status: 200 }])
    const bodyRead = Deferred.makeUnsafe<void>()
    const bodyRelease = Deferred.makeUnsafe<void>()
    const body = new ReadableStream<Uint8Array>({
      // Called only once the handler reads the body (highWaterMark 0 below)
      pull: (controller) =>
        runtime.runPromise(
          Effect.andThen(Deferred.succeed(bodyRead, undefined), Deferred.await(bodyRelease))
        ).then(() => {
          controller.enqueue(new TextEncoder().encode("payload"))
          controller.close()
        })
    }, { highWaterMark: 0 })

    // Node needs `duplex` for a stream body; DOM's RequestInit type does not list it yet
    const init = { method: "POST", body, duplex: "half" }
    const response = imp.send(init)
    await runtime.runPromise(Deferred.await(bodyRead))
    await changeStub(id, { responses: [{ status: 201 }] })
    await runtime.runPromise(Deferred.succeed(bodyRelease, undefined))
    expect((await response).status).toBe(201)
  })

  // Finding 3: a hit in flight across a change was recorded against the new version
  it("a hit in flight when the stub's responses change is not counted against the new version", async () => {
    const id = "race-inflight-change"
    const imp = await startImposter(id, "/s", [{ status: 200 }, { status: 201 }])
    expect((await imp.send()).status).toBe(200)

    const gate = makeGate()
    gateNextLog = gate
    const inFlight = imp.send()
    await reached(gate)
    await changeStub(id, { responses: [{ status: 299 }] })
    await release(gate)
    expect((await inFlight).status).toBe(201)

    const stats = await statsOf(id)
    // Counted in the totals, but not as a hit on the one-response version (byResponse would be [0, 1])
    expect(stats.totalRequests).toBe(2)
    expect(stats.stubs.has("s")).toBe(false)
  })

  it("a hit in flight when its stub is deleted does not bring the stub's counters back", async () => {
    const id = "race-inflight-delete"
    const imp = await startImposter(id, "/d", [{ status: 200 }])
    const gate = makeGate()
    gateNextLog = gate
    const inFlight = imp.send()
    await reached(gate)
    await run(Effect.gen(function*() {
      yield* (yield* ImposterServer).applyStubChange(id, StubChange.Remove({ stubId: "s" }))
    }))
    await release(gate)
    expect((await inFlight).status).toBe(200)

    const stats = await statsOf(id)
    expect(stats.totalRequests).toBe(1)
    expect(stats.stubs.has("s")).toBe(false)
  })

  // Finding 4: a request from the previous run landed in the new run's stats
  it("a request in flight across a restart is not counted in the new run", async () => {
    const id = "race-restart"
    const imp = await startImposter(id, "/r", [{ status: 200 }])
    const gate = makeGate()
    gateNextLog = gate
    const inFlight = imp.send()
    await reached(gate)
    await run(Effect.gen(function*() {
      const server = yield* ImposterServer
      yield* server.stop(id)
      yield* server.start(id)
    }))
    await release(gate)
    expect((await inFlight).status).toBe(200)

    const stats = await statsOf(id)
    expect(stats.totalRequests).toBe(0)
    expect(stats.stubs.has("s")).toBe(false)
  })

  // Two changes reloaded out of order, leaving the server on the older stub list (and, before that,
  // the "before" stub was read apart from the write). Changes now hold one lock, so B waits for A.
  // Without the lock B runs to completion while A is parked: its fiber is started before the
  // release and has no asynchronous step of its own, so the scheduler runs it first.
  it("concurrent edits apply in order and a predicate-only one keeps the counters a responses edit started", async () => {
    const id = "race-concurrent-puts"
    const imp = await startImposter(id, "/a", [{ status: 200 }])
    const gate = makeGate()
    gateGetStubsAfterUpdate = gate

    // A: predicates only, parked at its reload after its repository write
    const predicateEdit = changeStub(id, { predicates: [{ field: "path", operator: "startsWith", value: "/a" }] })
    await reached(gate)
    // B: new responses, started while A is parked (it waits for A to finish)
    const responsesEdit = changeStub(id, { responses: [{ status: 201 }] })
    await release(gate)
    await Promise.all([predicateEdit, responsesEdit])

    // The server holds B's version, not the list A read before B wrote
    expect((await imp.send()).status).toBe(201)
    expect((await statsOf(id)).stubs.get("s")).toMatchObject({ hits: 1, byResponse: [1] })
  })
})

describe("restarts and aborted changes do not lose or leak state", () => {
  const server = <A>(f: (s: ImposterServerShape) => Effect.Effect<A, unknown>) =>
    run(Effect.gen(function*() {
      return yield* f(yield* ImposterServer)
    }))
  const logOf = (id: string) =>
    runtime.runPromise(Effect.gen(function*() {
      return yield* (yield* RequestLogger).getEntries(id)
    }))

  // A request in flight across a stop was written to the log stop had just cleared
  it("a request in flight across a stop is not written to the request log", async () => {
    const id = "race-stop-log"
    const imp = await startImposter(id, "/stubbed", [{ status: 200 }], "GATED")
    const gate = makeGate()
    gateNextExtension = gate
    const inFlight = imp.send({ path: "/to-the-extension" })
    await reached(gate)
    await server((s) => s.stop(id))
    await release(gate)
    expect(await (await inFlight).text()).toBe("gated")

    expect(await logOf(id)).toEqual([])
    expect((await statsOf(id)).totalRequests).toBe(0)
  })

  // stop dropped the registration after the fiber was gone, so a start in between lost it
  it("a start that runs while a stop finishes keeps hot reload and its stats", async () => {
    const id = "race-stop-start"
    const imp = await startImposter(id, "/h", [{ status: 200 }])
    const gate = makeGate()
    gateAfterFiberStop = gate
    const stopping = server((s) => s.stop(id))
    await reached(gate)
    await server((s) => s.start(id))
    await release(gate)
    await stopping

    // The new run is still registered: a stub change reaches it, and its requests are counted
    await changeStub(id, { responses: [{ status: 202 }] })
    expect((await imp.send()).status).toBe(202)
    expect((await statsOf(id)).stubs.get("s")).toMatchObject({ hits: 1, byResponse: [1] })
  })

  // start registered the new run and then reset its stats, so a request answered in between was
  // logged and counted, then wiped from the stats alone. Now the reset comes first, and a request
  // in the gap is answered by the bound but unregistered server and recorded in neither.
  it("a request answered while a restart resets the stats is in both the log and the stats, or neither", async () => {
    const id = "race-restart-reset"
    const imp = await startImposter(id, "/g", [{ status: 200 }])
    expect((await imp.send()).status).toBe(200)
    await server((s) => s.stop(id))

    const gate = makeGate()
    gateNextResetStats = gate
    // start resolves only once the run is ready, which is after the reset, so do not await it yet
    const starting = server((s) => s.start(id))
    await reached(gate)
    // The new server is bound (its handler is captured) while the reset is parked
    expect((await imp.send()).status).toBe(200)
    await release(gate)
    await starting

    const logged = (await logOf(id)).length
    expect((await statsOf(id)).totalRequests).toBe(logged)
    // After the restart the run serves and records normally
    expect((await imp.send()).status).toBe(200)
    expect(await logOf(id)).toHaveLength(logged + 1)
    expect((await statsOf(id)).totalRequests).toBe(logged + 1)
  })

  // A caller that went away after the repository write left the server and counters behind it
  it("a stub change interrupted after its repository write is still applied in full", async () => {
    const id = "race-interrupted-change"
    const imp = await startImposter(id, "/i", [{ status: 200 }, { status: 201 }])
    expect((await imp.send()).status).toBe(200)
    const gate = makeGate()
    gateGetStubsAfterUpdate = gate

    const change = runtime.runFork(Effect.gen(function*() {
      return yield* (yield* ImposterServer).applyStubChange(
        id,
        StubChange.Update({ stubId: "s", patch: decodePatch({ responses: [{ status: 299 }] }) })
      )
    }))
    await reached(gate)
    // Interrupting waits for the fiber to end, so do not await it before the gate opens
    const interrupted = runtime.runPromise(Fiber.interrupt(change))
    await release(gate)
    await interrupted

    expect((await imp.send()).status).toBe(299)
    expect((await statsOf(id)).stubs.get("s")).toMatchObject({ hits: 1, byResponse: [1] })
  })

  // The UI once re-read the repository after its change and wrote that list into the server
  // outside the lock, so an API change made in between was overwritten. Now a UI save goes
  // through applyStubChange, under the API's lock, and the UI only reads the stubs to render.
  it("a UI save and an API change made meanwhile apply in order, and neither is lost", async () => {
    const id = "race-ui-reload"
    const imp = await startImposter(id, "/u", [{ status: 200 }])
    const gate = makeGate()
    gateGetStubsAfterUpdate = gate

    // UI: the whole stub with new predicates, parked inside applyStubChange (holding the lock)
    const uiSave = imp.send({
      path: "/_admin/stubs/s",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-imposters-fragment": "1" },
      body: new URLSearchParams({
        stub: JSON.stringify({
          predicates: [{ field: "path", operator: "startsWith", value: "/u" }],
          responses: [{ status: 200 }]
        })
      }).toString()
    })
    await reached(gate)
    // API: new responses, queued behind the UI's save
    const apiChange = changeStub(id, { responses: [{ status: 201 }] })
    await release(gate)
    expect((await uiSave).status).toBe(200)
    await apiChange

    expect((await imp.send()).status).toBe(201)
    expect((await imp.send({ path: "/u-and-more" })).status).toBe(201)
  })
})
