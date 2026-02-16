import { Schema } from "effect"
import { AdminConfig, ConfigFile, ImposterConfig } from "imposters/schemas/ConfigFileSchema.js"
import { describe, expect, it } from "vitest"

const decode = Schema.decodeUnknownSync(ConfigFile)
const decodeImposter = Schema.decodeUnknownSync(ImposterConfig)
const decodeAdmin = Schema.decodeUnknownSync(AdminConfig)

describe("ConfigFileSchema", () => {
  describe("ImposterConfig", () => {
    it("decodes minimal config (port only)", () => {
      const result = decodeImposter({ port: 9500 })
      expect(result.port).toBe(9500)
      expect(result.stubs).toEqual([])
    })

    it("decodes full config with stubs", () => {
      const result = decodeImposter({
        name: "Test API",
        port: 9500,
        stubs: [{
          predicates: [{ field: "path", operator: "equals", value: "/hello" }],
          responses: [{ status: 200, body: { message: "hi" } }]
        }]
      })
      expect(result.name).toBe("Test API")
      expect(result.stubs.length).toBe(1)
    })

    it("rejects invalid port", () => {
      expect(() => decodeImposter({ port: 80 })).toThrow()
    })

    it("rejects missing port", () => {
      expect(() => decodeImposter({})).toThrow()
    })
  })

  describe("AdminConfig", () => {
    it("applies defaults for empty object", () => {
      const result = decodeAdmin({})
      expect(result.port).toBe(2525)
      expect(result.portRangeMin).toBe(3000)
      expect(result.portRangeMax).toBe(4000)
      expect(result.maxImposters).toBe(100)
      expect(result.logLevel).toBe("info")
    })

    it("accepts custom values", () => {
      const result = decodeAdmin({
        port: 3000,
        portRangeMin: 5000,
        portRangeMax: 6000,
        maxImposters: 50,
        logLevel: "debug"
      })
      expect(result.port).toBe(3000)
      expect(result.logLevel).toBe("debug")
    })

    it("rejects invalid log level", () => {
      expect(() => decodeAdmin({ logLevel: "verbose" })).toThrow()
    })
  })

  describe("ConfigFile", () => {
    it("applies defaults for empty object", () => {
      const result = decode({})
      expect(result.admin).toBeDefined()
      expect(result.admin.port).toBe(2525)
      expect(result.imposters).toEqual([])
    })

    it("decodes full config file", () => {
      const result = decode({
        admin: { port: 2525 },
        imposters: [
          {
            name: "Test API",
            port: 9500,
            stubs: [{
              predicates: [{ field: "path", operator: "equals", value: "/hello" }],
              responses: [{ status: 200, body: { message: "Hello!" } }]
            }]
          }
        ]
      })
      expect(result.imposters.length).toBe(1)
      expect(result.imposters[0].port).toBe(9500)
    })

    it("decodes config with multiple imposters", () => {
      const result = decode({
        imposters: [
          { port: 9500 },
          { port: 9501, name: "Second" }
        ]
      })
      expect(result.imposters.length).toBe(2)
    })

    it("rejects imposters with invalid structure", () => {
      expect(() => decode({ imposters: [{ invalid: true }] })).toThrow()
    })
  })
})
