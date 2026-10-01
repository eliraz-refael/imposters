import * as http from "node:http"
import * as net from "node:net"
import * as os from "node:os"

// Opens a fresh TCP connection and reports whether anything is listening.
// Uses a raw socket rather than fetch so a pooled keep-alive connection
// cannot mask the answer.
export const probeConnect = (port: number, host = "127.0.0.1"): Promise<"connected" | "refused"> =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ port, host })
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
export const httpGet = (
  port: number,
  path: string
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> =>
  new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      const chunks: Array<Buffer> = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }))
      res.on("error", reject)
    })
    req.on("error", reject)
  })

// Binds `port` on the loopback address the servers bind by default, so a later bind on
// it fails with EADDRINUSE. A wildcard bind would not block it: macOS lets a specific
// address bind beside one. Resolves with a function that releases the port.
export const occupyPort = (port: number): Promise<() => Promise<void>> =>
  new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      resolve(() => new Promise<void>((done) => server.close(() => done())))
    })
  })

// The first non-loopback IPv4 address, or undefined on a machine with no network
export const lanAddress: string | undefined = Object.values(os.networkInterfaces())
  .flatMap((addresses) => addresses ?? [])
  .find((address) => address.family === "IPv4" && !address.internal)?.address

// Whether a fresh connection to host:port is accepted. A refusal and a silence both count
// as unreachable: with the macOS firewall's stealth mode on, a closed port drops the SYN
// instead of refusing it, even for a connection from the same machine.
export const reachability = (port: number, host: string): Promise<"reachable" | "unreachable"> =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const settle = (answer: "reachable" | "unreachable") => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(1000, () => settle("unreachable"))
    socket.once("connect", () => settle("reachable"))
    socket.once("error", () => settle("unreachable"))
  })
