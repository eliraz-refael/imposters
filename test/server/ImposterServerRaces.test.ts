import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import { ImposterConfig } from "imposters/domain/imposter"
import { Extensions } from "imposters/extensions/Extension"
import { ImposterRepository, ImposterRepositoryLive } from "imposters/repositories/ImposterRepository"
import { Stub } from "imposters/schemas/StubSchema"
import { FiberManager, FiberManagerLive } from "imposters/server/FiberManager"
import { ImposterServer, ImposterServerLive } from "imposters/server/ImposterServer"
import { ServerFactory } from "imposters/server/ServerFactory"
import { MetricsServiceLive } from "imposters/services/MetricsService"
import { OutboundHttpLive } from "imposters/services/OutboundHttp"
import { ProxyServiceLive } from "imposters/services/ProxyService"
import { RequestLoggerLive } from "imposters/services/RequestLogger"
import { UuidLive } from "imposters/services/UuidLive"
import { httpGet, probeConnect } from "imposters/test/helpers/net"
import { NodeServerFactoryLive } from "imposters/test/helpers/NodeServerFactory"
import { describe, expect, it } from "vitest"

// Regression tests for two races in ImposterServer.start. Each test gets its own
// runtime with a ServerFactory whose `create` runs a test-controlled `beforeBind`
// effect (a latch, a counter, a defect) and then delegates to the real Node
// factory. No sleeps: every ordering is forced by a Deferred or by the scheduler.
// Ports 9121-9129 belong to this file.

// Fails the test instead of stalling the suite if `start` hangs again.
const TIMEOUT = 5000

const makeConfig = (id: string, port: number, status: "running" | "stopped" = "stopped"): ImposterConfig =>
  ImposterConfig({ id, name: id, port, protocol: "HTTP", status, createdAt: DateTime.nowUnsafe() })

const makeCatchAllStub = (id: string, body: unknown) =>
  Schema.decodeUnknownSync(Stub)({ id, predicates: [], responses: [{ status: 200, body }] })

const makeGetStub = (id: string, path: string, body: unknown) =>
  Schema.decodeUnknownSync(Stub)({
    id,
    predicates: [
      { field: "method", operator: "equals", value: "GET" },
      { field: "path", operator: "equals", value: path }
    ],
    responses: [{ status: 200, body }]
  })

const controlledFactory = (beforeBind: (port: number) => Effect.Effect<void>) =>
  Layer.effect(
    ServerFactory,
    Effect.gen(function*() {
      const real = yield* ServerFactory
      return {
        create: (options: Parameters<typeof real.create>[0]) =>
          beforeBind(options.port).pipe(Effect.andThen(real.create(options)))
      }
    })
  ).pipe(Layer.provide(NodeServerFactoryLive))

// FiberMap.run forks with Effect.runForkWith, which runs the new fiber synchronously
// up to its first suspension, so with the real FiberManager a server fiber always
// reaches bind before anyone else can take the lock. This wrapper makes the forked
// fiber suspend first, so an interrupt that lands right after the fork skips its
// body entirely: the "interrupted before it first ran" exit that start must survive.
const DeferredStartFiberManager = Layer.effect(
  FiberManager,
  Effect.gen(function*() {
    const real = yield* FiberManager
    return {
      start: <E>(id: string, effect: Effect.Effect<never, E>) =>
        real.start(id, Effect.yieldNow.pipe(Effect.andThen(effect))),
      stop: real.stop,
      isRunning: real.isRunning
    }
  })
).pipe(Layer.provide(FiberManagerLive))

type Deps = ImposterRepository | ImposterServer

const runWith = async <A>(
  options: {
    readonly beforeBind: (port: number) => Effect.Effect<void>
    readonly fiberManager?: Layer.Layer<FiberManager>
  },
  effect: Effect.Effect<A, unknown, Deps>
): Promise<A> => {
  const layer = ImposterServerLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        options.fiberManager ?? FiberManagerLive,
        ImposterRepositoryLive,
        controlledFactory(options.beforeBind),
        RequestLoggerLive,
        MetricsServiceLive,
        ProxyServiceLive.pipe(
          Layer.provide(Layer.mergeAll(UuidLive, OutboundHttpLive.pipe(Layer.provide(MetricsServiceLive))))
        ),
        OutboundHttpLive.pipe(Layer.provide(MetricsServiceLive)),
        Extensions.layer([])
      )
    )
  )
  const runtime = ManagedRuntime.make(layer)
  try {
    return await runtime.runPromise(effect)
  } finally {
    await runtime.dispose()
  }
}

const httpJson = (port: number, path: string) =>
  Effect.promise(() => httpGet(port, path)).pipe(
    Effect.map((resp): { status: number; body: unknown } => ({ status: resp.status, body: JSON.parse(resp.body) }))
  )

describe("ImposterServer.start never hangs", () => {
  it("fails with ImposterServerError when bind dies with a defect", async () => {
    await runWith(
      { beforeBind: () => Effect.die(new Error("boom during bind")) },
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const server = yield* ImposterServer
        // Pre-set to running so the assertion below proves the failure path resets it
        yield* repo.create(makeConfig("imp-race-die", 9121, "running"))
        yield* repo.addStub("imp-race-die", makeCatchAllStub("s1", { ok: true }))

        const error = yield* server.start("imp-race-die").pipe(Effect.flip)
        expect(error._tag).toBe("ImposterServerError")
        if (error._tag === "ImposterServerError") {
          expect(error.imposterId).toBe("imp-race-die")
          expect(error.reason).toContain("Imposter server died while binding its port")
          expect(error.reason).toContain("boom during bind")
        }

        expect(yield* server.isRunning("imp-race-die")).toBe(false)
        expect((yield* repo.get("imp-race-die")).config.status).toBe("stopped")
        expect(yield* Effect.promise(() => probeConnect(9121))).toBe("refused")
      })
    )
  }, TIMEOUT)

  it("fails with ImposterServerError when stop interrupts the server fiber before it first runs", async () => {
    const binds = Ref.makeUnsafe(0)
    await runWith(
      { beforeBind: () => Ref.update(binds, (n) => n + 1), fiberManager: DeferredStartFiberManager },
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const server = yield* ImposterServer
        yield* repo.create(makeConfig("imp-race-stop", 9122))
        yield* repo.addStub("imp-race-stop", makeCatchAllStub("s1", { ok: true }))

        // startImmediately runs `start` synchronously up to its first suspension,
        // which is after the server fiber has been forked (but has not run) and
        // FiberManager's lock released. `stop` then takes the lock and interrupts
        // that fiber before it runs, so its body (and its onError) never executes.
        const starting = yield* Effect.forkChild(server.start("imp-race-stop"), { startImmediately: true })
        yield* server.stop("imp-race-stop")

        const error = yield* Fiber.join(starting).pipe(Effect.flip)
        expect(error._tag).toBe("ImposterServerError")
        if (error._tag === "ImposterServerError") {
          expect(error.reason).toBe("Imposter was stopped before its server started")
        }

        // The server fiber never reached bind: this was the interrupted-before-run exit
        expect(yield* Ref.get(binds)).toBe(0)
        expect(yield* server.isRunning("imp-race-stop")).toBe(false)
        expect((yield* repo.get("imp-race-stop")).config.status).toBe("stopped")
        expect(yield* Effect.promise(() => probeConnect(9122))).toBe("refused")
      })
    )
  }, TIMEOUT)

  it(
    "a second start that re-keys the fiber before it runs fails the first start and serves from the second",
    async () => {
      const binds = Ref.makeUnsafe(0)
      await runWith(
        { beforeBind: () => Ref.update(binds, (n) => n + 1), fiberManager: DeferredStartFiberManager },
        Effect.gen(function*() {
          const repo = yield* ImposterRepository
          const server = yield* ImposterServer
          yield* repo.create(makeConfig("imp-race-rekey", 9123))
          yield* repo.addStub("imp-race-rekey", makeCatchAllStub("s1", { ok: true }))

          const first = yield* Effect.forkChild(server.start("imp-race-rekey"), { startImmediately: true })
          yield* server.start("imp-race-rekey")

          const error = yield* Fiber.join(first).pipe(Effect.flip)
          expect(error._tag).toBe("ImposterServerError")
          if (error._tag === "ImposterServerError") {
            expect(error.reason).toBe("Imposter was stopped before its server started")
          }

          // Only the second start's fiber bound the port
          expect(yield* Ref.get(binds)).toBe(1)
          expect(yield* server.isRunning("imp-race-rekey")).toBe(true)
          expect((yield* repo.get("imp-race-rekey")).config.status).toBe("running")
          expect(yield* httpJson(9123, "/")).toEqual({ status: 200, body: { ok: true } })

          yield* server.stop("imp-race-rekey")
        })
      )
    },
    TIMEOUT
  )

  // With the real FiberManager the server fiber is already inside bind when stop
  // arrives, and acquireRelease runs bind uninterruptibly, so stop waits for the
  // bind to settle. start therefore succeeds, and stop then releases the port.
  it("stop issued while bind is in flight waits for it, then leaves nothing bound", async () => {
    const entered = Deferred.makeUnsafe<void>()
    const gate = Deferred.makeUnsafe<void>()
    await runWith(
      {
        beforeBind: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate)))
      },
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const server = yield* ImposterServer
        yield* repo.create(makeConfig("imp-race-inflight", 9127))
        yield* repo.addStub("imp-race-inflight", makeCatchAllStub("s1", { ok: true }))

        const starting = yield* Effect.forkChild(server.start("imp-race-inflight"), { startImmediately: true })
        yield* Deferred.await(entered)
        const stopping = yield* Effect.forkChild(server.stop("imp-race-inflight"), { startImmediately: true })
        // stop has interrupted the server fiber but cannot finish until bind settles
        expect(stopping.pollUnsafe()).toBeUndefined()

        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(starting)
        yield* Fiber.join(stopping)

        expect(yield* server.isRunning("imp-race-inflight")).toBe(false)
        expect((yield* repo.get("imp-race-inflight")).config.status).toBe("stopped")
        expect(yield* Effect.promise(() => probeConnect(9127))).toBe("refused")
      })
    )
  }, TIMEOUT)
})

describe("ImposterServer.start picks up changes made while it binds", () => {
  // Lets the first bind on `port` through and holds every later one on `gate`,
  // signalling `entered` once the held bind is waiting.
  const holdRestart = (port: number) => {
    const binds = Ref.makeUnsafe(0)
    const entered = Deferred.makeUnsafe<void>()
    const gate = Deferred.makeUnsafe<void>()
    const beforeBind = (p: number): Effect.Effect<void> =>
      p !== port ? Effect.void : Ref.getAndUpdate(binds, (n) => n + 1).pipe(
        Effect.andThen((n) =>
          n === 0 ? Effect.void : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate)))
        )
      )
    return { beforeBind, entered, gate }
  }

  it("updateStubs during a restart is served once start resolves", async () => {
    const { beforeBind, entered, gate } = holdRestart(9124)
    await runWith(
      { beforeBind },
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const server = yield* ImposterServer
        yield* repo.create(makeConfig("imp-race-stubs", 9124))
        yield* repo.addStub("imp-race-stubs", makeCatchAllStub("s1", { version: 1 }))
        yield* server.start("imp-race-stubs")
        expect(yield* httpJson(9124, "/")).toEqual({ status: 200, body: { version: 1 } })

        // Restart: start has read the repo and is now held inside bind, with no
        // hot-reload state registered for the imposter
        const restarting = yield* Effect.forkChild(server.start("imp-race-stubs"))
        yield* Deferred.await(entered)

        yield* repo.removeStub("imp-race-stubs", "s1")
        yield* repo.addStub("imp-race-stubs", makeCatchAllStub("s2", { version: 2 }))
        yield* server.updateStubs("imp-race-stubs")

        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(restarting)

        expect(yield* httpJson(9124, "/")).toEqual({ status: 200, body: { version: 2 } })
        yield* server.stop("imp-race-stubs")
      })
    )
  }, TIMEOUT)

  it("updateProxyConfig during a restart is served once start resolves", async () => {
    const { beforeBind, entered, gate } = holdRestart(9125)
    await runWith(
      { beforeBind },
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const server = yield* ImposterServer
        // Upstream the proxy will point at
        yield* repo.create(makeConfig("imp-race-upstream", 9126))
        yield* repo.addStub("imp-race-upstream", makeCatchAllStub("u1", { from: "upstream" }))
        yield* server.start("imp-race-upstream")

        yield* repo.create(makeConfig("imp-race-proxy", 9125))
        yield* repo.addStub("imp-race-proxy", makeGetStub("s1", "/local", { from: "local" }))
        yield* server.start("imp-race-proxy")
        expect((yield* httpJson(9125, "/other")).status).toBe(404)

        const restarting = yield* Effect.forkChild(server.start("imp-race-proxy"))
        yield* Deferred.await(entered)

        yield* repo.update("imp-race-proxy", (r) => ({
          ...r,
          config: ImposterConfig({
            ...r.config,
            proxy: {
              targetUrl: "http://127.0.0.1:9126",
              mode: "passthrough",
              removeHeaders: [],
              followRedirects: true,
              timeout: 2000
            }
          })
        }))
        yield* server.updateProxyConfig("imp-race-proxy")

        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(restarting)

        expect(yield* httpJson(9125, "/other")).toEqual({ status: 200, body: { from: "upstream" } })
        expect(yield* httpJson(9125, "/local")).toEqual({ status: 200, body: { from: "local" } })
        yield* server.stop("imp-race-proxy")
        yield* server.stop("imp-race-upstream")
      })
    )
  }, TIMEOUT)
})
