import { HttpApiBuilder } from "@effect/platform"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import { ApiLayer } from "imposters/layers/ApiLayer.js"
import { MainLayer } from "imposters/layers/MainLayer.js"

const makeHandler = () => {
  const fullLayer = ApiLayer.pipe(Layer.provide(MainLayer))
  return HttpApiBuilder.toWebHandler(fullLayer)
}

const json = (body: object) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
})

describe("Imposters API", () => {
  it("POST /imposters creates an imposter with auto-assigned port", async () => {
    const { handler, dispose } = makeHandler()
    try {
      const res = await handler(new Request("http://localhost/imposters", json({ name: "test-imp" })))
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.name).toBe("test-imp")
      expect(body.status).toBe("stopped")
      expect(body.protocol).toBe("HTTP")
      expect(body.port).toBeGreaterThanOrEqual(3000)
      expect(body.id).toBeDefined()
      expect(body.endpointCount).toBe(0)
      expect(body.createdAt).toBeDefined()
    } finally {
      await dispose()
    }
  })

  it("POST /imposters creates an imposter with specified port", async () => {
    const { handler, dispose } = makeHandler()
    try {
      const res = await handler(new Request("http://localhost/imposters", json({ name: "test-port", port: 5555 })))
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.port).toBe(5555)
    } finally {
      await dispose()
    }
  })

  it("POST /imposters with no name auto-generates one", async () => {
    const { handler, dispose } = makeHandler()
    try {
      const res = await handler(new Request("http://localhost/imposters", json({})))
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.name).toBeDefined()
      expect(body.name.length).toBeGreaterThan(0)
    } finally {
      await dispose()
    }
  })

  it("POST /imposters with duplicate port returns 409", async () => {
    const { handler, dispose } = makeHandler()
    try {
      await handler(new Request("http://localhost/imposters", json({ name: "first", port: 6000 })))
      const res = await handler(new Request("http://localhost/imposters", json({ name: "second", port: 6000 })))
      expect(res.status).toBe(409)
    } finally {
      await dispose()
    }
  })

  it("GET /imposters lists imposters", async () => {
    const { handler, dispose } = makeHandler()
    try {
      await handler(new Request("http://localhost/imposters", json({ name: "imp1" })))
      await handler(new Request("http://localhost/imposters", json({ name: "imp2" })))

      const res = await handler(new Request("http://localhost/imposters"))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.imposters).toHaveLength(2)
      expect(body.pagination.total).toBe(2)
      expect(body.pagination.hasMore).toBe(false)
    } finally {
      await dispose()
    }
  })

  it("GET /imposters supports pagination", async () => {
    const { handler, dispose } = makeHandler()
    try {
      await handler(new Request("http://localhost/imposters", json({ name: "a" })))
      await handler(new Request("http://localhost/imposters", json({ name: "b" })))
      await handler(new Request("http://localhost/imposters", json({ name: "c" })))

      const res = await handler(new Request("http://localhost/imposters?limit=2&offset=0"))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.imposters).toHaveLength(2)
      expect(body.pagination.total).toBe(3)
      expect(body.pagination.hasMore).toBe(true)
    } finally {
      await dispose()
    }
  })

  it("GET /imposters filters by status", async () => {
    const { handler, dispose } = makeHandler()
    try {
      await handler(new Request("http://localhost/imposters", json({ name: "imp1" })))

      const res = await handler(new Request("http://localhost/imposters?status=running"))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.imposters).toHaveLength(0)

      const res2 = await handler(new Request("http://localhost/imposters?status=stopped"))
      const body2 = await res2.json()
      expect(body2.imposters).toHaveLength(1)
    } finally {
      await dispose()
    }
  })

  it("GET /imposters/:id returns imposter details", async () => {
    const { handler, dispose } = makeHandler()
    try {
      const createRes = await handler(new Request("http://localhost/imposters", json({ name: "detail-test" })))
      const created = await createRes.json()

      const res = await handler(new Request(`http://localhost/imposters/${created.id}`))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.id).toBe(created.id)
      expect(body.name).toBe("detail-test")
    } finally {
      await dispose()
    }
  })

  it("GET /imposters/:id returns 404 for non-existent", async () => {
    const { handler, dispose } = makeHandler()
    try {
      const res = await handler(new Request("http://localhost/imposters/nonexistent"))
      expect(res.status).toBe(404)
    } finally {
      await dispose()
    }
  })

  it("PATCH /imposters/:id updates name", async () => {
    const { handler, dispose } = makeHandler()
    try {
      const createRes = await handler(new Request("http://localhost/imposters", json({ name: "original" })))
      const created = await createRes.json()

      const res = await handler(new Request(`http://localhost/imposters/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "updated" })
      }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.name).toBe("updated")
    } finally {
      await dispose()
    }
  })

  it("PATCH /imposters/:id updates port (swap)", async () => {
    const { handler, dispose } = makeHandler()
    try {
      const createRes = await handler(new Request("http://localhost/imposters", json({ name: "port-swap", port: 7000 })))
      const created = await createRes.json()

      const res = await handler(new Request(`http://localhost/imposters/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: 7001 })
      }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.port).toBe(7001)

      // Old port should be released, so we can create another imposter on it
      const res2 = await handler(new Request("http://localhost/imposters", json({ name: "reuse-port", port: 7000 })))
      expect(res2.status).toBe(201)
    } finally {
      await dispose()
    }
  })

  it("PATCH /imposters/:id returns 404 for non-existent", async () => {
    const { handler, dispose } = makeHandler()
    try {
      const res = await handler(new Request("http://localhost/imposters/nonexistent", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "nope" })
      }))
      expect(res.status).toBe(404)
    } finally {
      await dispose()
    }
  })

  it("DELETE /imposters/:id deletes a stopped imposter", async () => {
    const { handler, dispose } = makeHandler()
    try {
      const createRes = await handler(new Request("http://localhost/imposters", json({ name: "to-delete" })))
      const created = await createRes.json()

      const res = await handler(new Request(`http://localhost/imposters/${created.id}`, { method: "DELETE" }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.id).toBe(created.id)

      // Confirm it's gone
      const getRes = await handler(new Request(`http://localhost/imposters/${created.id}`))
      expect(getRes.status).toBe(404)
    } finally {
      await dispose()
    }
  })

  it("DELETE /imposters/:id returns 404 for non-existent", async () => {
    const { handler, dispose } = makeHandler()
    try {
      const res = await handler(new Request("http://localhost/imposters/nonexistent", { method: "DELETE" }))
      expect(res.status).toBe(404)
    } finally {
      await dispose()
    }
  })

  it("DELETE /imposters/:id releases the port", async () => {
    const { handler, dispose } = makeHandler()
    try {
      const createRes = await handler(new Request("http://localhost/imposters", json({ name: "port-release", port: 8000 })))
      const created = await createRes.json()

      await handler(new Request(`http://localhost/imposters/${created.id}`, { method: "DELETE" }))

      // Port should be available again
      const res2 = await handler(new Request("http://localhost/imposters", json({ name: "reuse", port: 8000 })))
      expect(res2.status).toBe(201)
    } finally {
      await dispose()
    }
  })
})
