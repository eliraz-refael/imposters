import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ImposterRepository } from "../repositories/ImposterRepository"
import { NonEmptyString, PortNumber } from "../schemas/common"
import { AppConfig } from "../services/AppConfig"
import { AdminApi } from "./AdminApi"

export const SystemHandlersLive = HttpApiBuilder.group(AdminApi, "system", (handlers) =>
  Effect.gen(function*() {
    // Resolve services once at layer build time. In v4, a service yielded
    // inside a handler becomes a per-request requirement instead.
    const repo = yield* ImposterRepository
    const config = yield* AppConfig

    return handlers
      .handle("healthCheck", () =>
        Effect.gen(function*() {
          const all = yield* repo.getAll

          const now = yield* Effect.map(Clock.currentTimeMillis, (ms) => DateTime.makeUnsafe(ms))
          const memUsage = process.memoryUsage()

          const running = all.filter((r) => r.config.status === "running").length
          const stopped = all.filter((r) => r.config.status === "stopped").length

          return {
            status: "healthy" as const,
            timestamp: now,
            version: NonEmptyString.make("0.0.0"),
            uptime: Duration.format(Duration.millis(process.uptime() * 1000)),
            system: {
              memory: {
                used: NonEmptyString.make(`${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`),
                free: NonEmptyString.make(`${Math.round((memUsage.heapTotal - memUsage.heapUsed) / 1024 / 1024)}MB`)
              },
              imposters: {
                total: all.length,
                running,
                stopped
              },
              ports: {
                available: config.portRangeMax - config.portRangeMin + 1 - all.length,
                allocated: all.length
              }
            }
          }
        }))
      .handle("serverInfo", () =>
        Effect.gen(function*() {
          const now = yield* Effect.map(Clock.currentTimeMillis, (ms) => DateTime.makeUnsafe(ms))

          return {
            server: {
              name: NonEmptyString.make("imposters"),
              version: NonEmptyString.make("0.0.0"),
              buildTime: now,
              platform: NonEmptyString.make(process.platform),
              protocols: ["HTTP" as const]
            },
            configuration: {
              maxImposters: config.maxImposters,
              portRange: {
                min: PortNumber.make(config.portRangeMin),
                max: PortNumber.make(config.portRangeMax)
              },
              defaultTimeout: 30000,
              logLevel: config.logLevel
            },
            features: {
              openApiGeneration: true,
              clientGeneration: false,
              authentication: false,
              clustering: false
            }
          }
        }))
  }))
