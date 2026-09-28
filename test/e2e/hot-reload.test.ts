import * as Layer from "effect/Layer"
import { HttpRouter } from "effect/unstable/http"
import { ApiLayer } from "imposters/layers/ApiLayer"
import { MainLayer } from "imposters/layers/MainLayer"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const FullLayer = ApiLayer.pipe(Layer.provide(MainLayer))

let adminHandler: (request: Request) => Promise<Response>
let dispose: () => void

beforeAll(() => {
  const result = HttpRouter.toWebHandler(FullLayer)
  adminHandler = result.handler
  dispose = result.dispose
})

afterAll(() => {
  dispose()
})

const admin = (path: string, init?: RequestInit) => adminHandler(new Request(`http://localhost:2525${path}`, init))

const createImposter = async (port: number) => {
  const resp = await admin("/imposters", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port })
  })
  return resp.json()
}

const startImposter = async (id: string) => {
  await admin(`/imposters/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "running" })
  })
}

const stopImposter = async (id: string) => {
  await admin(`/imposters/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "stopped" })
  })
}

const addStub = async (imposterId: string, stub: Record<string, unknown>) => {
  const resp = await admin(`/imposters/${imposterId}/stubs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(stub)
  })
  return resp.json()
}

const deleteStub = async (imposterId: string, stubId: string) => {
  await admin(`/imposters/${imposterId}/stubs/${stubId}`, { method: "DELETE" })
}

const updateStub = async (imposterId: string, stubId: string, updates: Record<string, unknown>) => {
  await admin(`/imposters/${imposterId}/stubs/${stubId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updates)
  })
}

describe("E2E: Hot Reload", () => {
  it("add stub to running imposter takes effect immediately", async () => {
    const imp = await createImposter(9421)
    await addStub(imp.id, {
      predicates: [{ field: "path", operator: "equals", value: "/v1" }],
      responses: [{ status: 200, body: { route: "v1" } }]
    })

    await startImposter(imp.id)

    try {
      // v1 works
      const resp1 = await fetch("http://localhost:9421/v1")
      expect(resp1.status).toBe(200)

      // v2 doesn't exist yet
      const resp404 = await fetch("http://localhost:9421/v2")
      expect(resp404.status).toBe(404)

      // Add v2 stub while running
      await addStub(imp.id, {
        predicates: [{ field: "path", operator: "equals", value: "/v2" }],
        responses: [{ status: 200, body: { route: "v2" } }]
      })

      // v2 now works (hot-reload)
      const resp2 = await fetch("http://localhost:9421/v2")
      expect(resp2.status).toBe(200)
      expect(await resp2.json()).toEqual({ route: "v2" })
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)

  it("update stub response takes effect on next request", async () => {
    const imp = await createImposter(9422)
    const stub = await addStub(imp.id, {
      predicates: [],
      responses: [{ status: 200, body: { version: 1 } }]
    })

    await startImposter(imp.id)

    try {
      // Initial response
      const resp1 = await fetch("http://localhost:9422/test")
      expect(await resp1.json()).toEqual({ version: 1 })

      // Update the stub
      await updateStub(imp.id, stub.id, {
        responses: [{ status: 200, body: { version: 2 } }]
      })

      // Next request gets new response
      const resp2 = await fetch("http://localhost:9422/test")
      expect(await resp2.json()).toEqual({ version: 2 })
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)

  it("delete stub stops matching", async () => {
    const imp = await createImposter(9423)
    const stub = await addStub(imp.id, {
      predicates: [{ field: "path", operator: "equals", value: "/remove-me" }],
      responses: [{ status: 200, body: { present: true } }]
    })
    await addStub(imp.id, {
      predicates: [],
      responses: [{ status: 404, body: { fallback: true } }]
    })

    await startImposter(imp.id)

    try {
      // Stub matches initially
      const resp1 = await fetch("http://localhost:9423/remove-me")
      expect(resp1.status).toBe(200)

      // Delete the stub
      await deleteStub(imp.id, stub.id)

      // Now falls through to catch-all
      const resp2 = await fetch("http://localhost:9423/remove-me")
      expect(resp2.status).toBe(404)
      expect(await resp2.json()).toEqual({ fallback: true })
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)

  it("sequential response cycling (round-robin)", async () => {
    const imp = await createImposter(9424)
    await addStub(imp.id, {
      predicates: [],
      responseMode: "sequential",
      responses: [
        { status: 200, body: { letter: "A" } },
        { status: 200, body: { letter: "B" } },
        { status: 200, body: { letter: "C" } }
      ]
    })

    await startImposter(imp.id)

    try {
      const letters = []
      for (let i = 0; i < 6; i++) {
        const resp = await fetch("http://localhost:9424/test")
        const body = await resp.json()
        letters.push(body.letter)
      }
      expect(letters).toEqual(["A", "B", "C", "A", "B", "C"])
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)

  it("repeat mode sticks to last response", async () => {
    const imp = await createImposter(9425)
    await addStub(imp.id, {
      predicates: [],
      responseMode: "repeat",
      responses: [
        { status: 200, body: { letter: "A" } },
        { status: 200, body: { letter: "B" } }
      ]
    })

    await startImposter(imp.id)

    try {
      const letters = []
      for (let i = 0; i < 5; i++) {
        const resp = await fetch("http://localhost:9425/test")
        const body = await resp.json()
        letters.push(body.letter)
      }
      expect(letters).toEqual(["A", "B", "B", "B", "B"])
    } finally {
      await stopImposter(imp.id)
    }
  }, 10000)
})
