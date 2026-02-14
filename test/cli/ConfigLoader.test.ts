import * as path from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { ConfigLoadError, loadConfigFile } from "imposters/cli/ConfigLoader.js"

const fixturesDir = path.join(__dirname, "..", "fixtures")

describe("ConfigLoader", () => {
  it("loads valid config file", async () => {
    const result = await Effect.runPromise(
      loadConfigFile(path.join(fixturesDir, "sample-config.json"))
    )
    expect(result.admin.port).toBe(2525)
    expect(result.imposters.length).toBe(1)
    expect(result.imposters[0].port).toBe(9500)
    expect(result.imposters[0].name).toBe("Test API")
  })

  it("returns ConfigLoadError for missing file", async () => {
    const result = await Effect.runPromise(
      loadConfigFile("/nonexistent/path.json").pipe(
        Effect.map(() => null),
        Effect.catchTag("ConfigLoadError", (e) => Effect.succeed(e))
      )
    )
    expect(result).toBeInstanceOf(ConfigLoadError)
    expect(result!.message).toContain("Failed to read config file")
  })

  it("returns ConfigLoadError for invalid JSON", async () => {
    // Create a temp file with invalid JSON
    const tmpPath = path.join(fixturesDir, "invalid.json")
    const fs = await import("node:fs")
    fs.writeFileSync(tmpPath, "{ invalid json }", "utf-8")

    try {
      const result = await Effect.runPromise(
        loadConfigFile(tmpPath).pipe(
          Effect.map(() => null),
          Effect.catchTag("ConfigLoadError", (e) => Effect.succeed(e))
        )
      )
      expect(result).toBeInstanceOf(ConfigLoadError)
      expect(result!.message).toContain("Invalid JSON")
    } finally {
      fs.unlinkSync(tmpPath)
    }
  })

  it("returns ConfigLoadError for schema validation failure", async () => {
    const tmpPath = path.join(fixturesDir, "bad-schema.json")
    const fs = await import("node:fs")
    fs.writeFileSync(tmpPath, JSON.stringify({ imposters: [{ invalid: true }] }), "utf-8")

    try {
      const result = await Effect.runPromise(
        loadConfigFile(tmpPath).pipe(
          Effect.map(() => null),
          Effect.catchTag("ConfigLoadError", (e) => Effect.succeed(e))
        )
      )
      expect(result).toBeInstanceOf(ConfigLoadError)
      expect(result!.message).toContain("Config validation failed")
    } finally {
      fs.unlinkSync(tmpPath)
    }
  })

  it("applies defaults for minimal config", async () => {
    const tmpPath = path.join(fixturesDir, "minimal.json")
    const fs = await import("node:fs")
    fs.writeFileSync(tmpPath, JSON.stringify({}), "utf-8")

    try {
      const result = await Effect.runPromise(loadConfigFile(tmpPath))
      expect(result.admin.port).toBe(2525)
      expect(result.admin.maxImposters).toBe(100)
      expect(result.imposters).toEqual([])
    } finally {
      fs.unlinkSync(tmpPath)
    }
  })
})
