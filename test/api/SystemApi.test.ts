import { HttpApiBuilder } from "@effect/platform"
import * as Layer from "effect/Layer"
import { ApiLayer } from "imposters/layers/ApiLayer"
import { MainLayer } from "imposters/layers/MainLayer"
import { describe, expect, it } from "vitest"

const makeHandler = () => {
  const fullLayer = ApiLayer.pipe(Layer.provide(MainLayer))
  return HttpApiBuilder.toWebHandler(fullLayer)
}

describe("System API", () => {
  it("GET /health returns healthy status", async () => {
    const { dispose, handler } = makeHandler()
    try {
      const res = await handler(new Request("http://localhost/health"))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe("healthy")
      expect(body.version).toBe("0.0.0")
      expect(body.uptime).toBeDefined()
      expect(body.timestamp).toBeDefined()
      expect(body.system).toBeDefined()
      expect(body.system.memory.used).toBeDefined()
      expect(body.system.imposters.total).toBe(0)
      expect(body.system.ports.allocated).toBe(0)
    } finally {
      await dispose()
    }
  })

  it("GET /health reflects imposter count", async () => {
    const { dispose, handler } = makeHandler()
    try {
      // Create an imposter first
      await handler(
        new Request("http://localhost/imposters", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "health-check" })
        })
      )

      const res = await handler(new Request("http://localhost/health"))
      const body = await res.json()
      expect(body.system.imposters.total).toBe(1)
      expect(body.system.imposters.stopped).toBe(1)
      expect(body.system.ports.allocated).toBe(1)
    } finally {
      await dispose()
    }
  })

  it("GET /info returns server info", async () => {
    const { dispose, handler } = makeHandler()
    try {
      const res = await handler(new Request("http://localhost/info"))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.server.name).toBe("imposters")
      expect(body.server.version).toBe("0.0.0")
      expect(body.server.protocols).toEqual(["HTTP"])
      expect(body.configuration.maxImposters).toBe(100)
      expect(body.configuration.portRange.min).toBe(3000)
      expect(body.configuration.portRange.max).toBe(4000)
      expect(body.features.openApiGeneration).toBe(true)
      expect(body.features.authentication).toBe(false)
    } finally {
      await dispose()
    }
  })

  it("GET /openapi.json returns OpenAPI spec", async () => {
    const { dispose, handler } = makeHandler()
    try {
      const res = await handler(new Request("http://localhost/openapi.json"))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.openapi).toBeDefined()
      expect(body.paths).toBeDefined()
    } finally {
      await dispose()
    }
  })
})
