import { HttpApiBuilder } from "@effect/platform"
import * as Layer from "effect/Layer"
import { ApiLayer } from "imposters/layers/ApiLayer.js"
import { MainLayer } from "imposters/layers/MainLayer.js"
import { describe, expect, it } from "vitest"

const makeHandler = () => {
  const fullLayer = ApiLayer.pipe(Layer.provide(MainLayer))
  return HttpApiBuilder.toWebHandler(fullLayer)
}

const json = (body: object) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
})

describe("Requests API", () => {
  it("GET /imposters/:id/requests returns empty array for new imposter", async () => {
    const { dispose, handler } = makeHandler()
    try {
      const createRes = await handler(new Request("http://localhost/imposters", json({ name: "req-test" })))
      const created = await createRes.json()

      const res = await handler(new Request(`http://localhost/imposters/${created.id}/requests`))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual([])
    } finally {
      await dispose()
    }
  })

  it("GET /imposters/:id/requests returns 404 for non-existent imposter", async () => {
    const { dispose, handler } = makeHandler()
    try {
      const res = await handler(new Request("http://localhost/imposters/nonexistent/requests"))
      expect(res.status).toBe(404)
    } finally {
      await dispose()
    }
  })

  it("DELETE /imposters/:id/requests clears log and returns success", async () => {
    const { dispose, handler } = makeHandler()
    try {
      const createRes = await handler(new Request("http://localhost/imposters", json({ name: "clear-test" })))
      const created = await createRes.json()

      const res = await handler(new Request(`http://localhost/imposters/${created.id}/requests`, { method: "DELETE" }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.message).toContain(created.id)
    } finally {
      await dispose()
    }
  })

  it("DELETE /imposters/:id/requests returns 404 for non-existent imposter", async () => {
    const { dispose, handler } = makeHandler()
    try {
      const res = await handler(new Request("http://localhost/imposters/nonexistent/requests", { method: "DELETE" }))
      expect(res.status).toBe(404)
    } finally {
      await dispose()
    }
  })
})
