import { makeWebHandler } from "imposters/server/AdminServer"
import { lanAddress, probeConnect, reachability } from "imposters/test/helpers/net"
import { describe, expect, it } from "vitest"

// Creates and starts one imposter through the admin API, on a runtime built for `host`
const runImposter = async (port: number, host?: string, stubs: ReadonlyArray<unknown> = []) => {
  const { dispose, handler } = host === undefined ? makeWebHandler([]) : makeWebHandler([], host)
  const admin = (path: string, method: string, body: unknown) =>
    handler(
      new Request(`http://localhost:2525${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      })
    )
  const created: { id: string } = await (await admin("/imposters", "POST", { port })).json()
  for (const stub of stubs) {
    expect((await admin(`/imposters/${created.id}/stubs`, "POST", stub)).status).toBe(201)
  }
  const started = await admin(`/imposters/${created.id}`, "PATCH", { status: "running" })
  expect(started.status).toBe(200)
  return dispose
}

describe("E2E: the address imposters bind", () => {
  it("binds an imposter to the loopback address unless told otherwise", async () => {
    const dispose = await runImposter(9721)
    try {
      expect(await probeConnect(9721)).toBe("connected")
      if (lanAddress !== undefined) expect(await reachability(9721, lanAddress)).toBe("unreachable")
    } finally {
      await dispose()
    }
  })

  it("binds an imposter to the address the runtime is given", async () => {
    const dispose = await runImposter(9722, "0.0.0.0")
    try {
      expect(await probeConnect(9722)).toBe("connected")
      if (lanAddress !== undefined) expect(await reachability(9722, lanAddress)).toBe("reachable")
    } finally {
      await dispose()
    }
  })

  // The UI's "send test request" once dialled localhost, which nothing answers when the
  // imposter binds one specific non-loopback address
  it.skipIf(lanAddress === undefined)(
    "sends the /_admin test request to an imposter bound to one address",
    async () => {
      const teapot = {
        predicates: [{ field: "path", operator: "equals", value: "/teapot" }],
        responses: [{ status: 418, body: "short and stout" }]
      }
      const dispose = await runImposter(9723, lanAddress, [teapot])
      try {
        const form = new FormData()
        form.set("method", "GET")
        form.set("path", "/teapot")
        const res = await fetch(`http://${lanAddress}:9723/_admin/requests/test`, { method: "POST", body: form })
        const html = await res.text()
        expect(html).not.toContain("Request failed")
        expect(html).toContain("418")
        expect(html).toContain("short and stout")
      } finally {
        await dispose()
      }
    }
  )
})
