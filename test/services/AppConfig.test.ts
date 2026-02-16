import { it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { AppConfig, AppConfigLive } from "imposters/services/AppConfig.js"
import { describe, expect } from "vitest"

describe("AppConfig", () => {
  it.effect("applies default values when no env vars set", () =>
    Effect.gen(function*() {
      const config = yield* AppConfig
      expect(config.adminPort).toBe(2525)
      expect(config.portRangeMin).toBe(3000)
      expect(config.portRangeMax).toBe(4000)
      expect(config.maxImposters).toBe(100)
      expect(config.logLevel).toBe("info")
    }).pipe(
      Effect.provide(AppConfigLive),
      Effect.provide(Layer.setConfigProvider(ConfigProvider.fromMap(new Map())))
    ))

  it.effect("custom env vars override defaults", () =>
    Effect.gen(function*() {
      const config = yield* AppConfig
      expect(config.adminPort).toBe(9999)
      expect(config.portRangeMin).toBe(5000)
      expect(config.logLevel).toBe("debug")
    }).pipe(
      Effect.provide(AppConfigLive),
      Effect.provide(Layer.setConfigProvider(ConfigProvider.fromMap(
        new Map([
          ["ADMIN_PORT", "9999"],
          ["PORT_RANGE_MIN", "5000"],
          ["LOG_LEVEL", "debug"]
        ])
      )))
    ))

  it.effect("fails with ConfigError for invalid values", () =>
    Effect.gen(function*() {
      const result = yield* Effect.flip(
        AppConfig.pipe(
          Effect.provide(AppConfigLive),
          Effect.provide(Layer.setConfigProvider(ConfigProvider.fromMap(
            new Map([
              ["ADMIN_PORT", "not-a-number"]
            ])
          )))
        )
      )
      expect(result._tag).toBe("ConfigError")
    }))
})
