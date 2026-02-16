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

const createImposter = async (handler: (req: Request) => Promise<Response>, name: string) => {
  const res = await handler(new Request("http://localhost/imposters", json({ name })))
  return res.json()
}

describe("Stubs API", () => {
  it("POST /imposters/:id/stubs adds a stub", async () => {
    const { dispose, handler } = makeHandler()
    try {
      const imposter = await createImposter(handler, "stub-test")

      const res = await handler(
        new Request(
          `http://localhost/imposters/${imposter.id}/stubs`,
          json({
            responses: [{ status: 200, body: { hello: "world" } }]
          })
        )
      )
      expect(res.status).toBe(201)
      const stub = await res.json()
      expect(stub.id).toBeDefined()
      expect(stub.responses).toHaveLength(1)
      expect(stub.responses[0].status).toBe(200)
      expect(stub.predicates).toEqual([])
      expect(stub.responseMode).toBe("sequential")
    } finally {
      await dispose()
    }
  })

  it("POST /imposters/:id/stubs with predicates", async () => {
    const { dispose, handler } = makeHandler()
    try {
      const imposter = await createImposter(handler, "predicate-test")

      const res = await handler(
        new Request(
          `http://localhost/imposters/${imposter.id}/stubs`,
          json({
            predicates: [{ field: "path", operator: "equals", value: "/hello" }],
            responses: [{ status: 200, body: "matched" }]
          })
        )
      )
      expect(res.status).toBe(201)
      const stub = await res.json()
      expect(stub.predicates).toHaveLength(1)
      expect(stub.predicates[0].field).toBe("path")
    } finally {
      await dispose()
    }
  })

  it("POST /imposters/:id/stubs returns 404 for non-existent imposter", async () => {
    const { dispose, handler } = makeHandler()
    try {
      const res = await handler(
        new Request(
          "http://localhost/imposters/nonexistent/stubs",
          json({
            responses: [{ status: 200 }]
          })
        )
      )
      expect(res.status).toBe(404)
    } finally {
      await dispose()
    }
  })

  it("GET /imposters/:id/stubs lists stubs", async () => {
    const { dispose, handler } = makeHandler()
    try {
      const imposter = await createImposter(handler, "list-stubs")

      await handler(
        new Request(
          `http://localhost/imposters/${imposter.id}/stubs`,
          json({
            responses: [{ status: 200 }]
          })
        )
      )
      await handler(
        new Request(
          `http://localhost/imposters/${imposter.id}/stubs`,
          json({
            responses: [{ status: 404 }]
          })
        )
      )

      const res = await handler(new Request(`http://localhost/imposters/${imposter.id}/stubs`))
      expect(res.status).toBe(200)
      const stubs = await res.json()
      expect(stubs).toHaveLength(2)
    } finally {
      await dispose()
    }
  })

  it("GET /imposters/:id/stubs returns 404 for non-existent imposter", async () => {
    const { dispose, handler } = makeHandler()
    try {
      const res = await handler(new Request("http://localhost/imposters/nonexistent/stubs"))
      expect(res.status).toBe(404)
    } finally {
      await dispose()
    }
  })

  it("PUT /imposters/:id/stubs/:stubId updates a stub", async () => {
    const { dispose, handler } = makeHandler()
    try {
      const imposter = await createImposter(handler, "update-stub")
      const createRes = await handler(
        new Request(
          `http://localhost/imposters/${imposter.id}/stubs`,
          json({
            responses: [{ status: 200 }]
          })
        )
      )
      const stub = await createRes.json()

      const res = await handler(
        new Request(`http://localhost/imposters/${imposter.id}/stubs/${stub.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ responses: [{ status: 404, body: "not found" }] })
        })
      )
      expect(res.status).toBe(200)
      const updated = await res.json()
      expect(updated.responses[0].status).toBe(404)
    } finally {
      await dispose()
    }
  })

  it("PUT /imposters/:id/stubs/:stubId returns 404 for non-existent stub", async () => {
    const { dispose, handler } = makeHandler()
    try {
      const imposter = await createImposter(handler, "no-stub")
      const res = await handler(
        new Request(`http://localhost/imposters/${imposter.id}/stubs/nonexistent`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ responses: [{ status: 200 }] })
        })
      )
      expect(res.status).toBe(404)
    } finally {
      await dispose()
    }
  })

  it("DELETE /imposters/:id/stubs/:stubId removes a stub", async () => {
    const { dispose, handler } = makeHandler()
    try {
      const imposter = await createImposter(handler, "delete-stub")
      const createRes = await handler(
        new Request(
          `http://localhost/imposters/${imposter.id}/stubs`,
          json({
            responses: [{ status: 200 }]
          })
        )
      )
      const stub = await createRes.json()

      const res = await handler(
        new Request(`http://localhost/imposters/${imposter.id}/stubs/${stub.id}`, {
          method: "DELETE"
        })
      )
      expect(res.status).toBe(200)
      const deleted = await res.json()
      expect(deleted.id).toBe(stub.id)

      // Confirm it's gone
      const listRes = await handler(new Request(`http://localhost/imposters/${imposter.id}/stubs`))
      const stubs = await listRes.json()
      expect(stubs).toHaveLength(0)
    } finally {
      await dispose()
    }
  })

  it("DELETE /imposters/:id/stubs/:stubId returns 404 for non-existent stub", async () => {
    const { dispose, handler } = makeHandler()
    try {
      const imposter = await createImposter(handler, "no-stub-del")
      const res = await handler(
        new Request(`http://localhost/imposters/${imposter.id}/stubs/nonexistent`, {
          method: "DELETE"
        })
      )
      expect(res.status).toBe(404)
    } finally {
      await dispose()
    }
  })

  it("adding stubs updates imposter endpointCount", async () => {
    const { dispose, handler } = makeHandler()
    try {
      const imposter = await createImposter(handler, "count-test")
      expect(imposter.endpointCount).toBe(0)

      await handler(
        new Request(
          `http://localhost/imposters/${imposter.id}/stubs`,
          json({
            responses: [{ status: 200 }]
          })
        )
      )

      const getRes = await handler(new Request(`http://localhost/imposters/${imposter.id}`))
      const updated = await getRes.json()
      expect(updated.endpointCount).toBe(1)
    } finally {
      await dispose()
    }
  })
})
