import { makeWebHandler } from "./server/AdminServer.js"

declare const Bun: {
  serve(options: {
    readonly port: number
    readonly fetch: (request: Request) => Promise<Response>
  }): { readonly port: number; stop(closeActive: boolean): void }
}

const port = Number(process.env.ADMIN_PORT ?? 2525)
const { handler, dispose } = makeWebHandler()
const server = Bun.serve({ port, fetch: handler })

console.log(`Imposters admin server running on http://localhost:${server.port}`)

const shutdown = async () => {
  console.log("Shutting down...")
  server.stop(true)
  await dispose()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
