import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { ServerInstance } from "imposters/server/ServerFactory"
import { BunServerFactoryLive, ServerFactory } from "imposters/server/ServerFactory"
import { httpGet, occupyPort, probeConnect } from "imposters/test/helpers/net"
import { NodeServerFactoryLive } from "imposters/test/helpers/NodeServerFactory"
import { afterAll, beforeAll, describe, expect } from "vitest"

const PORT = 9701

const echoHandler = async (request: Request) => new Response(await request.arrayBuffer())
const okHandler = async () => new Response("ok")

const create = (port: number, fetch: (request: Request) => Promise<Response> = okHandler) =>
  Effect.gen(function*() {
    const factory = yield* ServerFactory
    return yield* factory.create({ port, fetch })
  }).pipe(Effect.provide(NodeServerFactoryLive))

let server: ServerInstance

beforeAll(async () => {
  server = await Effect.runPromise(create(PORT, echoHandler))
})

afterAll(async () => {
  await Effect.runPromise(server.stop(true))
})

const echo = async (body: Uint8Array<ArrayBuffer>): Promise<Uint8Array> => {
  const resp = await fetch(`http://localhost:${PORT}/echo`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body
  })
  return new Uint8Array(await resp.arrayBuffer())
}

describe("NodeServerFactoryLive - binary-safe bodies", () => {
  it.effect.prop(
    "echoes arbitrary bytes byte-identically through a real socket",
    { bytes: Schema.Uint8Array },
    ({ bytes }) =>
      Effect.gen(function*() {
        const sent = new Uint8Array(bytes)
        const received = yield* Effect.promise(() => echo(sent))
        expect(received).toEqual(sent)
      }),
    { arbitrary: { runs: 30 } }
  )

  it.effect("echoes a large body that spans several socket chunks", () =>
    Effect.gen(function*() {
      // Every byte value, repeated past Node's 64 KiB read chunk size
      const sent = Uint8Array.from({ length: 256 * 1024 }, (_, i) => i % 256)
      const received = yield* Effect.promise(() => echo(sent))
      expect(received).toEqual(sent)
    }))
})

// These use live sockets, so they run on the real clock via it.live
describe("NodeServerFactoryLive - lifecycle", () => {
  it.live("create completes only once the port is bound", () =>
    Effect.gen(function*() {
      const instance = yield* create(9702)
      // No sleep: a fresh connection issued right away must be accepted
      const resp = yield* Effect.promise(() => httpGet(9702, "/"))
      expect(resp.status).toBe(200)
      yield* instance.stop(true)
    }))

  it.live("stop completes only once the port is released", () =>
    Effect.gen(function*() {
      const instance = yield* create(9703)
      expect(yield* Effect.promise(() => probeConnect(9703))).toBe("connected")
      yield* instance.stop(true)
      expect(yield* Effect.promise(() => probeConnect(9703))).toBe("refused")
    }))

  it.live("stop(true) releases the port while a keep-alive connection is open", () =>
    Effect.gen(function*() {
      const instance = yield* create(9704)
      // fetch keeps the connection alive in undici's pool
      const resp = yield* Effect.promise(() => fetch("http://localhost:9704/"))
      expect(resp.status).toBe(200)
      yield* instance.stop(true)
      expect(yield* Effect.promise(() => probeConnect(9704))).toBe("refused")
    }))

  it.live("the same port can be re-bound immediately after stop", () =>
    Effect.gen(function*() {
      const first = yield* create(9705)
      yield* first.stop(true)
      const second = yield* create(9705)
      const resp = yield* Effect.promise(() => httpGet(9705, "/"))
      expect(resp.status).toBe(200)
      yield* second.stop(true)
    }))

  it.live("fails with ServerBindError when the port is already in use", () =>
    Effect.gen(function*() {
      const release = yield* Effect.promise(() => occupyPort(9706))
      const error = yield* create(9706).pipe(
        Effect.flip,
        Effect.ensuring(Effect.promise(release))
      )
      expect(error._tag).toBe("ServerBindError")
      expect(error.port).toBe(9706)
      expect(error.reason).toContain("EADDRINUSE")
    }))

  it.live("stop is safe to call twice", () =>
    Effect.gen(function*() {
      const instance = yield* create(9707)
      yield* instance.stop(true)
      yield* instance.stop(true)
      expect(yield* Effect.promise(() => probeConnect(9707))).toBe("refused")
    }))
})

describe("BunServerFactoryLive", () => {
  it.effect("fails with a clear ServerBindError when globalThis.Bun is undefined", () =>
    Effect.gen(function*() {
      // vitest workers are Node processes, so Bun is genuinely absent here
      expect("Bun" in globalThis).toBe(false)
      const factory = yield* ServerFactory
      const error = yield* factory.create({ port: 9708, fetch: okHandler }).pipe(Effect.flip)
      expect(error._tag).toBe("ServerBindError")
      expect(error.port).toBe(9708)
      expect(error.reason).toContain("globalThis.Bun is undefined")
    }).pipe(Effect.provide(BunServerFactoryLive)))
})
