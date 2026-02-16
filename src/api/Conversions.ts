import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { ImposterRecord } from "../repositories/ImposterRepository.js"
import { NonEmptyString, type PaginationMeta, PortNumber, PositiveInteger } from "../schemas/common.js"
import type { ImposterResponse } from "../schemas/ImposterSchema.js"

export const toImposterResponse = (record: ImposterRecord): Effect.Effect<ImposterResponse> =>
  Effect.gen(function*() {
    const config = record.config
    const now = yield* Clock.currentTimeMillis
    const uptime = Duration.millis(now - DateTime.toEpochMillis(config.createdAt))
    return {
      id: NonEmptyString.make(config.id),
      name: NonEmptyString.make(config.name),
      port: PortNumber.make(config.port),
      protocol: "HTTP" as const,
      status: config.status,
      endpointCount: record.stubs.length,
      createdAt: config.createdAt,
      adminUrl: NonEmptyString.make(`http://localhost:${config.port}`),
      adminPath: NonEmptyString.make("/_admin"),
      uptime: Duration.format(uptime),
      ...(config.proxy !== undefined ? { proxy: config.proxy } : {})
    }
  })

export const buildPaginationMeta = (total: number, limit: number, offset: number): PaginationMeta => ({
  total,
  limit: PositiveInteger.make(limit),
  offset,
  hasMore: offset + limit < total
})
