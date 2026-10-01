import { makeWebHandler } from "imposters/server/AdminServer"
import { lanAddress, probeConnect, reachability } from "imposters/test/helpers/net"
import { describe, expect, it } from "vitest"

// Creates and starts one imposter through the admin API, on a runtime built for `host`
const runImposter = async (port: number, host?: string) => {
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
})
