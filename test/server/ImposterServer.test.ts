import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Schema from "effect/Schema"
import { afterAll, describe, expect, it } from "vitest"
import { ImposterConfig } from "imposters/domain/imposter.js"
import { ImposterRepository, ImposterRepositoryLive } from "imposters/repositories/ImposterRepository.js"
import { Stub } from "imposters/schemas/StubSchema.js"
import { FiberManagerLive } from "imposters/server/FiberManager.js"
import { ImposterServer, ImposterServerLive } from "imposters/server/ImposterServer.js"
import { NodeServerFactoryLive } from "imposters/test/helpers/NodeServerFactory.js"

const makeConfig = (id: string, port: number): ImposterConfig =>
  ImposterConfig({ id, name: id, port, status: "stopped", createdAt: DateTime.unsafeNow() })

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

const TestLayer = ImposterServerLive.pipe(
  Layer.provide(Layer.mergeAll(FiberManagerLive, ImposterRepositoryLive, NodeServerFactoryLive))
)

const FullLayer = Layer.mergeAll(
  ImposterRepositoryLive,
  FiberManagerLive,
  TestLayer
)

const runtime = ManagedRuntime.make(FullLayer)
afterAll(() => runtime.dispose())

type Deps = ImposterRepository | ImposterServer
const run = <A>(effect: Effect.Effect<A, unknown, Deps>) =>
  runtime.runPromise(effect)

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
        yield* Effect.sleep("200 millis")
      })
    )

    const { status, body } = await fetchJson("http://localhost:9101/anything")
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })

    await run(
      Effect.gen(function*() {
        const server = yield* ImposterServer
        yield* server.stop("imp-start-1")
        yield* Effect.sleep("50 millis")
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
        yield* Effect.sleep("200 millis")

        yield* server.stop("imp-stop-1")
        yield* Effect.sleep("100 millis")

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
        yield* Effect.sleep("200 millis")
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
        yield* Effect.sleep("50 millis")
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
        yield* Effect.sleep("200 millis")
      })
    )

    const { status, body } = await fetchJson("http://localhost:9104/nonexistent")
    expect(status).toBe(404)
    expect(body.error).toBe("No matching stub found")

    await run(
      Effect.gen(function*() {
        const server = yield* ImposterServer
        yield* server.stop("imp-404-1")
        yield* Effect.sleep("50 millis")
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
        yield* Effect.sleep("200 millis")
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
        yield* Effect.sleep("50 millis")
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
        yield* Effect.sleep("200 millis")

        const running = yield* repo.get("imp-status-1")
        expect(running.config.status).toBe("running")

        yield* server.stop("imp-status-1")
        yield* Effect.sleep("50 millis")

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
        yield* repo.addStub("imp-tpl-1", Schema.decodeUnknownSync(Stub)({
          id: "tpl-stub",
          predicates: [],
          responses: [{ status: 200, body: { greeting: "Hello {{request.query.name}}", method: "{{request.method}}" } }]
        }))

        yield* server.start("imp-tpl-1")
        yield* Effect.sleep("200 millis")
      })
    )

    const { body } = await fetchJson("http://localhost:9107/test?name=World")
    expect(body.greeting).toBe("Hello World")
    expect(body.method).toBe("GET")

    await run(
      Effect.gen(function*() {
        const server = yield* ImposterServer
        yield* server.stop("imp-tpl-1")
        yield* Effect.sleep("50 millis")
      })
    )
  }, 10000)
})
