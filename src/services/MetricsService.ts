import { Context, Effect, HashMap, Layer, Ref } from "effect"
import * as DateTime from "effect/DateTime"
import type { RequestLogEntry } from "../schemas/RequestLogSchema"

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
}

export interface Statistics {
  readonly totalRequests: number
  readonly requestsPerMinute: number
  readonly averageResponseTime: number
  readonly errorRate: number
  readonly requestsByMethod: Record<string, number>
  readonly requestsByStatusCode: Record<string, number>
  readonly lastRequestAt?: DateTime.Utc
  readonly p50ResponseTime?: number
  readonly p95ResponseTime?: number
  readonly p99ResponseTime?: number
}

const makeEmptyMetrics = (now: DateTime.Utc): ImposterMetrics => ({
  totalRequests: 0,
  requestsByMethod: {},
  requestsByStatusCode: {},
  responseTimes: new Float64Array(BUFFER_SIZE),
  responseTimeIndex: 0,
  responseTimeCount: 0,
  firstRequestAt: now,
  lastRequestAt: now,
  errorCount: 0
})

const computePercentile = (sorted: Array<number>, p: number): number => {
  if (sorted.length === 0) return 0
  const index = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, index)]!
}

const computeStats = (metrics: ImposterMetrics): Statistics => {
  const count = metrics.responseTimeCount
  const total = metrics.totalRequests

  // Compute average response time
  let sumRT = 0
  for (let i = 0; i < Math.min(count, BUFFER_SIZE); i++) {
    sumRT += metrics.responseTimes[i]!
  }
  const avgRT = count > 0 ? sumRT / Math.min(count, BUFFER_SIZE) : 0

  // Compute requests per minute
  const elapsedMs = DateTime.toEpochMillis(metrics.lastRequestAt) - DateTime.toEpochMillis(metrics.firstRequestAt)
  const elapsedMinutes = elapsedMs / 60000
  const rpm = elapsedMinutes > 0 ? total / elapsedMinutes : total

  // Compute error rate
  const errorRate = total > 0 ? metrics.errorCount / total : 0

  // Compute percentiles
  const bufferLen = Math.min(count, BUFFER_SIZE)
  const sorted = Array.from(metrics.responseTimes.subarray(0, bufferLen)).sort((a, b) => a - b)

  return {
    totalRequests: total,
    requestsPerMinute: Math.round(rpm * 100) / 100,
    averageResponseTime: Math.round(avgRT * 100) / 100,
    errorRate: Math.round(errorRate * 10000) / 10000,
    requestsByMethod: { ...metrics.requestsByMethod },
    requestsByStatusCode: { ...metrics.requestsByStatusCode },
    ...(total > 0 ? { lastRequestAt: metrics.lastRequestAt } : {}),
    ...(bufferLen > 0
      ? {
        p50ResponseTime: computePercentile(sorted, 50),
        p95ResponseTime: computePercentile(sorted, 95),
        p99ResponseTime: computePercentile(sorted, 99)
      }
      : {})
  }
}

export interface MetricsServiceShape {
  readonly recordRequest: (entry: RequestLogEntry) => Effect.Effect<void>
  readonly getStats: (imposterId: string) => Effect.Effect<Statistics>
  readonly resetStats: (imposterId: string) => Effect.Effect<void>
}

export class MetricsService extends Context.Tag("MetricsService")<MetricsService, MetricsServiceShape>() {}

export const MetricsServiceLive = Layer.effect(
  MetricsService,
  Effect.gen(function*() {
    const storeRef = yield* Ref.make(HashMap.empty<string, ImposterMetrics>())

    const recordRequest = (entry: RequestLogEntry): Effect.Effect<void> =>
      Ref.update(storeRef, (store) => {
        const existing = HashMap.get(store, entry.imposterId)
        const now = entry.timestamp
        const metrics = existing._tag === "Some" ? existing.value : makeEmptyMetrics(now)

        metrics.totalRequests += 1

        // Method counts
        const method = entry.request.method.toUpperCase()
        metrics.requestsByMethod[method] = (metrics.requestsByMethod[method] ?? 0) + 1

        // Status code counts
        const statusKey = String(entry.response.status)
        metrics.requestsByStatusCode[statusKey] = (metrics.requestsByStatusCode[statusKey] ?? 0) + 1

        // Response time circular buffer
        metrics.responseTimes[metrics.responseTimeIndex % BUFFER_SIZE] = entry.duration
        metrics.responseTimeIndex = (metrics.responseTimeIndex + 1) % BUFFER_SIZE
        metrics.responseTimeCount += 1

        // Error tracking (4xx + 5xx)
        if (entry.response.status >= 400) {
          metrics.errorCount += 1
        }

        metrics.lastRequestAt = now

        return HashMap.set(store, entry.imposterId, metrics)
      })

    const getStats = (imposterId: string): Effect.Effect<Statistics> =>
      Ref.get(storeRef).pipe(
        Effect.map((store) => {
          const existing = HashMap.get(store, imposterId)
          if (existing._tag === "None") {
            return {
              totalRequests: 0,
              requestsPerMinute: 0,
              averageResponseTime: 0,
              errorRate: 0,
              requestsByMethod: {},
              requestsByStatusCode: {}
            }
          }
          return computeStats(existing.value)
        })
      )

    const resetStats = (imposterId: string): Effect.Effect<void> => Ref.update(storeRef, HashMap.remove(imposterId))

    return { recordRequest, getStats, resetStats } satisfies MetricsServiceShape
  })
)
