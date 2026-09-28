import * as http from "node:http"
import * as net from "node:net"

// Opens a fresh TCP connection and reports whether anything is listening.
// Uses a raw socket rather than fetch so a pooled keep-alive connection
// cannot mask the answer.
export const probeConnect = (port: number): Promise<"connected" | "refused"> =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: "127.0.0.1" })
    socket.once("connect", () => {
      socket.destroy()
      resolve("connected")
    })
    socket.once("error", (err: NodeJS.ErrnoException) => {
      socket.destroy()
      if (err.code === "ECONNREFUSED") resolve("refused")
      else reject(err)
    })
  })

// GET over a brand-new connection (agent: false), so every call exercises the
// listener rather than reusing a socket from an earlier request.
export const httpGet = (port: number, path: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      const chunks: Array<Buffer> = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }))
      res.on("error", reject)
    })
    req.on("error", reject)
  })

// Binds `port` with a bare TCP server so a later bind on it fails with
// EADDRINUSE. Resolves with a function that releases the port.
export const occupyPort = (port: number): Promise<() => Promise<void>> =>
  new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(port, () => {
      resolve(() => new Promise<void>((done) => server.close(() => done())))
    })
  })
