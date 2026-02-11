import { Config, Context, Layer } from "effect"

export interface AppConfigShape {
  readonly adminPort: number
  readonly portRangeMin: number
  readonly portRangeMax: number
  readonly maxImposters: number
  readonly logLevel: "debug" | "info" | "warn" | "error"
}

export class AppConfig extends Context.Tag("AppConfig")<AppConfig, AppConfigShape>() {}

const config = Config.all({
  adminPort: Config.number("ADMIN_PORT").pipe(Config.withDefault(2525)),
  portRangeMin: Config.number("PORT_RANGE_MIN").pipe(Config.withDefault(3000)),
  portRangeMax: Config.number("PORT_RANGE_MAX").pipe(Config.withDefault(4000)),
  maxImposters: Config.number("MAX_IMPOSTERS").pipe(Config.withDefault(100)),
  logLevel: Config.literal("debug", "info", "warn", "error")("LOG_LEVEL")
    .pipe(Config.withDefault("info" as const))
})

export const AppConfigLive = Layer.effect(AppConfig, config)
