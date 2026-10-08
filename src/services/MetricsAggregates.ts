// Pure aggregation behind MetricsService: the traffic timeline, per-stub counters and
// unmatched groups. Every function returns a new value; MetricsService holds them in a Ref.

/** Width of one timeline bucket */
export const TIMELINE_BUCKET_MS = 30_000
/** Buckets in the ring: 30 × 30 s = the last 15 minutes */
export const TIMELINE_BUCKETS = 30
/** Distinct `METHOD path` groups kept per imposter before the least recently seen is evicted */
export const UNMATCHED_GROUP_CAP = 50

export interface TimelineCounts {
  readonly requests: number
  readonly serverErrors: number
  readonly unmatched: number
}

export interface TimelineBucket extends TimelineCounts {
  /** Epoch millis of the bucket's first instant (a multiple of TIMELINE_BUCKET_MS) */
  readonly start: number
}

/** A ring of TIMELINE_BUCKETS slots; a slot whose `start` is not the one expected for it is stale */
export type Timeline = ReadonlyArray<TimelineBucket>

export const zeroCounts: TimelineCounts = { requests: 0, serverErrors: 0, unmatched: 0 }

export const bucketStart = (ms: number): number => Math.floor(ms / TIMELINE_BUCKET_MS) * TIMELINE_BUCKET_MS

const slotOf = (start: number): number => {
  const n = Math.floor(start / TIMELINE_BUCKET_MS) % TIMELINE_BUCKETS
  return n < 0 ? n + TIMELINE_BUCKETS : n
}

const addCounts = (a: TimelineCounts, b: TimelineCounts): TimelineCounts => ({
  requests: a.requests + b.requests,
  serverErrors: a.serverErrors + b.serverErrors,
  unmatched: a.unmatched + b.unmatched
})

// A ring of TIMELINE_BUCKETS slots of any counts, keyed by bucket start (the timeline below,
// and the outbound edges' { calls, failed } in OutboundEdges.ts)
export type Ring<C> = ReadonlyArray<C & { readonly start: number }>

export const emptyRing = <C>(zero: C): Ring<C> =>
  Array.from({ length: TIMELINE_BUCKETS }, () => ({ start: Number.NEGATIVE_INFINITY, ...zero }))

// No real bucket starts at -Infinity, so an empty slot never matches a lookup
export const emptyTimeline: Timeline = emptyRing(zeroCounts)

// Adds `delta` to the slot holding `atMs`. A stale slot is recycled; a record older than what
// its slot now holds (it fell out of the window while in flight) is dropped.
export const recordInRing = <C>(
  ring: Ring<C>,
  atMs: number,
  delta: C,
  zero: C,
  add: (a: C, b: C) => C
): Ring<C> => {
  const start = bucketStart(atMs)
  const slot = slotOf(start)
  const current = ring[slot]
  if (current !== undefined && current.start > start) return ring
  const base: C = current !== undefined && current.start === start ? current : zero
  const next = ring.slice()
  next[slot] = { start, ...add(base, delta) }
  return next
}

// The window ending at `nowMs`, oldest first; slots with no traffic (or stale) come back as zero
export const ringAt = <C>(ring: Ring<C>, nowMs: number, zero: C): ReadonlyArray<C & { readonly start: number }> => {
  const last = bucketStart(nowMs)
  return Array.from({ length: TIMELINE_BUCKETS }, (_, i) => {
    const start = last - (TIMELINE_BUCKETS - 1 - i) * TIMELINE_BUCKET_MS
    const bucket = ring[slotOf(start)]
    return bucket !== undefined && bucket.start === start ? bucket : { start, ...zero }
  })
}

/**
 * Adds `delta` to the bucket holding `atMs`. A stale slot is recycled; a record older than
 * what its slot now holds (it fell out of the window while in flight) is dropped.
 */
export const recordInTimeline = (timeline: Timeline, atMs: number, delta: TimelineCounts): Timeline =>
  recordInRing(timeline, atMs, delta, zeroCounts, addCounts)

/**
 * The window ending at `nowMs`: TIMELINE_BUCKETS points, oldest first, the last one being the
 * bucket `nowMs` falls in. Buckets with no traffic (or stale slots) come back as zeros.
 */
export const timelineAt = (timeline: Timeline, nowMs: number): ReadonlyArray<TimelineBucket> =>
  ringAt(timeline, nowMs, zeroCounts)

export const sumCounts = (points: ReadonlyArray<TimelineCounts>): TimelineCounts => points.reduce(addCounts, zeroCounts)

// --- Per-stub counters -------------------------------------------------------

export interface StubCounters {
  readonly hits: number
  /** Hits per response, indexed like the stub's `responses` */
  readonly byResponse: ReadonlyArray<number>
  /** Epoch millis of the latest hit */
  readonly lastHitAt: number
}

export const recordStubHit = (
  counters: StubCounters | undefined,
  responseIndex: number,
  atMs: number
): StubCounters => {
  const byResponse = counters?.byResponse.slice() ?? []
  while (byResponse.length <= responseIndex) byResponse.push(0)
  byResponse[responseIndex] = (byResponse[responseIndex] ?? 0) + 1
  return {
    hits: (counters?.hits ?? 0) + 1,
    byResponse,
    lastHitAt: counters === undefined ? atMs : Math.max(counters.lastHitAt, atMs)
  }
}

/** `byResponse` padded with zeros to the stub's response count, so every response has a slot */
export const padByResponse = (byResponse: ReadonlyArray<number>, responseCount: number): ReadonlyArray<number> =>
  byResponse.length >= responseCount
    ? byResponse
    : [...byResponse, ...Array.from({ length: responseCount - byResponse.length }, () => 0)]

// --- Unmatched groups --------------------------------------------------------

export interface UnmatchedGroup<S> {
  readonly method: string
  readonly path: string
  readonly count: number
  /** Epoch millis of the latest request in the group */
  readonly lastSeenAt: number
  /** The latest request in the group */
  readonly sample: S
}

export type UnmatchedGroups<S> = ReadonlyMap<string, UnmatchedGroup<S>>

export const unmatchedKey = (method: string, path: string): string => `${method.toUpperCase()} ${path}`

// The key of the group seen longest ago; ties go to the one inserted first
const leastRecentlySeen = <S>(groups: UnmatchedGroups<S>): string | undefined => {
  let oldestKey: string | undefined
  let oldestAt = Number.POSITIVE_INFINITY
  for (const [key, group] of groups) {
    if (group.lastSeenAt < oldestAt) {
      oldestKey = key
      oldestAt = group.lastSeenAt
    }
  }
  return oldestKey
}

/** Counts one unmatched request into its `METHOD path` group, evicting down to `cap` groups */
export const recordUnmatched = <S>(
  groups: UnmatchedGroups<S>,
  request: { readonly method: string; readonly path: string; readonly atMs: number; readonly sample: S },
  cap: number = UNMATCHED_GROUP_CAP
): UnmatchedGroups<S> => {
  const method = request.method.toUpperCase()
  const key = unmatchedKey(method, request.path)
  const existing = groups.get(key)
  const next = new Map(groups)
  if (existing === undefined) {
    while (next.size >= cap) {
      const evict = leastRecentlySeen(next)
      if (evict === undefined) break
      next.delete(evict)
    }
  }
  const newer = existing === undefined || request.atMs >= existing.lastSeenAt
  next.set(key, {
    method,
    path: request.path,
    count: (existing?.count ?? 0) + 1,
    lastSeenAt: newer ? request.atMs : existing.lastSeenAt,
    sample: newer ? request.sample : existing.sample
  })
  return next
}

/** The groups most recently seen first, the busier one first on a tie */
export const sortUnmatched = <S>(groups: UnmatchedGroups<S>): ReadonlyArray<UnmatchedGroup<S>> =>
  Array.from(groups.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt || b.count - a.count)
