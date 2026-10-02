import { Context, Data, Effect, Layer } from "effect"
import * as http from "node:http"

export class ServerBindError extends Data.TaggedError("ServerBindError")<{
  readonly port: number
  readonly reason: string
}> {}

// Loopback only: the admin API is unauthenticated and can create proxies, so reaching it
// from the network takes an explicit --host
export const DEFAULT_HOST = "127.0.0.1"

/**
 * The address to bind: the --host flag, else IMPOSTERS_HOST, else the default. A blank one is
 * skipped, because listen() given an empty address takes every interface.
 */
export const resolveHost = (flag: string | undefined, env: string | undefined): string =>
  [flag, env].map((candidate) => candidate?.trim()).find((candidate) => candidate !== undefined && candidate !== "") ??
    DEFAULT_HOST

export interface ServerInstance {
  readonly port: number
  // The address the listener is bound to, as the operating system reports it
  readonly host: string
  // Completes only once the listener is closed and the port is released.
  readonly stop: (closeActive: boolean) => Effect.Effect<void>
}

export interface ServerFactoryShape {
  // Completes only once the port is bound; fails with ServerBindError otherwise.
  readonly create: (options: {
    readonly port: number
    readonly fetch: (request: Request) => Promise<Response>
  }) => Effect.Effect<ServerInstance, ServerBindError>
}

export class ServerFactory extends Context.Service<ServerFactory, ServerFactoryShape>()("ServerFactory") {}

// Collects the raw chunks: decoding each chunk to a string would corrupt binary bodies and
// multi-byte characters split across chunk boundaries
const readBody = (req: http.IncomingMessage): Promise<Uint8Array<ArrayBuffer>> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })

const makeNodeRequestListener = (
  port: number,
  fetch: (request: Request) => Promise<Response>
): http.RequestListener =>
async (req, res) => {
  try {
    const url = `http://localhost:${port}${req.url}`
    const headers = new Headers()
    for (const [key, val] of Object.entries(req.headers)) {
      if (val) headers.set(key, Array.isArray(val) ? val.join(", ") : val)
    }

    const body = req.method !== "GET" && req.method !== "HEAD" ? await readBody(req) : undefined

    const request = new Request(url, {
      method: req.method ?? "GET",
      headers,
      ...(body !== undefined && body.length > 0 ? { body } : {})
    })

    const response = await fetch(request)

    const respHeaders: Record<string, string> = {}
    response.headers.forEach((val, key) => {
      respHeaders[key] = val
    })
    // A HEAD answer has no body, and Node discards writes to one without ever pushing back, so
    // reading it would spin a never-ending stream forever and hold the head until it ended
    const respBody = req.method === "HEAD" ? null : response.body
    if (respBody === null) response.body?.cancel().catch(() => undefined)
    await writeResponse(res, response.status, respHeaders, respBody)
  } catch (err) {
    // Once the head is out a JSON 500 cannot follow it: drop the connection, so the client
    // sees a truncated response rather than a clean end
    if (res.headersSent) res.destroy(err instanceof Error ? err : new Error(String(err)))
    else {
      res.writeHead(500)
      res.end(JSON.stringify({ error: "Internal server error", details: String(err) }))
    }
  }
}

// Resolves on 'drain', or on 'close' so a client that went away cannot leave the writer waiting
const drainedOrClosed = (res: http.ServerResponse): Promise<void> =>
  new Promise((resolve) => {
    const settle = () => {
      res.off("drain", settle)
      res.off("close", settle)
      resolve()
    }
    res.once("drain", settle)
    res.once("close", settle)
  })

/**
 * Writes a Web response body to Node chunk by chunk, so a body that never ends (server-sent
 * events) reaches the client as it is produced. Nothing is buffered: a producer that answers
 * every read at once is just a fast stream, held back by backpressure.
 *
 * The head waits for the first read. A body that fails there gets the caller's JSON 500, and an
 * empty one ends with the head. A body already in memory (every `new Response(bytes)`) is one
 * chunk and then the end: the same bytes on the wire as when the adapter buffered. The cost: a
 * stream with nothing to say yet holds its head until its first chunk, so an event stream
 * should open with a line (a `retry:` or a comment) at once.
 *
 * When the client disconnects the reader is cancelled, which interrupts whatever produces the
 * stream (an Effect stream behind `Stream.toReadableStream` sees an interrupt). A read that
 * fails after the head is rethrown, and the caller destroys the connection.
 */
const writeResponse = async (
  res: http.ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: ReadableStream<Uint8Array> | null
): Promise<void> => {
  if (body === null) {
    res.writeHead(status, headers)
    res.end(new Uint8Array(0))
    return
  }

  const reader = body.getReader()
  const cancel = () => {
    // A cancel that rejects has nothing left to clean up: the client is already gone
    reader.cancel().catch(() => undefined)
  }
  res.once("close", cancel)
  try {
    let result = await reader.read()
    if (res.destroyed) return
    res.writeHead(status, headers)
    if (result.done) {
      res.end(new Uint8Array(0))
      return
    }
    while (!result.done) {
      if (!res.write(result.value)) await drainedOrClosed(res)
      if (res.destroyed) return
      result = await reader.read()
      if (res.destroyed) return
    }
    res.end()
  } finally {
    res.off("close", cancel)
    if (res.destroyed) cancel()
  }
}

// Resolves on the close callback, i.e. once the listening handle is closed.
// A server that is not listening calls back with ERR_SERVER_NOT_RUNNING, which
// is still "released", so the error argument is ignored.
const closeNodeServer = (server: http.Server, closeActive: boolean): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    // Guarded because Bun's node:http compatibility layer may not implement it
    if (closeActive && typeof server.closeAllConnections === "function") server.closeAllConnections()
    server.close(() => resume(Effect.void))
  })

const boundHost = (server: http.Server, requested: string): string => {
  const address = server.address()
  return address !== null && typeof address === "object" ? address.address : requested
}

export const makeNodeServerFactory = (host: string) =>
  Layer.succeed(ServerFactory, {
    create: (options) =>
      Effect.callback<ServerInstance, ServerBindError>((resume) => {
        const server = http.createServer(makeNodeRequestListener(options.port, options.fetch))

        // Exactly one of these fires for a listen() call; each removes the other
        // so no listener outlives the bind attempt.
        const onError = (err: Error) => {
          server.off("listening", onListening)
          resume(Effect.fail(new ServerBindError({ port: options.port, reason: err.message })))
        }
        const onListening = () => {
          server.off("error", onError)
          resume(Effect.succeed({
            port: options.port,
            host: boundHost(server, host),
            stop: (closeActive) => closeNodeServer(server, closeActive)
          }))
        }
        server.once("error", onError)
        server.once("listening", onListening)
        server.listen(options.port, host)

        // Interrupted before the bind settled: drop the listeners and release
        // whatever was (or is about to be) bound.
        return Effect.suspend(() => {
          server.off("error", onError)
          server.off("listening", onListening)
          return closeNodeServer(server, true)
        })
      })
  })

export const NodeServerFactoryLive = makeNodeServerFactory(DEFAULT_HOST)

const bunUnavailable = (port: number) =>
  new ServerBindError({
    port,
    reason: "The Bun runtime is not available (globalThis.Bun is undefined). " +
      "--runtime bun requires running under Bun, e.g. `bun dist/bin/cli.cjs start --runtime bun`; " +
      "use --runtime node under Node.js"
  })

export const makeBunServerFactory = (host: string) =>
  Layer.succeed(ServerFactory, {
    create: (options) =>
      Effect.suspend(() => {
        const bun = globalThis.Bun
        if (bun === undefined) return Effect.fail(bunUnavailable(options.port))
        // Bun.serve binds synchronously and throws on failure (e.g. EADDRINUSE)
        return Effect.try({
          try: () => bun.serve({ port: options.port, hostname: host, fetch: options.fetch }),
          catch: (err) =>
            new ServerBindError({ port: options.port, reason: err instanceof Error ? err.message : String(err) })
        }).pipe(
          Effect.map((server): ServerInstance => ({
            port: server.port ?? options.port,
            host: server.hostname ?? host,
            // stop() resolves once the listener is closed
            stop: (closeActive) => Effect.promise(() => Promise.resolve(server.stop(closeActive)))
          }))
        )
      })
  })

export const BunServerFactoryLive = makeBunServerFactory(DEFAULT_HOST)
