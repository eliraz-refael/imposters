import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { buildPaginationMeta, toImposterResponse } from "imposters/api/Conversions.js"
import { ImposterConfig } from "imposters/domain/imposter.js"
import type { ImposterRecord } from "imposters/repositories/ImposterRepository.js"
import { describe, expect, it } from "vitest"

describe("Conversions", () => {
  describe("toImposterResponse", () => {
    it("converts an ImposterRecord to ImposterResponse", async () => {
      const config = ImposterConfig({
        id: "test-123",
        name: "my-imposter",
        port: 3000,
        status: "stopped",
        createdAt: DateTime.unsafeNow()
      })
      const record: ImposterRecord = { config, stubs: [] }

      const response = await Effect.runPromise(toImposterResponse(record))

      expect(response.id).toBe("test-123")
      expect(response.name).toBe("my-imposter")
      expect(response.port).toBe(3000)
      expect(response.protocol).toBe("HTTP")
      expect(response.status).toBe("stopped")
      expect(response.endpointCount).toBe(0)
      expect(response.adminUrl).toBe("http://localhost:3000")
      expect(response.adminPath).toBe("/_admin")
      expect(response.uptime).toBeDefined()
    })

    it("endpointCount reflects number of stubs", async () => {
      const config = ImposterConfig({
        id: "test-456",
        name: "with-stubs",
        port: 3001,
        status: "stopped",
        createdAt: DateTime.unsafeNow()
      })
      const record: ImposterRecord = {
        config,
        stubs: [
          { id: "s1" as any, predicates: [], responses: [{ status: 200 }] as any, responseMode: "sequential" },
          { id: "s2" as any, predicates: [], responses: [{ status: 404 }] as any, responseMode: "sequential" }
        ]
      }

      const response = await Effect.runPromise(toImposterResponse(record))
      expect(response.endpointCount).toBe(2)
    })
  })

  describe("buildPaginationMeta", () => {
    it("builds correct pagination with hasMore = true", () => {
      const meta = buildPaginationMeta(100, 10, 0)
      expect(meta.total).toBe(100)
      expect(meta.limit).toBe(10)
      expect(meta.offset).toBe(0)
      expect(meta.hasMore).toBe(true)
    })

    it("builds correct pagination with hasMore = false", () => {
      const meta = buildPaginationMeta(5, 10, 0)
      expect(meta.total).toBe(5)
      expect(meta.limit).toBe(10)
      expect(meta.offset).toBe(0)
      expect(meta.hasMore).toBe(false)
    })

    it("handles offset correctly for hasMore", () => {
      const meta = buildPaginationMeta(15, 10, 10)
      expect(meta.hasMore).toBe(false)

      const meta2 = buildPaginationMeta(25, 10, 10)
      expect(meta2.hasMore).toBe(true)
    })
  })
})
