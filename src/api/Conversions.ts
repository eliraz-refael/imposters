import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { ImposterRecord } from "../repositories/ImposterRepository.js"
import { NonEmptyString, type PaginationMeta, PortNumber, PositiveInteger } from "../schemas/common.js"
import type { ImposterResponse, Statistics, StubStatistics } from "../schemas/ImposterSchema.js"
import type { Stub } from "../schemas/StubSchema.js"
import { padByResponse } from "../services/MetricsAggregates.js"
import type { MetricsSnapshot } from "../services/MetricsService.js"

export const toImposterResponse = (record: ImposterRecord): Effect.Effect<ImposterResponse> =>
  Effect.gen(function*() {
    const config = record.config
    const now = yield* Clock.currentTimeMillis
    const uptime = Duration.millis(now - DateTime.toEpochMillis(config.createdAt))
    return {
      id: NonEmptyString.make(config.id),
      name: NonEmptyString.make(config.name),
      port: PortNumber.make(config.port),
      protocol: config.protocol,
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

/**
 * The API's statistics: the metrics snapshot, with a row for every current stub (in matching
 * order, zeros if it has not been hit) carrying the response it gives next.
 */
export const toStatistics = (
  snapshot: MetricsSnapshot,
  stubs: ReadonlyArray<Stub>,
  nextResponseIndex: ReadonlyMap<string, number>
): Statistics => {
  const { stubs: counters, timeline, unmatched, ...rest } = snapshot
  const stubRow = (stub: Stub): StubStatistics => {
    const hit = counters.get(stub.id)
    const next = nextResponseIndex.get(stub.id)
    return {
      stubId: stub.id,
      hits: hit?.hits ?? 0,
      byResponse: padByResponse(hit?.byResponse ?? [], stub.responses.length),
      ...(hit !== undefined ? { lastHitAt: DateTime.makeUnsafe(hit.lastHitAt) } : {}),
      ...(next !== undefined ? { nextResponseIndex: next } : {})
    }
  }
  return {
    ...rest,
    timeline: timeline.map(({ start, ...counts }) => ({ start: DateTime.makeUnsafe(start), ...counts })),
    stubs: stubs.map(stubRow),
    unmatched: unmatched.map(({ lastSeenAt, ...group }) => ({ ...group, lastSeenAt: DateTime.makeUnsafe(lastSeenAt) }))
  }
}
