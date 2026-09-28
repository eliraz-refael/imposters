import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { ServerInstance } from "imposters/server/ServerFactory"
import { ServerFactory } from "imposters/server/ServerFactory"
import { NodeServerFactoryLive } from "imposters/test/helpers/NodeServerFactory"
import { afterAll, beforeAll, describe, expect } from "vitest"

const PORT = 9701

let server: ServerInstance

beforeAll(async () => {
  server = Effect.runSync(
    Effect.gen(function*() {
      const factory = yield* ServerFactory
      return factory.create({
        port: PORT,
        fetch: async (request) => new Response(await request.arrayBuffer())
      })
    }).pipe(Effect.provide(NodeServerFactoryLive))
  )
  // create() does not await 'listening' (known race), so give the socket a moment
  await new Promise((r) => setTimeout(r, 150))
})

afterAll(async () => {
  server.stop(true)
  await new Promise((r) => setTimeout(r, 100))
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
