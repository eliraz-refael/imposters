import { Layer } from "effect"
import { ServerFactory } from "imposters/server/BunServer"
import type { ServerInstance } from "imposters/server/BunServer"
import * as http from "node:http"

export const NodeServerFactoryLive = Layer.succeed(ServerFactory, {
  create: (options): ServerInstance => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = `http://localhost:${options.port}${req.url}`
        const headers = new Headers()
        for (const [key, val] of Object.entries(req.headers)) {
          if (val) headers.set(key, Array.isArray(val) ? val.join(", ") : val)
        }

        let body: string | undefined
        if (req.method !== "GET" && req.method !== "HEAD") {
          body = await new Promise<string>((resolve) => {
            let data = ""
            req.on("data", (chunk: Buffer) => {
              data += chunk.toString()
            })
            req.on("end", () => resolve(data))
          })
        }

        const request = new Request(url, {
          method: req.method ?? "GET",
          headers,
          ...(body !== undefined && body !== "" ? { body } : {})
        })

        const response = await options.fetch(request)

        const respHeaders: Record<string, string> = {}
        response.headers.forEach((val, key) => {
          respHeaders[key] = val
        })
        res.writeHead(response.status, respHeaders)
        const respBody = await response.text()
        res.end(respBody)
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
