import { Clock, Context, Effect, HashMap, Layer, Option, Ref } from "effect"
import * as DateTime from "effect/DateTime"
import type { RequestLogEntry } from "../schemas/RequestLogSchema.js"
import {
  emptyTimeline,
  recordInTimeline,
  recordStubHit,
  recordUnmatched,
  sortUnmatched,
  type StubCounters,
  sumCounts,
  type Timeline,
  timelineAt,
  type TimelineBucket,
  type TimelineCounts,
  type UnmatchedGroup,
  type UnmatchedGroups
} from "./MetricsAggregates.js"
import {
  emptyEdges,
  type OutboundEdges,
  type OutboundEdgeSnapshot,
  type OutboundSample,
  recordOutbound as recordEdge,
  snapshotEdges
} from "./OutboundEdges.js"

const BUFFER_SIZE = 1000

interface ImposterMetrics {
  totalRequests: number
  requestsByMethod: Record<string, number>
  requestsByStatusCode: Record<string, number>
  responseTimes: Float64Array
  responseTimeIndex: number
  responseTimeCount: number
  firstRequestAt: DateTime.Utc
  lastRequestAt: DateTime.Utc
  errorCount: number
  serverErrorCount: number
  timeline: Timeline
  stubs: ReadonlyMap<string, StubCounters>
  unmatched: UnmatchedGroups<RequestLogEntry>
}

/** One unmatched `METHOD path` group, without its sample request */
export interface UnmatchedSummary {
  readonly method: string
  readonly path: string
  readonly count: number
  readonly lastSeenAt: number
}

export interface MetricsSnapshot {
  readonly totalRequests: number
  readonly requestsPerMinute: number
  readonly averageResponseTime: number
  /** 4xx and 5xx answers over all requests */
  readonly errorRate: number
  /** 5xx answers over all requests */
  readonly serverErrorRate: number
  readonly requestsByMethod: Record<string, number>
  readonly requestsByStatusCode: Record<string, number>
  readonly lastRequestAt?: DateTime.Utc
  readonly p50ResponseTime?: number
  readonly p95ResponseTime?: number
  readonly p99ResponseTime?: number
  /** The last 15 minutes in 30-second buckets, oldest first, ending at the Clock's now */
  readonly timeline: ReadonlyArray<TimelineBucket>
  /** The timeline summed */
  readonly last15Minutes: TimelineCounts
  /** Hit counters by stub id, for stubs that have been hit */
  readonly stubs: ReadonlyMap<string, StubCounters>
  /** Unmatched groups, most recently seen first */
  readonly unmatched: ReadonlyArray<UnmatchedSummary>
  /** Outbound calls (callbacks and proxy forwards) by target host, most recently called first */
  readonly outbound: ReadonlyArray<OutboundEdgeSnapshot>
}

/** @deprecated Use MetricsSnapshot */
export type Statistics = MetricsSnapshot

const makeEmptyMetrics = (now: DateTime.Utc): ImposterMetrics => ({
  totalRequests: 0,
  requestsByMethod: {},
  requestsByStatusCode: {},
  responseTimes: new Float64Array(BUFFER_SIZE),
  responseTimeIndex: 0,
  responseTimeCount: 0,
  firstRequestAt: now,
  lastRequestAt: now,
  errorCount: 0,
  serverErrorCount: 0,
  timeline: emptyTimeline,
  stubs: new Map(),
  unmatched: new Map()
})

const computePercentile = (sorted: ReadonlyArray<number>, p: number): number => {
  if (sorted.length === 0) return 0
  const index = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, index)] ?? 0
}

const ratio = (part: number, total: number): number => total > 0 ? Math.round((part / total) * 10000) / 10000 : 0

const toSummary = (group: UnmatchedGroup<RequestLogEntry>): UnmatchedSummary => ({
  method: group.method,
  path: group.path,
  count: group.count,
  lastSeenAt: group.lastSeenAt
})

const computeStats = (metrics: ImposterMetrics, nowMs: number): Omit<MetricsSnapshot, "outbound"> => {
  const count = metrics.responseTimeCount
  const total = metrics.totalRequests
  const bufferLen = Math.min(count, BUFFER_SIZE)
  const times = Array.from(metrics.responseTimes.subarray(0, bufferLen))

  // Compute average response time
  const sumRT = times.reduce((sum, t) => sum + t, 0)
  const avgRT = bufferLen > 0 ? sumRT / bufferLen : 0

  // Compute requests per minute
  const elapsedMs = DateTime.toEpochMillis(metrics.lastRequestAt) - DateTime.toEpochMillis(metrics.firstRequestAt)
  const elapsedMinutes = elapsedMs / 60000
  const rpm = elapsedMinutes > 0 ? total / elapsedMinutes : total

  // Compute percentiles
  const sorted = times.sort((a, b) => a - b)

  const timeline = timelineAt(metrics.timeline, nowMs)

  return {
    totalRequests: total,
    requestsPerMinute: Math.round(rpm * 100) / 100,
    averageResponseTime: Math.round(avgRT * 100) / 100,
    errorRate: ratio(metrics.errorCount, total),
    serverErrorRate: ratio(metrics.serverErrorCount, total),
    requestsByMethod: { ...metrics.requestsByMethod },
    requestsByStatusCode: { ...metrics.requestsByStatusCode },
    ...(total > 0 ? { lastRequestAt: metrics.lastRequestAt } : {}),
    ...(bufferLen > 0
      ? {
        p50ResponseTime: computePercentile(sorted, 50),
        p95ResponseTime: computePercentile(sorted, 95),
        p99ResponseTime: computePercentile(sorted, 99)
      }
      : {}),
    timeline,
    last15Minutes: sumCounts(timeline),
    stubs: metrics.stubs,
    unmatched: sortUnmatched(metrics.unmatched).map(toSummary)
  }
}

const emptySnapshot = (nowMs: number): Omit<MetricsSnapshot, "outbound"> => {
  const timeline = timelineAt(emptyTimeline, nowMs)
  return {
    totalRequests: 0,
    requestsPerMinute: 0,
    averageResponseTime: 0,
    errorRate: 0,
    serverErrorRate: 0,
    requestsByMethod: {},
    requestsByStatusCode: {},
    timeline,
    last15Minutes: sumCounts(timeline),
    stubs: new Map(),
    unmatched: []
  }
}

// Folds one logged request into an imposter's metrics. The response-time ring buffer is
// updated in place (it is never shared outside the Ref); everything else is replaced.
const recordEntry = (metrics: ImposterMetrics, entry: RequestLogEntry): ImposterMetrics => {
  const atMs = DateTime.toEpochMillis(entry.timestamp)
  const status = entry.response.status
  const method = entry.request.method.toUpperCase()
  const statusKey = String(status)
  const serverError = status >= 500
  const unmatched = entry.response.outcome === "unmatched"
  const stubId = entry.response.matchedStubId

  metrics.responseTimes[metrics.responseTimeIndex % BUFFER_SIZE] = entry.duration

  const stubs = stubId !== undefined && entry.response.outcome === "stub"
    ? new Map(metrics.stubs).set(
      stubId,
      recordStubHit(metrics.stubs.get(stubId), entry.response.responseIndex ?? 0, atMs)
    )
    : metrics.stubs

  return {
    ...metrics,
    totalRequests: metrics.totalRequests + 1,
    requestsByMethod: { ...metrics.requestsByMethod, [method]: (metrics.requestsByMethod[method] ?? 0) + 1 },
    requestsByStatusCode: {
      ...metrics.requestsByStatusCode,
      [statusKey]: (metrics.requestsByStatusCode[statusKey] ?? 0) + 1
    },
    responseTimeIndex: (metrics.responseTimeIndex + 1) % BUFFER_SIZE,
    responseTimeCount: metrics.responseTimeCount + 1,
    // Error tracking: errorRate counts 4xx + 5xx, serverErrorRate 5xx only
    errorCount: metrics.errorCount + (status >= 400 ? 1 : 0),
    serverErrorCount: metrics.serverErrorCount + (serverError ? 1 : 0),
    // Entries are recorded when they finish, so a slow request can arrive after a later one
    firstRequestAt: DateTime.min(metrics.firstRequestAt, entry.timestamp),
    lastRequestAt: DateTime.max(metrics.lastRequestAt, entry.timestamp),
    timeline: recordInTimeline(metrics.timeline, atMs, {
      requests: 1,
      serverErrors: serverError ? 1 : 0,
      unmatched: unmatched ? 1 : 0
    }),
    stubs,
    unmatched: unmatched
      ? recordUnmatched(metrics.unmatched, { method, path: entry.request.path, atMs, sample: entry })
      : metrics.unmatched
  }
}

export interface MetricsServiceShape {
  readonly recordRequest: (entry: RequestLogEntry) => Effect.Effect<void>
  /** Counts one outbound call into the imposter's edge for its host; inbound counters ignore it */
  readonly recordOutbound: (imposterId: string, sample: OutboundSample) => Effect.Effect<void>
  /** The imposter's metrics as of the Clock's now (the timeline window ends there) */
  readonly getStats: (imposterId: string) => Effect.Effect<MetricsSnapshot>
  /** The unmatched groups with their latest request each, most recently seen first */
  readonly getUnmatched: (imposterId: string) => Effect.Effect<ReadonlyArray<UnmatchedGroup<RequestLogEntry>>>
  /** Forgets everything recorded for the imposter */
  readonly resetStats: (imposterId: string) => Effect.Effect<void>
  /** Forgets one stub's hit counters */
  readonly resetStub: (imposterId: string, stubId: string) => Effect.Effect<void>
}

export class MetricsService extends Context.Service<MetricsService, MetricsServiceShape>()("MetricsService") {}

export const MetricsServiceLive = Layer.effect(
  MetricsService,
  Effect.gen(function*() {
    const storeRef = yield* Ref.make(HashMap.empty<string, ImposterMetrics>())
    // Kept apart from the inbound metrics, which are created by the first request recorded
    const outboundRef = yield* Ref.make(HashMap.empty<string, OutboundEdges>())

    const recordOutbound = (imposterId: string, sample: OutboundSample): Effect.Effect<void> =>
      Ref.update(outboundRef, (store) =>
        HashMap.set(
          store,
          imposterId,
          recordEdge(Option.getOrElse(HashMap.get(store, imposterId), () => emptyEdges), sample)
        ))

    const recordRequest = (entry: RequestLogEntry): Effect.Effect<void> =>
      Ref.update(storeRef, (store) => {
        const metrics = Option.getOrElse(HashMap.get(store, entry.imposterId), () => makeEmptyMetrics(entry.timestamp))
        return HashMap.set(store, entry.imposterId, recordEntry(metrics, entry))
      })

    const getStats = (imposterId: string): Effect.Effect<MetricsSnapshot> =>
      Effect.gen(function*() {
        const nowMs = yield* Clock.currentTimeMillis
        const store = yield* Ref.get(storeRef)
        const edges = Option.getOrElse(HashMap.get(yield* Ref.get(outboundRef), imposterId), () => emptyEdges)
        const inbound = Option.match(HashMap.get(store, imposterId), {
          onNone: () => emptySnapshot(nowMs),
          onSome: (metrics) => computeStats(metrics, nowMs)
        })
        return { ...inbound, outbound: snapshotEdges(edges, nowMs) }
      })

    const getUnmatched = (imposterId: string): Effect.Effect<ReadonlyArray<UnmatchedGroup<RequestLogEntry>>> =>
      Ref.get(storeRef).pipe(
        Effect.map((store) =>
          Option.match(HashMap.get(store, imposterId), {
            onNone: () => [],
            onSome: (metrics) => sortUnmatched(metrics.unmatched)
          })
        )
      )

    const resetStats = (imposterId: string): Effect.Effect<void> =>
      Effect.andThen(
        Ref.update(storeRef, HashMap.remove(imposterId)),
        Ref.update(outboundRef, HashMap.remove(imposterId))
      )

    const resetStub = (imposterId: string, stubId: string): Effect.Effect<void> =>
      Ref.update(storeRef, (store) =>
        Option.match(HashMap.get(store, imposterId), {
          onNone: () => store,
          onSome: (metrics) => {
            if (!metrics.stubs.has(stubId)) return store
            const stubs = new Map(metrics.stubs)
            stubs.delete(stubId)
            return HashMap.set(store, imposterId, { ...metrics, stubs })
          }
        }))

    return {
      recordRequest,
      recordOutbound,
      getStats,
      getUnmatched,
      resetStats,
      resetStub
    } satisfies MetricsServiceShape
  })
)
