import { emptyRing, recordInRing, type Ring, ringAt } from "./MetricsAggregates.js"

// Pure aggregation of an imposter's outbound calls (callbacks and proxy forwards), one edge per
// target host. Every function returns a new value; MetricsService holds them in a Ref.

// Distinct hosts kept per imposter before the least recently seen is evicted
export const OUTBOUND_HOST_CAP = 50
// Durations kept per edge for its percentiles
export const OUTBOUND_DURATIONS = 128

export type OutboundVia = "callback" | "proxy"

// One outbound call, as OutboundHttp reports it
export interface OutboundSample {
  // URL.host, lower-cased
  readonly host: string
  readonly via: OutboundVia
  // Epoch millis the call started
  readonly atMs: number
  readonly durationMs: number
  // The answer's status; absent when no response came back (or the call was refused)
  readonly status?: number
}

export interface OutboundCounts {
  readonly calls: number
  readonly failed: number
}

const zeroOutbound: OutboundCounts = { calls: 0, failed: 0 }
const addOutbound = (a: OutboundCounts, b: OutboundCounts): OutboundCounts => ({
  calls: a.calls + b.calls,
  failed: a.failed + b.failed
})

export interface OutboundEdge {
  readonly host: string
  readonly via: OutboundVia | "both"
  readonly calls: number
  // Calls that got no response
  readonly failed: number
  // Calls answered 5xx
  readonly serverErrors: number
  // Epoch millis of the latest call
  readonly lastAt: number
  // The last OUTBOUND_DURATIONS durations, oldest first
  readonly durations: ReadonlyArray<number>
  readonly timeline: Ring<OutboundCounts>
}

export type OutboundEdges = ReadonlyMap<string, OutboundEdge>

export const emptyEdges: OutboundEdges = new Map()

const viaOf = (current: OutboundEdge["via"] | undefined, via: OutboundVia): OutboundEdge["via"] =>
  current === undefined || current === via ? via : "both"

const leastRecentlySeen = (edges: OutboundEdges): string | undefined => {
  let oldestKey: string | undefined
  let oldestAt = Number.POSITIVE_INFINITY
  for (const [key, edge] of edges) {
    if (edge.lastAt < oldestAt) {
      oldestKey = key
      oldestAt = edge.lastAt
    }
  }
  return oldestKey
}

/** Counts one call into its host's edge, evicting the least recently seen host past `cap` */
export const recordOutbound = (
  edges: OutboundEdges,
  sample: OutboundSample,
  cap: number = OUTBOUND_HOST_CAP
): OutboundEdges => {
  const host = sample.host.toLowerCase()
  const existing = edges.get(host)
  const next = new Map(edges)
  if (existing === undefined) {
    while (next.size >= cap) {
      const evict = leastRecentlySeen(next)
      if (evict === undefined) break
      next.delete(evict)
    }
  }
  const noResponse = sample.status === undefined
  const durations = [...(existing?.durations ?? []), sample.durationMs].slice(-OUTBOUND_DURATIONS)
  next.set(host, {
    host,
    via: viaOf(existing?.via, sample.via),
    calls: (existing?.calls ?? 0) + 1,
    failed: (existing?.failed ?? 0) + (noResponse ? 1 : 0),
    serverErrors: (existing?.serverErrors ?? 0) + (sample.status !== undefined && sample.status >= 500 ? 1 : 0),
    lastAt: Math.max(existing?.lastAt ?? sample.atMs, sample.atMs),
    durations,
    timeline: recordInRing(
      existing?.timeline ?? emptyRing(zeroOutbound),
      sample.atMs,
      { calls: 1, failed: noResponse ? 1 : 0 },
      zeroOutbound,
      addOutbound
    )
  })
  return next
}

const percentile = (sorted: ReadonlyArray<number>, p: number): number => {
  const index = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, index)] ?? 0
}

// An edge as the stats show it: percentiles instead of the ring, the timeline ending at `nowMs`
export interface OutboundEdgeSnapshot {
  readonly host: string
  readonly via: OutboundEdge["via"]
  readonly calls: number
  readonly failed: number
  readonly serverErrors: number
  readonly lastAt: number
  readonly p50?: number
  readonly p95?: number
  readonly timeline: ReadonlyArray<OutboundCounts & { readonly start: number }>
}

/** The edges most recently called first, the busier one first on a tie */
export const snapshotEdges = (edges: OutboundEdges, nowMs: number): ReadonlyArray<OutboundEdgeSnapshot> =>
  Array.from(edges.values())
    .sort((a, b) => b.lastAt - a.lastAt || b.calls - a.calls)
    .map((edge) => {
      const sorted = [...edge.durations].sort((a, b) => a - b)
      return {
        host: edge.host,
        via: edge.via,
        calls: edge.calls,
        failed: edge.failed,
        serverErrors: edge.serverErrors,
        lastAt: edge.lastAt,
        ...(sorted.length > 0 ? { p50: percentile(sorted, 50), p95: percentile(sorted, 95) } : {}),
        timeline: ringAt(edge.timeline, nowMs, zeroOutbound)
      }
    })
