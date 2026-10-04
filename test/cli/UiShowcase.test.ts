import { ManagedRuntime, Schema } from "effect"
import { createConfiguredImposters, loadConfigFile } from "imposters/cli/ConfigLoader"
import { makeTestServer } from "imposters/client/testing"
import { S3Extension } from "imposters/extensions/s3/S3Extension"
import { PortNumber } from "imposters/schemas/common"
import * as path from "node:path"
import { afterAll, describe, expect, it } from "vitest"

// Ports 8521-8529 belong to this file.

const server = makeTestServer({ extensions: [S3Extension] })
const runtime = ManagedRuntime.make(server.clientLayer)

afterAll(async () => {
  await runtime.dispose()
  server.dispose()
})

// The config `bun run screenshots` (scripts/ui-screenshots.ts) runs; the script finds its
// imposters by these names
const EXAMPLE = path.join(__dirname, "../../examples/ui-showcase.json")

describe("examples/ui-showcase.json", () => {
  it("declares the imposters the screenshot script expects", async () => {
    const config = await runtime.runPromise(loadConfigFile(EXAMPLE))
    expect(config.imposters.map((i) => [i.name, i.protocol])).toEqual([
      ["users-api", "HTTP"],
      ["orders-api", "HTTP"],
      ["catalog-api", "HTTP"],
      ["media-s3", "S3"],
      ["payments-sandbox", "HTTP"]
    ])
    const stubs = config.imposters.flatMap((i) => i.stubs)
    // A flaky stub, and a slow one with a delay range
    expect(stubs.some((s) => s.responseMode === "random" && s.responses.some((r) => r.status >= 500))).toBe(true)
    expect(stubs.some((s) => s.responses.some((r) => typeof r.delay === "object"))).toBe(true)
  })

  it("loads through the CLI's config path, and its templates answer", async () => {
    // Moved onto this file's ports, so the test never collides with a running showcase
    const config = await runtime.runPromise(loadConfigFile(EXAMPLE))
    const moved = config.imposters.map((imp, i) => ({ ...imp, port: Schema.decodeUnknownSync(PortNumber)(8521 + i) }))
    await runtime.runPromise(createConfiguredImposters(moved))

    const user = await fetch("http://127.0.0.1:8521/users/42")
    expect(await user.json()).toEqual({ id: 42, name: "Alice", email: "alice@example.com" })

    const search = await fetch("http://127.0.0.1:8521/search?q=bob")
    expect(await search.json()).toEqual({ query: "bob", results: [] })

    const order = await fetch("http://127.0.0.1:8522/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customer: "acme", items: [{ sku: "a", price: 9 }, { sku: "b", price: 19 }] })
    })
    expect(order.status).toBe(201)
    expect(await order.json()).toMatchObject({ customer: "acme", items: 2, total: 28, status: "pending" })

    const unmatched = await fetch("http://127.0.0.1:8522/v2/orders")
    await unmatched.body?.cancel()
    expect(unmatched.status).toBe(404)

    const bucket = await fetch("http://127.0.0.1:8524/media", { method: "PUT" })
    await bucket.body?.cancel()
    expect(bucket.status).toBe(200)
    const throttled = await fetch("http://127.0.0.1:8524/media/videos/intro.mp4")
    expect(throttled.status).toBe(503)
    expect(await throttled.text()).toContain("SlowDown")
  })
})
