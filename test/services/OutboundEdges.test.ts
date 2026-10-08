import { TIMELINE_BUCKET_MS, TIMELINE_BUCKETS } from "imposters/services/MetricsAggregates"
import {
  emptyEdges,
  OUTBOUND_DURATIONS,
  type OutboundSample,
  recordOutbound,
  snapshotEdges
} from "imposters/services/OutboundEdges"
import { describe, expect, it } from "vitest"

const NOW = 10 * TIMELINE_BUCKET_MS

// `status: null` makes a call that got no response
const sample = (
  overrides: Partial<Omit<OutboundSample, "status">> & { readonly status?: number | null } = {}
): OutboundSample => {
  const { status = 200, ...rest } = overrides
  return {
    host: "127.0.0.1:3002",
    via: "callback",
    atMs: NOW,
    durationMs: 10,
    ...rest,
    ...(status !== null ? { status } : {})
  }
}

const fold = (samples: ReadonlyArray<OutboundSample>, cap?: number) =>
  samples.reduce((edges, s) => recordOutbound(edges, s, cap), emptyEdges)

describe("recordOutbound", () => {
  it("counts calls, failures (no response) and 5xx per host", () => {
    const edges = fold([sample(), sample({ status: 503 }), sample({ status: null }), sample({ status: 404 })])
    const [edge] = snapshotEdges(edges, NOW)
    expect(edge).toMatchObject({ host: "127.0.0.1:3002", via: "callback", calls: 4, failed: 1, serverErrors: 1 })
  })

  it("keys by lower-cased host, and marks a host reached both ways", () => {
    const edges = fold([sample({ host: "API.example:80" }), sample({ host: "api.example:80", via: "proxy" })])
    expect(snapshotEdges(edges, NOW).map((e) => [e.host, e.via, e.calls])).toEqual([["api.example:80", "both", 2]])
  })

  it("keeps the latest call time even when an older call is recorded late", () => {
    const edges = fold([sample({ atMs: NOW }), sample({ atMs: NOW - 5000 })])
    expect(snapshotEdges(edges, NOW)[0]?.lastAt).toBe(NOW)
  })

  it("takes p50 and p95 from the last 128 durations", () => {
    const old = Array.from({ length: 50 }, () => sample({ durationMs: 10_000 }))
    const recent = Array.from({ length: OUTBOUND_DURATIONS }, (_, i) => sample({ durationMs: i + 1 }))
    const [edge] = snapshotEdges(fold([...old, ...recent]), NOW)
    expect(edge?.p50).toBe(64)
    expect(edge?.p95).toBe(122)
  })

  it("counts { calls, failed } into the 30 s timeline ending now", () => {
    const edges = fold([
      sample({ atMs: NOW }),
      sample({ atMs: NOW, status: null }),
      sample({ atMs: NOW - TIMELINE_BUCKET_MS })
    ])
    const timeline = snapshotEdges(edges, NOW)[0]?.timeline ?? []
    expect(timeline).toHaveLength(TIMELINE_BUCKETS)
    expect(timeline.at(-1)).toEqual({ start: NOW, calls: 2, failed: 1 })
    expect(timeline.at(-2)).toEqual({ start: NOW - TIMELINE_BUCKET_MS, calls: 1, failed: 0 })
  })

  it("evicts the least recently seen host past the cap", () => {
    const edges = fold([
      sample({ host: "a", atMs: 1 }),
      sample({ host: "b", atMs: 3 }),
      sample({ host: "c", atMs: 2 }),
      sample({ host: "d", atMs: 4 })
    ], 3)
    expect(snapshotEdges(edges, NOW).map((e) => e.host)).toEqual(["d", "b", "c"])
  })

  it("lists the most recently called host first, and an edge without durations has no percentiles", () => {
    expect(snapshotEdges(emptyEdges, NOW)).toEqual([])
    const edges = fold([sample({ host: "x", atMs: 1 }), sample({ host: "y", atMs: 2 })])
    expect(snapshotEdges(edges, NOW).map((e) => e.host)).toEqual(["y", "x"])
  })

  it("counts a refused call as failed but keeps it out of the percentiles", () => {
    const edges = fold([
      sample({ durationMs: 40 }),
      sample({ status: null, durationMs: 0, refused: true }),
      sample({ status: null, durationMs: 0, refused: true })
    ])
    const [edge] = snapshotEdges(edges, NOW)
    expect(edge?.calls).toBe(3)
    expect(edge?.failed).toBe(2)
    expect(edge?.p50).toBe(40)
  })
})
