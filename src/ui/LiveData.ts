import type { ImposterConfig } from "../domain/imposter.js"
import { contextFromCaptured } from "../matching/Explain.js"
import { findMatchingStub } from "../matching/RequestMatcher.js"
import type { RequestLogEntry } from "../schemas/RequestLogSchema.js"
import type { Delay, Predicate, Stub } from "../schemas/StubSchema.js"
import {
  padByResponse,
  TIMELINE_BUCKET_MS,
  type TimelineBucket,
  type TimelineCounts,
  type UnmatchedGroup
} from "../services/MetricsAggregates.js"
import type { MetricsSnapshot } from "../services/MetricsService.js"
import { count } from "./components/format.js"

/**
 * What an imposter's live page (`/_admin`) shows, built from its metrics by pure functions, so
 * the page template only formats.
 */

/** One stub's line in the hits panel */
export interface StubHits {
  readonly stub: Stub
  // Its place in matching order, from 1
  readonly position: number
  readonly hits: number
  // Hits per response, one per response of the stub
  readonly byResponse: ReadonlyArray<number>
  // The response it gives next; undefined in random mode, where that cannot be known
  readonly nextIndex: number | undefined
  // When it last answered (epoch ms); undefined before its first hit
  readonly lastHitAt: number | undefined
}

/** A `METHOD path` no stub answered */
export interface UnmatchedRow {
  readonly method: string
  readonly path: string
  readonly count: number
  readonly lastSeenAt: number
}

export interface LiveStats {
  readonly totalRequests: number
  // 5xx answers over all requests since start, 0–1
  readonly serverErrorRate: number
  readonly p50?: number
  readonly p95?: number
  readonly p99?: number
  readonly perMinute: number
  // Requests per closed 30-second bucket of the last 15 minutes, oldest first, for the sparkline
  readonly timeline: ReadonlyArray<number>
  readonly last15: TimelineCounts
}

export interface LiveData {
  readonly config: ImposterConfig
  readonly stubs: ReadonlyArray<Stub>
  readonly stats: LiveStats
  readonly stubHits: ReadonlyArray<StubHits>
  // Only the groups no current stub would answer: one the user has since stubbed drops out
  readonly unmatched: ReadonlyArray<UnmatchedRow>
  // The clock the "ago"s are measured against, read once per render
  readonly nowMs: number
}

const MINUTE_MS = 60_000

/**
 * Requests over the last 60 seconds, estimated from 30-second buckets: the bucket in progress,
 * the one before it, and the share of the one before that still inside the minute. Pure.
 */
export const requestsLastMinute = (timeline: ReadonlyArray<TimelineBucket>, nowMs: number): number => {
  const current = timeline.at(-1)
  if (current === undefined) return 0
  const previous = timeline.at(-2)?.requests ?? 0
  const older = timeline.at(-3)?.requests ?? 0
  const elapsed = Math.min(Math.max(nowMs - current.start, 0), TIMELINE_BUCKET_MS)
  const olderShare = (MINUTE_MS - TIMELINE_BUCKET_MS - elapsed) / TIMELINE_BUCKET_MS
  return current.requests + previous + older * Math.max(olderShare, 0)
}

export const buildLiveData = (input: {
  readonly config: ImposterConfig
  readonly stubs: ReadonlyArray<Stub>
  readonly snapshot: MetricsSnapshot
  readonly unmatched: ReadonlyArray<UnmatchedGroup<RequestLogEntry>>
  readonly nextIndex: ReadonlyMap<string, number>
  readonly nowMs: number
}): LiveData => {
  const { nowMs, snapshot, stubs } = input
  const stubHits = stubs.map((stub, i): StubHits => {
    const counters = snapshot.stubs.get(stub.id)
    return {
      stub,
      position: i + 1,
      hits: counters?.hits ?? 0,
      byResponse: padByResponse(counters?.byResponse ?? [], stub.responses.length).slice(0, stub.responses.length),
      nextIndex: input.nextIndex.get(stub.id),
      lastHitAt: counters?.lastHitAt
    }
  })
  const unmatched = input.unmatched
    .filter((group) => findMatchingStub(contextFromCaptured(group.sample.request), stubs) === undefined)
    .map(({ count, lastSeenAt, method, path }) => ({ method, path, count, lastSeenAt }))
  return {
    config: input.config,
    stubs,
    stats: {
      totalRequests: snapshot.totalRequests,
      serverErrorRate: snapshot.serverErrorRate,
      ...(snapshot.p50ResponseTime !== undefined ? { p50: snapshot.p50ResponseTime } : {}),
      ...(snapshot.p95ResponseTime !== undefined ? { p95: snapshot.p95ResponseTime } : {}),
      ...(snapshot.p99ResponseTime !== undefined ? { p99: snapshot.p99ResponseTime } : {}),
      perMinute: requestsLastMinute(snapshot.timeline, nowMs),
      // The bucket in progress is always partial: drawn, it would dip at the right edge
      timeline: snapshot.timeline.slice(0, -1).map((bucket) => bucket.requests),
      last15: snapshot.last15Minutes
    },
    stubHits,
    unmatched,
    nowMs
  }
}

// ---------------------------------------------------------------- how a stub reads

const stringValue = (predicate: Predicate): string | undefined =>
  typeof predicate.value === "string" ? predicate.value : undefined

const pathPart = (predicate: Predicate): string => {
  const value = stringValue(predicate)
  if (value === undefined) return "*"
  switch (predicate.operator) {
    case "equals":
      return value
    case "startsWith":
      return `${value}*`
    case "contains":
      return `*${value}*`
    case "matches":
      return `~${value}`
    case "exists":
      return "*"
  }
}

const isMethodEquals = (p: Predicate): boolean =>
  p.field === "method" && p.operator === "equals" && stringValue(p) !== undefined

/** The path a stub answers, as a short pattern: "/orders", "/products/*", "~^/users/\d+$", or "*" */
export const stubPath = (stub: Stub): string => {
  const path = stub.predicates.find((p) => p.field === "path")
  return path === undefined ? "*" : pathPart(path)
}

/**
 * A stub at a glance: "GET /orders", "* /slow" (any method), "POST /orders +1" (one more
 * predicate, on headers, query or body), or "catch-all" with no predicates at all
 */
export const stubLabel = (stub: Stub): string => {
  if (stub.predicates.length === 0) return "catch-all"
  const method = stub.predicates.find(isMethodEquals)
  const path = stub.predicates.find((p) => p.field === "path")
  const shown = [method, path].filter((p) => p !== undefined).length
  const rest = stub.predicates.length - shown
  const label = `${method === undefined ? "*" : (stringValue(method) ?? "*").toUpperCase()} ${stubPath(stub)}`
  return rest > 0 ? `${label} +${String(rest)}` : label
}

// "2,000 ms", "150–900 ms"
const delayText = (delay: Delay): string =>
  typeof delay === "number" ? `${count(delay)} ms` : `${count(delay.min)}–${count(delay.max)} ms`

// A response's status, with its place when another response of the stub has the same one
const responseName = (stub: Stub, index: number): string => {
  const status = stub.responses[index]?.status ?? 0
  const shared = stub.responses.filter((r) => r.status === status).length > 1
  return shared ? `${String(status)} (#${String(index + 1)})` : String(status)
}

/** What the stub gives next: "sequential, next: 200", "random, next: any of 3", or nothing for one response */
export const nextResponseText = (row: StubHits): string | undefined => {
  const { stub } = row
  if (stub.responses.length < 2) return undefined
  if (stub.responseMode === "random" || row.nextIndex === undefined) {
    return `random, next: any of ${String(stub.responses.length)}`
  }
  return `${stub.responseMode}, next: ${responseName(stub, row.nextIndex)}`
}

/** Each response's hits: "200 × 812 · 503 × 812", with a delay where the response has one */
export const responseHitsText = (row: StubHits): string => {
  const { stub } = row
  return stub.responses.map((response, i) => {
    const hits = `${String(response.status)} × ${count(row.byResponse[i] ?? 0)}`
    if (response.delay === undefined) return hits
    return stub.responses.length === 1
      ? `${hits} · delay ${delayText(response.delay)}`
      : `${hits} (delay ${delayText(response.delay)})`
  }).join(" · ")
}

/** The line under a stub's meter: "200 × 812 · 503 × 812 · sequential, next: 200" */
export const stubHitsLine = (row: StubHits): string => {
  const next = nextResponseText(row)
  return next === undefined ? responseHitsText(row) : `${responseHitsText(row)} · ${next}`
}
