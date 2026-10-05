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
import { NodeServerFactoryLive, ServerFactory } from "imposters/server/ServerFactory"
import { MetricsServiceLive } from "imposters/services/MetricsService"
import { ProxyServiceLive } from "imposters/services/ProxyService"
import { RequestLogger, RequestLoggerLive } from "imposters/services/RequestLogger"
import { UuidLive } from "imposters/services/UuidLive"
import { httpGet, rawRequest } from "imposters/test/helpers/net"
import { afterAll, describe, expect, it, vi } from "vitest"

// The live page's server-sent events (GET /_admin/events), read over raw sockets so neither
// buffering nor a pooled connection hides when bytes arrive or when the stream ends.
// Ports 9021-9029 belong to this file.

// A server that never cancels a response body, even when the client is gone or the server stops
// (Bun may not): only the run's own shutdown signal can end a stream behind it
const uncancellable = (response: Response): Response => {
  if (response.body === null) return response
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const chunk = await reader.read()
      if (chunk.done) controller.close()
      else controller.enqueue(chunk.value)
    },
    cancel: () => undefined
  })
  return new Response(body, { status: response.status, headers: response.headers })
}

const NoCancelFactory = Layer.effect(
  ServerFactory,
  Effect.gen(function*() {
    const node = yield* ServerFactory
    return {
      create: (options) => node.create({ ...options, fetch: (request) => options.fetch(request).then(uncancellable) })
    }
  })
).pipe(Layer.provide(NodeServerFactoryLive))

const makeRuntime = (factory: Layer.Layer<ServerFactory>) => {
  const shared = Layer.mergeAll(ImposterRepositoryLive, RequestLoggerLive, MetricsServiceLive)
  const server = ImposterServerLive.pipe(
    Layer.provide(
      Layer.mergeAll(FiberManagerLive, factory, ProxyServiceLive.pipe(Layer.provide(UuidLive)), Extensions.layer([]))
    ),
    Layer.provideMerge(shared)
  )
  return ManagedRuntime.make(server)
}

const runtime = makeRuntime(NodeServerFactoryLive)
const noCancelRuntime = makeRuntime(NoCancelFactory)
afterAll(async () => {
  await runtime.dispose()
  await noCancelRuntime.dispose()
})

type Runtime = typeof runtime
type Deps = ImposterRepository | ImposterServer | RequestLogger

const startImposter = (rt: Runtime, id: string, port: number) =>
  rt.runPromise(Effect.gen(function*() {
    const repo = yield* ImposterRepository
    yield* repo.create(
      ImposterConfig({ id, name: id, port, protocol: "HTTP", status: "stopped", createdAt: DateTime.makeUnsafe(0) })
    )
    yield* repo.addStub(
      id,
      Schema.decodeUnknownSync(Stub)({
        id: "hello",
        predicates: [{ field: "path", operator: "equals", value: "/hello" }],
        responses: [{ status: 200, body: "hi" }]
      })
    )
    yield* (yield* ImposterServer).start(id)
  }))

const run = <A>(rt: Runtime, effect: Effect.Effect<A, never, Deps>) => rt.runPromise(effect)
const stop = (rt: Runtime, id: string) =>
  run(
    rt,
    Effect.gen(function*() {
      yield* (yield* ImposterServer).stop(id)
    })
  )
const followers = (rt: Runtime, id: string) =>
  run(
    rt,
    Effect.gen(function*() {
      return yield* (yield* RequestLogger).followers(id)
    })
  )

const openEvents = async (port: number) => {
  const connection = await rawRequest(
    port,
    `GET /_admin/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\n\r\n`
  )
  // The first line goes out once the stream has subscribed
  await connection.waitFor((text) => text.includes("retry: 2000"))
  return connection
}

describe("E2E: live request events", () => {
  it("streams each request as a row once the stream has opened", async () => {
    await startImposter(runtime, "sse-receive", 9021)
    const events = await openEvents(9021)
    try {
      const head = events.received()
      expect(head).toMatch(/^HTTP\/1\.1 200/)
      expect(head).toMatch(/content-type: text\/event-stream; charset=utf-8/i)
      expect(head).toMatch(/cache-control: no-store/i)
      expect(head).toMatch(/x-accel-buffering: no/i)

      expect((await httpGet(9021, "/hello")).body).toBe("hi")
      const text = await events.waitFor((t) => t.includes("/hello</span>"))
      expect(text).toContain("event: request")
      expect(text).toMatch(
        /data: <a class="req req-row" id="req-([0-9a-f-]{36})" data-seq="\d+" href="\/_admin\/requests\/\1">/
      )
      expect(text).toContain("#1 /hello")

      // UI traffic is not logged, so the stream's own request never shows up in it
      expect(text).not.toContain("/_admin/events</span>")
    } finally {
      events.destroy()
      await stop(runtime, "sse-receive")
    }
  })

  it("stopping the imposter ends the stream, and stop resolves", async () => {
    await startImposter(runtime, "sse-stop", 9022)
    const events = await openEvents(9022)
    expect(await followers(runtime, "sse-stop")).toBe(1)

    await stop(runtime, "sse-stop")

    await events.closed
    expect(await followers(runtime, "sse-stop")).toBe(0)
  })

  it("a client that disconnects releases its subscription", async () => {
    await startImposter(runtime, "sse-gone", 9023)
    try {
      const events = await openEvents(9023)
      const second = await openEvents(9023)
      expect(await followers(runtime, "sse-gone")).toBe(2)

      events.destroy()
      await vi.waitFor(async () => expect(await followers(runtime, "sse-gone")).toBe(1))

      // The other stream is unaffected
      await httpGet(9023, "/hello")
      await second.waitFor((t) => t.includes("/hello</span>"))
      second.destroy()
      await vi.waitFor(async () => expect(await followers(runtime, "sse-gone")).toBe(0))
    } finally {
      await stop(runtime, "sse-gone")
    }
  })

  it("on a server that never cancels a body (Bun), stopping still ends the stream", async () => {
    await startImposter(noCancelRuntime, "sse-nocancel", 9024)
    const events = await openEvents(9024)
    expect(await followers(noCancelRuntime, "sse-nocancel")).toBe(1)

    await stop(noCancelRuntime, "sse-nocancel")

    await events.closed
    // The server dropped the connection without cancelling the body; the run's shutdown ended the stream
    await vi.waitFor(async () => expect(await followers(noCancelRuntime, "sse-nocancel")).toBe(0))
  })

  it("a restarted imposter streams again", async () => {
    await startImposter(runtime, "sse-restart", 9025)
    const first = await openEvents(9025)
    await stop(runtime, "sse-restart")
    await first.closed
    await run(
      runtime,
      Effect.gen(function*() {
        yield* (yield* ImposterServer).start("sse-restart")
      }).pipe(Effect.orDie)
    )
    const events = await openEvents(9025)
    try {
      await httpGet(9025, "/hello")
      await events.waitFor((t) => t.includes("/hello</span>"))
    } finally {
      events.destroy()
      await stop(runtime, "sse-restart")
    }
  })
})
