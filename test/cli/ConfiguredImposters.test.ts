import { Effect, ManagedRuntime, Schema } from "effect"
import { ConfigLoadError, createConfiguredImposters } from "imposters/cli/ConfigLoader"
import { ImpostersClient } from "imposters/client/ImpostersClient"
import { makeTestServer } from "imposters/client/testing"
import { ConfigFile } from "imposters/schemas/ConfigFileSchema"
import { occupyPort } from "imposters/test/helpers/net"
import { EchoExtension } from "imposters/test/helpers/TestExtensions"
import { afterAll, describe, expect, it } from "vitest"

// Ports 9821-9829 belong to this file.

const server = makeTestServer({ extensions: [EchoExtension] })
const runtime = ManagedRuntime.make(server.clientLayer)

afterAll(async () => {
  await runtime.dispose()
  server.dispose()
})

const configOf = (imposters: ReadonlyArray<unknown>) => Schema.decodeUnknownSync(ConfigFile)({ imposters }).imposters

// Runs the config load; a ConfigLoadError comes back as a value
const load = (imposters: ReadonlyArray<unknown>) =>
  runtime.runPromise(
    createConfiguredImposters(configOf(imposters)).pipe(
      Effect.as(null),
      Effect.catchTag("ConfigLoadError", (e) => Effect.succeed(e))
    )
  )

const listed = () =>
  runtime.runPromise(
    Effect.gen(function*() {
      const client = yield* ImpostersClient
      const list = yield* client.imposters.listImposters({ query: { limit: 50, offset: 0 } })
      return list.imposters.map((i) => ({ name: i.name, port: i.port, protocol: i.protocol, status: i.status }))
    })
  )

describe("createConfiguredImposters", () => {
  it("creates, stubs and starts HTTP and extension imposters", async () => {
    const result = await load([
      {
        name: "plain",
        port: 9821,
        stubs: [{ predicates: [], responses: [{ status: 200, body: "plain" }] }]
      },
      { name: "echo", port: 9822, protocol: "ECHO" }
    ])
    expect(result).toBeNull()

    expect(await listed()).toEqual(expect.arrayContaining([
      { name: "plain", port: 9821, protocol: "HTTP", status: "running" },
      { name: "echo", port: 9822, protocol: "ECHO", status: "running" }
    ]))
    expect(await (await fetch("http://localhost:9821/")).text()).toBe("plain")
    const echoed = await fetch("http://localhost:9822/", { method: "POST", body: "from config" })
    expect(await echoed.text()).toBe("from config")
  })

  it("stops at the first failing imposter with a clear error", async () => {
    const result = await load([
      { name: "unknown", port: 9823, protocol: "FTP" },
      { name: "never-created", port: 9824 }
    ])
    expect(result).toBeInstanceOf(ConfigLoadError)
    expect(result?.message).toBe(`Failed to create imposter unknown: Unknown protocol "FTP". Available: HTTP, ECHO`)

    const ports = (await listed()).map((i) => i.port)
    expect(ports).not.toContain(9823)
    expect(ports).not.toContain(9824)
  })

  it("a start failure is a failure too", async () => {
    // Something outside imposters holds the port, so create succeeds and the bind fails
    const release = await occupyPort(9825)
    try {
      const result = await load([{ name: "blocked", port: 9825 }])
      expect(result).toBeInstanceOf(ConfigLoadError)
      expect(result?.message).toContain("Failed to start imposter blocked")
    } finally {
      await release()
    }
  })
})
