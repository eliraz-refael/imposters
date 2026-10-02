import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { ImposterConfig } from "imposters/domain/imposter"
import { Extensions } from "imposters/extensions/Extension"
import { ImposterRepository, ImposterRepositoryLive } from "imposters/repositories/ImposterRepository"
import { Stub, UpdateStubRequest } from "imposters/schemas/StubSchema"
import { FiberManagerLive } from "imposters/server/FiberManager"
import { ImposterServer, ImposterServerLive } from "imposters/server/ImposterServer"
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
let gateNextLog: Gate | undefined
afterEach(() => {
  gateNextGetStubs = undefined
  gateGetStubsAfterUpdate = undefined
  gateNextLog = undefined
})

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
      FiberManagerLive,
      GatedRepository,
      CapturingServerFactory,
      GatedRequestLogger,
      MetricsServiceLive,
      ProxyServiceLive.pipe(Layer.provide(UuidLive)),
      Extensions.layer([])
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
const startImposter = async (id: string, path: string, responses: ReadonlyArray<unknown>) => {
  const port = nextPort++
  await run(Effect.gen(function*() {
    const repo = yield* ImposterRepository
    yield* repo.create(
      ImposterConfig({ id, name: id, port, protocol: "HTTP", status: "stopped", createdAt: DateTime.nowUnsafe() })
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

  // Finding 5: the "before" stub was read apart from the write, so a concurrent edit skewed the comparison
  it("a predicate-only edit racing a responses edit does not reset the counters the latter started", async () => {
    const id = "race-concurrent-puts"
    const imp = await startImposter(id, "/a", [{ status: 200 }])
    const gate = makeGate()
    gateNextGetStubs = gate

    // A: predicates only, parked at its first repository read
    const predicateEdit = changeStub(id, { predicates: [{ field: "path", operator: "startsWith", value: "/a" }] })
    await reached(gate)
    // B: new responses, completed while A is parked; then a hit on B's version
    await changeStub(id, { responses: [{ status: 201 }] })
    expect((await imp.send()).status).toBe(201)
    await release(gate)
    await predicateEdit

    expect((await statsOf(id)).stubs.get("s")).toMatchObject({ hits: 1, byResponse: [1] })
  })
})
