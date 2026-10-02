import {
  bucketStart,
  emptyTimeline,
  padByResponse,
  recordInTimeline,
  recordStubHit,
  recordUnmatched,
  sortUnmatched,
  sumCounts,
  type Timeline,
  TIMELINE_BUCKET_MS,
  TIMELINE_BUCKETS,
  timelineAt,
  type UnmatchedGroups
} from "imposters/services/MetricsAggregates"
import { describe, expect, it } from "vitest"

const S = TIMELINE_BUCKET_MS
// An arbitrary, bucket-aligned instant well past 0
const T0 = 1_000 * S

const one = { requests: 1, serverErrors: 0, unmatched: 0 }
const record = (timeline: Timeline, atMs: number, delta = one) => recordInTimeline(timeline, atMs, delta)

describe("timelineAt", () => {
  it("returns 30 zero buckets ending at the bucket now falls in, oldest first", () => {
    const points = timelineAt(emptyTimeline, T0 + 12_345)
    expect(points).toHaveLength(TIMELINE_BUCKETS)
    expect(points[TIMELINE_BUCKETS - 1]?.start).toBe(T0)
    expect(points[0]?.start).toBe(T0 - (TIMELINE_BUCKETS - 1) * S)
    for (let i = 1; i < points.length; i++) {
      expect((points[i]?.start ?? 0) - (points[i - 1]?.start ?? 0)).toBe(S)
    }
    expect(sumCounts(points)).toEqual({ requests: 0, serverErrors: 0, unmatched: 0 })
  })

  it("zero-fills the gaps between buckets with traffic", () => {
    let timeline = record(emptyTimeline, T0 - 5 * S + 1)
    timeline = record(timeline, T0 - 5 * S + 2)
    timeline = record(timeline, T0 - 2 * S, { requests: 1, serverErrors: 1, unmatched: 1 })
    const points = timelineAt(timeline, T0)
    const last = TIMELINE_BUCKETS - 1
    expect(points[last - 5]).toEqual({ start: T0 - 5 * S, requests: 2, serverErrors: 0, unmatched: 0 })
    expect(points[last - 4]).toEqual({ start: T0 - 4 * S, requests: 0, serverErrors: 0, unmatched: 0 })
    expect(points[last - 3]?.requests).toBe(0)
    expect(points[last - 2]).toEqual({ start: T0 - 2 * S, requests: 1, serverErrors: 1, unmatched: 1 })
    expect(points[last]?.requests).toBe(0)
    expect(sumCounts(points)).toEqual({ requests: 3, serverErrors: 1, unmatched: 1 })
  })

  it("puts the last millisecond of a bucket in it and the next millisecond in the next one", () => {
    let timeline = record(emptyTimeline, T0 + S - 1)
    timeline = record(timeline, T0 + S)
    const points = timelineAt(timeline, T0 + S)
    expect(points[TIMELINE_BUCKETS - 2]).toMatchObject({ start: T0, requests: 1 })
    expect(points[TIMELINE_BUCKETS - 1]).toMatchObject({ start: T0 + S, requests: 1 })
    expect(bucketStart(T0 + S - 1)).toBe(T0)
    expect(bucketStart(T0 + S)).toBe(T0 + S)
  })

  it("slides: a bucket leaves the window 15 minutes after it started", () => {
    const timeline = record(emptyTimeline, T0)
    // Still the oldest point 29 buckets later
    const stillIn = timelineAt(timeline, T0 + (TIMELINE_BUCKETS - 1) * S)
    expect(stillIn[0]).toMatchObject({ start: T0, requests: 1 })
    // Gone one bucket after that, though its slot was never overwritten
    const slid = timelineAt(timeline, T0 + TIMELINE_BUCKETS * S)
    expect(slid[0]?.start).toBe(T0 + S)
    expect(sumCounts(slid).requests).toBe(0)
  })

  it("recycles a stale slot instead of adding to it", () => {
    let timeline = record(emptyTimeline, T0)
    // Same slot, one full ring later
    timeline = record(timeline, T0 + TIMELINE_BUCKETS * S)
    const points = timelineAt(timeline, T0 + TIMELINE_BUCKETS * S)
    expect(points[TIMELINE_BUCKETS - 1]).toMatchObject({ start: T0 + TIMELINE_BUCKETS * S, requests: 1 })
    expect(sumCounts(points).requests).toBe(1)
  })

  it("drops a late record whose slot already holds a newer bucket", () => {
    const newer = record(emptyTimeline, T0 + TIMELINE_BUCKETS * S)
    expect(record(newer, T0)).toBe(newer)
  })

  it("handles instants before the first full window (a TestClock at 0)", () => {
    const points = timelineAt(record(emptyTimeline, 0), 0)
    expect(points[TIMELINE_BUCKETS - 1]).toMatchObject({ start: 0, requests: 1 })
    expect(sumCounts(points).requests).toBe(1)
  })
})

describe("recordStubHit", () => {
  it("counts hits per response and keeps the latest hit time", () => {
    let counters = recordStubHit(undefined, 0, 100)
    counters = recordStubHit(counters, 2, 300)
    counters = recordStubHit(counters, 0, 200)
    expect(counters).toEqual({ hits: 3, byResponse: [2, 0, 1], lastHitAt: 300 })
  })

  it("does not change the counters it was given", () => {
    const first = recordStubHit(undefined, 1, 100)
    recordStubHit(first, 1, 200)
    expect(first).toEqual({ hits: 1, byResponse: [0, 1], lastHitAt: 100 })
  })

  it("padByResponse gives every response a slot", () => {
    expect(padByResponse([3], 3)).toEqual([3, 0, 0])
    expect(padByResponse([1, 2], 1)).toEqual([1, 2])
  })
})

describe("recordUnmatched", () => {
  const hit = (groups: UnmatchedGroups<string>, method: string, path: string, atMs: number, cap?: number) =>
    recordUnmatched(groups, { method, path, atMs, sample: `${method} ${path} @${atMs}` }, cap)

  it("groups by upper-cased method and path, counting and keeping the latest sample", () => {
    let groups: UnmatchedGroups<string> = new Map()
    groups = hit(groups, "get", "/a", 10)
    groups = hit(groups, "GET", "/a", 30)
    groups = hit(groups, "GET", "/a", 20)
    groups = hit(groups, "POST", "/a", 15)
    expect(groups.size).toBe(2)
    expect(groups.get("GET /a")).toEqual({ method: "GET", path: "/a", count: 3, lastSeenAt: 30, sample: "GET /a @30" })
    expect(groups.get("POST /a")?.count).toBe(1)
  })

  it("evicts the least recently seen group at the cap", () => {
    let groups: UnmatchedGroups<string> = new Map()
    groups = hit(groups, "GET", "/a", 10, 3)
    groups = hit(groups, "GET", "/b", 20, 3)
    groups = hit(groups, "GET", "/c", 30, 3)
    // /a is seen again, so /b is now the least recently seen
    groups = hit(groups, "GET", "/a", 40, 3)
    groups = hit(groups, "GET", "/d", 50, 3)
    expect(Array.from(groups.keys()).sort()).toEqual(["GET /a", "GET /c", "GET /d"])
    expect(groups.get("GET /a")?.count).toBe(2)
  })

  it("keeps 50 groups by default", () => {
    let groups: UnmatchedGroups<string> = new Map()
    for (let i = 0; i < 60; i++) groups = hit(groups, "GET", `/p${i}`, i)
    expect(groups.size).toBe(50)
    expect(groups.has("GET /p9")).toBe(false)
    expect(groups.has("GET /p10")).toBe(true)
  })

  it("sortUnmatched lists the most recently seen first", () => {
    let groups: UnmatchedGroups<string> = new Map()
    groups = hit(groups, "GET", "/old", 10)
    groups = hit(groups, "GET", "/new", 30)
    groups = hit(groups, "GET", "/mid", 20)
    expect(sortUnmatched(groups).map((g) => g.path)).toEqual(["/new", "/mid", "/old"])
  })
})
