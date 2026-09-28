import { Context, Layer } from "effect"
import * as http from "node:http"

export interface ServerInstance {
  readonly port: number
  readonly stop: (closeActive: boolean) => void
}

export interface ServerFactoryShape {
  readonly create: (options: {
    readonly port: number
    readonly fetch: (request: Request) => Promise<Response>
  }) => ServerInstance
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

export const NodeServerFactoryLive = Layer.succeed(ServerFactory, {
  create: (options): ServerInstance => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = `http://localhost:${options.port}${req.url}`
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

        const response = await options.fetch(request)

        const respHeaders: Record<string, string> = {}
        response.headers.forEach((val, key) => {
          respHeaders[key] = val
        })
        res.writeHead(response.status, respHeaders)
        res.end(new Uint8Array(await response.arrayBuffer()))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ error: "Internal server error", details: String(err) }))
      }
    })

    server.listen(options.port)

    return {
      port: options.port,
      stop: (closeActive: boolean) => {
        if (closeActive && typeof server.closeAllConnections === "function") {
          server.closeAllConnections()
        }
        server.close()
      }
    }
  }
})

export const BunServerFactoryLive = Layer.succeed(ServerFactory, {
  create: (options) => (globalThis as any).Bun.serve(options)
})
