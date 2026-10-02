import { it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { ServerInstance } from "imposters/server/ServerFactory"
import {
  BunServerFactoryLive,
  DEFAULT_HOST,
  makeNodeServerFactory,
  resolveHost,
  ServerFactory
} from "imposters/server/ServerFactory"
import { httpGet, lanAddress, occupyPort, probeConnect, rawRequest, reachability } from "imposters/test/helpers/net"
import { NodeServerFactoryLive } from "imposters/test/helpers/NodeServerFactory"
import { randomBytes } from "node:crypto"
import * as http from "node:http"
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

const createOn = (host: string, port: number) =>
  Effect.gen(function*() {
    const factory = yield* ServerFactory
    return yield* factory.create({ port, fetch: okHandler })
  }).pipe(Effect.provide(makeNodeServerFactory(host)))

describe("NodeServerFactory - bind address", () => {
  it.live("binds the loopback address by default", () =>
    Effect.gen(function*() {
      const instance = yield* create(9709)
      expect(instance.host).toBe("127.0.0.1")
      yield* instance.stop(true)
    }))

  it.live("binds the address it is given", () =>
    Effect.gen(function*() {
      const instance = yield* createOn("0.0.0.0", 9710)
      expect(instance.host).toBe("0.0.0.0")
      expect(yield* Effect.promise(() => probeConnect(9710))).toBe("connected")
      yield* instance.stop(true)
    }))

  it.live("cannot be reached from the network by default, and can on 0.0.0.0", () =>
    Effect.gen(function*() {
      const lan = lanAddress
      if (lan === undefined) return
      const loopback = yield* create(9711)
      const wildcard = yield* createOn("0.0.0.0", 9712)
      expect(yield* Effect.promise(() => reachability(9711, lan))).toBe("unreachable")
      expect(yield* Effect.promise(() => reachability(9712, lan))).toBe("reachable")
      yield* loopback.stop(true)
      yield* wildcard.stop(true)
    }))
})

describe("resolveHost", () => {
  it("prefers the flag, then the environment, then the loopback default", () => {
    expect(resolveHost("0.0.0.0", "10.0.0.1")).toBe("0.0.0.0")
    expect(resolveHost(undefined, "10.0.0.1")).toBe("10.0.0.1")
    expect(resolveHost(undefined, undefined)).toBe(DEFAULT_HOST)
  })

  // listen(port, "") binds every interface, which would reopen the unauthenticated admin API
  it("skips a blank flag or environment value instead of binding every interface", () => {
    expect(resolveHost(undefined, "")).toBe(DEFAULT_HOST)
    expect(resolveHost("  ", "  ")).toBe(DEFAULT_HOST)
    expect(resolveHost("", "10.0.0.1")).toBe("10.0.0.1")
    expect(resolveHost(" 0.0.0.0 ", undefined)).toBe("0.0.0.0")
  })
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

// Streaming bodies: ports 9740-9750. These drive raw sockets and real timers, so they are
// plain async tests around a server started with Effect.runPromise.
const utf8 = (text: string) => new TextEncoder().encode(text)

const get = (path: string, method = "GET") =>
  `${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`

// The terminating chunk of a chunked body
const LAST_CHUNK = "0\r\n\r\n"

const makeGate = () => {
  let open = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open: () => open() }
}

// Rejects when the promise has not settled in time, so a regression fails instead of hanging
const within = <A>(promise: Promise<A>, ms = 2000): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const withServer = async (
  port: number,
  fetch: (request: Request) => Promise<Response>,
  body: (instance: ServerInstance) => Promise<void>
): Promise<void> => {
  const instance = await Effect.runPromise(create(port, fetch))
  try {
    await body(instance)
  } finally {
    await Effect.runPromise(instance.stop(true))
  }
}

const getBytes = (port: number, path: string): Promise<{ headers: http.IncomingHttpHeaders; body: Buffer }> =>
  new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      const chunks: Array<Buffer> = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
      res.on("error", reject)
    })
    req.on("error", reject)
  })

// A body that yields `bytes` in uneven chunks, waiting a macrotask before each one, so the
// adapter cannot read it to the end at once and has to stream it
const slowBody = (bytes: Uint8Array): ReadableStream<Uint8Array> => {
  const sizes = [1, 7, 4096, 65537, 13, 32768, 3]
  let offset = 0
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setImmediate(resolve))
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      const size = sizes[index % sizes.length] ?? 1
      index += 1
      controller.enqueue(bytes.slice(offset, offset + size))
      offset += size
    }
  })
}

describe("NodeServerFactoryLive - streaming bodies", () => {
  it("writes each chunk as the body yields it, before the body ends", async () => {
    const gate = makeGate()
    const handler = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(utf8("first-chunk"))
            await gate.opened
            controller.enqueue(utf8("second-chunk"))
            controller.close()
          }
        })
      )
    await withServer(9741, handler, async () => {
      const conn = await rawRequest(9741, get("/"))
      const early = await conn.waitFor((text) => text.includes("first-chunk"))
      expect(early).toMatch(/^HTTP\/1\.1 200/)
      expect(early.toLowerCase()).toContain("transfer-encoding: chunked")
      expect(early).not.toContain("second-chunk")
      expect(conn.isClosed()).toBe(false)

      gate.open()
      const full = await conn.waitFor((text) => text.endsWith(LAST_CHUNK))
      expect(full).toContain("second-chunk")
      await within(conn.closed)
    })
  })

  it("cancels the body when the client disconnects", async () => {
    const cancelled = makeGate()
    const handler = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(utf8("first-chunk"))
          },
          cancel() {
            cancelled.open()
          }
        })
      )
    await withServer(9742, handler, async () => {
      const conn = await rawRequest(9742, get("/"))
      await conn.waitFor((text) => text.includes("first-chunk"))
      conn.destroy()
      await within(cancelled.opened)
    })
  })

  // A synchronous pull answers every read at once: an adapter that read ahead until the body
  // paused would buffer it until the heap ran out, instead of writing it under backpressure
  it("streams a body whose producer never waits, and cancels it on disconnect", async () => {
    const cancelled = makeGate()
    const chunk = utf8("x".repeat(1024))
    const handler = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(chunk)
          },
          cancel() {
            cancelled.open()
          }
        })
      )
    await withServer(9740, handler, async () => {
      const conn = await rawRequest(9740, get("/"))
      const early = await conn.waitFor((text) => text.includes("xxxx"))
      expect(early.toLowerCase()).toContain("transfer-encoding: chunked")
      conn.destroy()
      await within(cancelled.opened)
    })
  })

  it("interrupts an Effect stream behind the body when the client disconnects", async () => {
    const finalized = Effect.runSync(Deferred.make<void>())
    const body = Stream.make("first-chunk").pipe(
      Stream.concat(Stream.never),
      Stream.encodeText,
      // A stream that never ends is only finalized by interruption
      Stream.ensuring(Deferred.succeed(finalized, undefined)),
      Stream.toReadableStream
    )
    await withServer(9743, async () => new Response(body), async () => {
      const conn = await rawRequest(9743, get("/"))
      await conn.waitFor((text) => text.includes("first-chunk"))
      conn.destroy()
      await within(Effect.runPromise(Deferred.await(finalized)))
    })
  })

  it("streams binary bytes byte-identically across uneven chunk boundaries", async () => {
    const sent = new Uint8Array(randomBytes(300 * 1024))
    await withServer(9744, async () => new Response(slowBody(sent)), async () => {
      const { body, headers } = await getBytes(9744, "/")
      expect(headers["transfer-encoding"]).toBe("chunked")
      expect(body.length).toBe(sent.length)
      expect(body.equals(sent)).toBe(true)
    })
  })

  // The buffering adapter wrote such a body with one res.end(bytes): a single chunk, then the
  // terminator. The wire format must not change for it.
  it("sends a body already in memory as one chunk, byte-identically", async () => {
    const sent = new Uint8Array(randomBytes(300 * 1024))
    await withServer(9745, async () => new Response(sent), async () => {
      const conn = await rawRequest(9745, get("/"))
      await within(conn.closed)
      const text = conn.received()
      const head = text.slice(0, text.indexOf("\r\n\r\n")).toLowerCase()
      expect(head).toMatch(/^http\/1\.1 200/)
      expect(head).toContain("transfer-encoding: chunked")
      const framed = `${sent.length.toString(16)}\r\n${Buffer.from(sent).toString("latin1")}\r\n${LAST_CHUNK}`
      expect(text.slice(head.length + 4) === framed).toBe(true)
    })
  })

  it("stop(true) resolves and releases the port while a stream is still open", async () => {
    const cancelled = makeGate()
    const handler = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(utf8("first-chunk"))
          },
          cancel() {
            cancelled.open()
          }
        })
      )
    const instance = await Effect.runPromise(create(9746, handler))
    const conn = await rawRequest(9746, get("/"))
    await conn.waitFor((text) => text.includes("first-chunk"))

    await within(Effect.runPromise(instance.stop(true)))
    expect(await probeConnect(9746)).toBe("refused")
    await within(conn.closed)
    await within(cancelled.opened)
  })

  it("drops the connection when the body fails after the head was sent", async () => {
    const gate = makeGate()
    const handler = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(utf8("first-chunk"))
            await gate.opened
            controller.error(new Error("boom"))
          }
        })
      )
    await withServer(9747, handler, async () => {
      const conn = await rawRequest(9747, get("/"))
      await conn.waitFor((text) => text.includes("first-chunk"))
      gate.open()
      await within(conn.closed)
      // Truncated: no terminating chunk, and no second response pasted after the first
      expect(conn.received()).not.toContain(LAST_CHUNK)
      expect(conn.received()).not.toContain("Internal server error")
    })
  })

  it("answers a JSON 500 when the body fails before anything was sent", async () => {
    const handler = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            throw new Error("boom")
          }
        })
      )
    await withServer(9748, handler, async () => {
      const resp = await httpGet(9748, "/")
      expect(resp.status).toBe(500)
      expect(resp.body).toContain("Internal server error")
      expect(resp.body).toContain("boom")
    })
  })

  // Node discards HEAD body writes without backpressure and flushes the head only at end(),
  // so reading a never-ending body would hang the client and spin the producer forever
  it("answers HEAD at once and cancels a body that never ends", async () => {
    const cancelled = makeGate()
    const handler = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(utf8("x"))
          },
          cancel() {
            cancelled.open()
          }
        })
      )
    await withServer(9750, handler, async () => {
      const conn = await rawRequest(9750, get("/", "HEAD"))
      await within(conn.closed)
      expect(conn.received()).toMatch(/^HTTP\/1\.1 200/)
      await within(cancelled.opened)
    })
  })

  it("writes no body for HEAD, 204 and 304", async () => {
    const handler = async (request: Request) => {
      const path = new URL(request.url).pathname
      if (path === "/204") return new Response(null, { status: 204 })
      if (path === "/304") return new Response(null, { status: 304, headers: { etag: "\"v1\"" } })
      return new Response("hello", { headers: { "content-type": "text/plain" } })
    }
    const exchange = async (head: string) => {
      const conn = await rawRequest(9749, head)
      await within(conn.closed)
      const [, ...rest] = conn.received().split("\r\n\r\n")
      return { text: conn.received(), body: rest.join("\r\n\r\n") }
    }
    await withServer(9749, handler, async () => {
      const head = await exchange(get("/", "HEAD"))
      expect(head.text).toMatch(/^HTTP\/1\.1 200/)
      expect(head.text.toLowerCase()).toContain("content-type: text/plain")
      expect(head.body).toBe("")

      const noContent = await exchange(get("/204"))
      expect(noContent.text).toMatch(/^HTTP\/1\.1 204/)
      expect(noContent.body).toBe("")

      const notModified = await exchange(get("/304"))
      expect(notModified.text).toMatch(/^HTTP\/1\.1 304/)
      expect(notModified.text).toContain("etag: \"v1\"")
      expect(notModified.body).toBe("")
    })
  })
})
