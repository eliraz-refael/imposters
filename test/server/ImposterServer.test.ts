import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Schema from "effect/Schema"
import { ImposterConfig } from "imposters/domain/imposter"
import { Extensions } from "imposters/extensions/Extension"
import { ImposterRepository, ImposterRepositoryLive } from "imposters/repositories/ImposterRepository"
import { Stub } from "imposters/schemas/StubSchema"
import { FiberManagerLive } from "imposters/server/FiberManager"
import { ImposterServer, ImposterServerLive } from "imposters/server/ImposterServer"
import { MetricsServiceLive } from "imposters/services/MetricsService"
import { ProxyServiceLive } from "imposters/services/ProxyService"
import { RequestLoggerLive } from "imposters/services/RequestLogger"
import { UuidLive } from "imposters/services/UuidLive"
import { httpGet, occupyPort, probeConnect } from "imposters/test/helpers/net"
import { NodeServerFactoryLive } from "imposters/test/helpers/NodeServerFactory"
import { afterAll, describe, expect, it } from "vitest"

const makeConfig = (id: string, port: number): ImposterConfig =>
  ImposterConfig({ id, name: id, port, protocol: "HTTP", status: "stopped", createdAt: DateTime.nowUnsafe() })

const makeCatchAllStub = (id: string, status = 200, body?: unknown) =>
  Schema.decodeUnknownSync(Stub)({
    id,
    predicates: [],
    responses: [{ status, body }]
  })

const makeStub = (id: string, method: string, path: string, status = 200, body?: unknown) =>
  Schema.decodeUnknownSync(Stub)({
    id,
    predicates: [
      { field: "method", operator: "equals", value: method },
      { field: "path", operator: "equals", value: path }
    ],
    responses: [{ status, body }]
  })

const ProxyServiceWithDeps = ProxyServiceLive.pipe(Layer.provide(UuidLive))

const TestLayer = ImposterServerLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      FiberManagerLive,
      ImposterRepositoryLive,
      NodeServerFactoryLive,
      RequestLoggerLive,
      MetricsServiceLive,
      ProxyServiceWithDeps,
      Extensions.layer([])
    )
  )
)

const FullLayer = Layer.mergeAll(
  ImposterRepositoryLive,
  FiberManagerLive,
  TestLayer
)

const runtime = ManagedRuntime.make(FullLayer)
afterAll(() => runtime.dispose())

type Deps = ImposterRepository | ImposterServer
const run = <A>(effect: Effect.Effect<A, unknown, Deps>) => runtime.runPromise(effect)

const fetchJson = (url: string, init?: RequestInit) =>
  fetch(url, init).then(async (r) => ({ status: r.status, body: await r.json() }))

describe("ImposterServer", () => {
  it("start makes imposter reachable", async () => {
    await run(
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const server = yield* ImposterServer

        yield* repo.create(makeConfig("imp-start-1", 9101))
        yield* repo.addStub("imp-start-1", makeCatchAllStub("s1", 200, { ok: true }))

        yield* server.start("imp-start-1")
      })
    )

    const { body, status } = await fetchJson("http://localhost:9101/anything")
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })

    await run(
      Effect.gen(function*() {
        const server = yield* ImposterServer
        yield* server.stop("imp-start-1")
      })
    )
  }, 10000)

  it("stop makes port unreachable", async () => {
    await run(
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const server = yield* ImposterServer

        yield* repo.create(makeConfig("imp-stop-1", 9102))
        yield* repo.addStub("imp-stop-1", makeCatchAllStub("s1", 200))
        yield* server.start("imp-stop-1")

        yield* server.stop("imp-stop-1")

        const running = yield* server.isRunning("imp-stop-1")
        expect(running).toBe(false)
      })
    )
  }, 10000)

  it("matches stubs by method and path", async () => {
    await run(
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const server = yield* ImposterServer

        yield* repo.create(makeConfig("imp-match-1", 9103))
        yield* repo.addStub("imp-match-1", makeStub("get-users", "GET", "/users", 200, { users: [] }))
        yield* repo.addStub("imp-match-1", makeStub("post-users", "POST", "/users", 201, { created: true }))

        yield* server.start("imp-match-1")
      })
    )

    const get = await fetchJson("http://localhost:9103/users")
    expect(get.status).toBe(200)
    expect(get.body).toEqual({ users: [] })

    const post = await fetchJson("http://localhost:9103/users", { method: "POST" })
    expect(post.status).toBe(201)
    expect(post.body).toEqual({ created: true })

    await run(
      Effect.gen(function*() {
        const server = yield* ImposterServer
        yield* server.stop("imp-match-1")
      })
    )
  }, 10000)

  it("returns 404 when no stub matches", async () => {
    await run(
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const server = yield* ImposterServer

        yield* repo.create(makeConfig("imp-404-1", 9104))
        yield* repo.addStub("imp-404-1", makeStub("only-get", "GET", "/specific", 200))

        yield* server.start("imp-404-1")
      })
    )

    const { body, status } = await fetchJson("http://localhost:9104/nonexistent")
    expect(status).toBe(404)
    expect(body.error).toBe("No matching stub found")

    await run(
      Effect.gen(function*() {
        const server = yield* ImposterServer
        yield* server.stop("imp-404-1")
      })
    )
  }, 10000)

  it("updateStubs hot-reloads without restart", async () => {
    await run(
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const server = yield* ImposterServer

        yield* repo.create(makeConfig("imp-hot-1", 9105))
        yield* repo.addStub("imp-hot-1", makeCatchAllStub("s1", 200, { version: 1 }))

        yield* server.start("imp-hot-1")
      })
    )

    const r1 = await fetchJson("http://localhost:9105/test")
    expect(r1.body).toEqual({ version: 1 })

    await run(
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const server = yield* ImposterServer

        yield* repo.removeStub("imp-hot-1", "s1")
        yield* repo.addStub("imp-hot-1", makeCatchAllStub("s2", 200, { version: 2 }))
        yield* server.updateStubs("imp-hot-1")
      })
    )

    const r2 = await fetchJson("http://localhost:9105/test")
    expect(r2.body).toEqual({ version: 2 })

    await run(
      Effect.gen(function*() {
        const server = yield* ImposterServer
        yield* server.stop("imp-hot-1")
      })
    )
  }, 10000)

  it("updates repo status on start/stop", async () => {
    await run(
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const server = yield* ImposterServer

        yield* repo.create(makeConfig("imp-status-1", 9106))
        yield* repo.addStub("imp-status-1", makeCatchAllStub("s1", 200))

        const before = yield* repo.get("imp-status-1")
        expect(before.config.status).toBe("stopped")

        yield* server.start("imp-status-1")

        const running = yield* repo.get("imp-status-1")
        expect(running.config.status).toBe("running")

        yield* server.stop("imp-status-1")

        const stopped = yield* repo.get("imp-status-1")
        expect(stopped.config.status).toBe("stopped")
      })
    )
  }, 10000)

  it("template substitution in response body", async () => {
    await run(
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const server = yield* ImposterServer

        yield* repo.create(makeConfig("imp-tpl-1", 9107))
        yield* repo.addStub(
          "imp-tpl-1",
          Schema.decodeUnknownSync(Stub)({
            id: "tpl-stub",
            predicates: [],
            responses: [{
              status: 200,
              body: { greeting: "Hello {{request.query.name}}", method: "{{request.method}}" }
            }]
          })
        )

        yield* server.start("imp-tpl-1")
      })
    )

    const { body } = await fetchJson("http://localhost:9107/test?name=World")
    expect(body.greeting).toBe("Hello World")
    expect(body.method).toBe("GET")

    await run(
      Effect.gen(function*() {
        const server = yield* ImposterServer
        yield* server.stop("imp-tpl-1")
      })
    )
  }, 10000)
})

// The lifecycle contract: start resolves only once the port is bound, stop only
// once it is released. None of these tests sleep.
describe("ImposterServer lifecycle", () => {
  const setup = (id: string, port: number) =>
    Effect.gen(function*() {
      const repo = yield* ImposterRepository
      yield* repo.create(makeConfig(id, port))
      yield* repo.addStub(id, makeCatchAllStub("s1", 200, { id }))
    })

  it("a request issued as soon as start resolves succeeds", async () => {
    await run(
      Effect.gen(function*() {
        const server = yield* ImposterServer
        yield* setup("imp-life-1", 9111)
        yield* server.start("imp-life-1")
        const resp = yield* Effect.promise(() => httpGet(9111, "/"))
        expect(resp.status).toBe(200)
        expect(JSON.parse(resp.body)).toEqual({ id: "imp-life-1" })
        yield* server.stop("imp-life-1")
      })
    )
  }, 10000)

  it("a connection attempted as soon as stop resolves is refused", async () => {
    await run(
      Effect.gen(function*() {
        const server = yield* ImposterServer
        yield* setup("imp-life-2", 9112)
        yield* server.start("imp-life-2")
        expect(yield* Effect.promise(() => probeConnect(9112))).toBe("connected")
        yield* server.stop("imp-life-2")
        expect(yield* Effect.promise(() => probeConnect(9112))).toBe("refused")
      })
    )
  }, 10000)

  it("start, stop, start on the same port succeeds immediately", async () => {
    await run(
      Effect.gen(function*() {
        const server = yield* ImposterServer
        yield* setup("imp-life-3", 9113)
        yield* server.start("imp-life-3")
        yield* server.stop("imp-life-3")
        yield* server.start("imp-life-3")
        const resp = yield* Effect.promise(() => httpGet(9113, "/"))
        expect(resp.status).toBe(200)
        yield* server.stop("imp-life-3")
      })
    )
  }, 10000)

  it("start while already running restarts on the same port without EADDRINUSE", async () => {
    await run(
      Effect.gen(function*() {
        const server = yield* ImposterServer
        const repo = yield* ImposterRepository
        yield* setup("imp-life-4", 9114)
        yield* server.start("imp-life-4")
        // Re-keys the FiberMap entry: the old server must be released before the new bind
        yield* server.start("imp-life-4")
        const resp = yield* Effect.promise(() => httpGet(9114, "/"))
        expect(resp.status).toBe(200)
        expect(yield* server.isRunning("imp-life-4")).toBe(true)
        expect((yield* repo.get("imp-life-4")).config.status).toBe("running")
        yield* server.stop("imp-life-4")
      })
    )
  }, 10000)

  it("start on an occupied port fails with ImposterServerError and leaves no stale state", async () => {
    const release = await occupyPort(9115)
    try {
      await run(
        Effect.gen(function*() {
          const server = yield* ImposterServer
          const repo = yield* ImposterRepository
          yield* setup("imp-life-5", 9115)
          yield* repo.update(
            "imp-life-5",
            (r) => ({ ...r, config: ImposterConfig({ ...r.config, status: "running" }) })
          )

          const error = yield* server.start("imp-life-5").pipe(Effect.flip)
          expect(error._tag).toBe("ImposterServerError")
          if (error._tag === "ImposterServerError") {
            expect(error.imposterId).toBe("imp-life-5")
            expect(error.reason).toContain("Failed to bind port 9115")
            expect(error.reason).toContain("EADDRINUSE")
          }

          // No FiberMap entry, status flipped back to stopped
          expect(yield* server.isRunning("imp-life-5")).toBe(false)
          expect((yield* repo.get("imp-life-5")).config.status).toBe("stopped")
        })
      )
    } finally {
      await release()
    }

    // Once the port is free the same imposter starts cleanly
    await run(
      Effect.gen(function*() {
        const server = yield* ImposterServer
        yield* server.start("imp-life-5")
        const resp = yield* Effect.promise(() => httpGet(9115, "/"))
        expect(resp.status).toBe(200)
        yield* server.stop("imp-life-5")
      })
    )
  }, 10000)
})
