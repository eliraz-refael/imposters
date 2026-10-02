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

export interface RawConnection {
  // Every byte received so far, decoded one byte per character (latin1)
  readonly received: () => string
  // Resolves with the received text once it satisfies the predicate. Rejects when the
  // connection closes first, or after timeoutMs, so a response that never arrives fails
  // the test rather than hanging it.
  readonly waitFor: (predicate: (text: string) => boolean, timeoutMs?: number) => Promise<string>
  // Resolves once the connection is closed, by either side
  readonly closed: Promise<void>
  readonly isClosed: () => boolean
  // Closes the connection from the client side
  readonly destroy: () => void
}

// Sends `head` (a whole request, CRLFs included) over a fresh raw socket and records the
// reply as it arrives. For assertions about when bytes arrive and how the server ends the
// connection, which fetch and http.get hide behind buffering and pooling.
export const rawRequest = (port: number, head: string, host = "127.0.0.1"): Promise<RawConnection> =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ port, host })
    let text = ""
    let isClosed = false
    const listeners = new Set<() => void>()
    const notify = () => listeners.forEach((listener) => listener())
    const closed = new Promise<void>((done) => socket.once("close", () => done()))
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("latin1")
      notify()
    })
    socket.once("close", () => {
      isClosed = true
      notify()
    })
    socket.once("error", reject)
    socket.once("connect", () => {
      // From here a reset is just a close, which the test reads from `closed`
      socket.off("error", reject)
      socket.on("error", () => undefined)
      socket.write(head)
      resolve({
        received: () => text,
        waitFor: (predicate, timeoutMs = 2000) =>
          new Promise((satisfied, failed) => {
            const finish = (settle: () => void) => {
              clearTimeout(timer)
              listeners.delete(check)
              settle()
            }
            const check = () => {
              if (predicate(text)) finish(() => satisfied(text))
              else if (isClosed) finish(() => failed(new Error(`connection closed; received ${JSON.stringify(text)}`)))
            }
            const timer = setTimeout(
              () => finish(() => failed(new Error(`timed out; received ${JSON.stringify(text)}`))),
              timeoutMs
            )
            listeners.add(check)
            check()
          }),
        closed,
        isClosed: () => isClosed,
        destroy: () => socket.destroy()
      })
    })
  })
