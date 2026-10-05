import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { ImposterConfig } from "imposters/domain/imposter"
import { NonEmptyString } from "imposters/schemas/common"
import type { RequestLogEntry } from "imposters/schemas/RequestLogSchema"
import { CreateStubRequest, Stub } from "imposters/schemas/StubSchema"
import { emptyTimeline, recordInTimeline, recordUnmatched, timelineAt } from "imposters/services/MetricsAggregates"
import type { MetricsSnapshot } from "imposters/services/MetricsService"
import { clockTime } from "imposters/ui/components/format"
import {
  buildLiveData,
  type LiveData,
  nextResponseText,
  requestsLastMinute,
  type StubHits,
  stubHitsLine,
  stubLabel
} from "imposters/ui/LiveData"
import { liveFragment, livePage, requestRow } from "imposters/ui/pages/live"
import { draftFromQuery, draftStubFrom, draftStubUrl } from "imposters/ui/stubDraft"
import { describe, expect, it } from "vitest"

const HOSTILE = "<img src=x onerror=alert(1)>"

const stub = (input: Record<string, unknown>): Stub =>
  Schema.decodeUnknownSync(Stub)({ id: "s1", predicates: [], responses: [{ status: 200 }], ...input })

const methodPath = (method: string, path: string, operator = "equals") => [
  { field: "method", operator: "equals", value: method },
  { field: "path", operator, value: path }
]

const config = (overrides: Partial<Parameters<typeof ImposterConfig>[0]> = {}): ImposterConfig =>
  ImposterConfig({
    id: "imp",
    name: "orders-api",
    port: 3202,
    protocol: "HTTP",
    status: "running",
    createdAt: DateTime.makeUnsafe(0),
    ...overrides
  })

const NOW = 1_759_659_292_311

const entry = (overrides: {
  readonly id?: string
  readonly method?: string
  readonly path?: string
  readonly status?: number
  readonly matchedStubId?: string
  readonly outcome?: RequestLogEntry["response"]["outcome"]
  readonly duration?: number
} = {}): RequestLogEntry => ({
  id: NonEmptyString.make(overrides.id ?? "req-1"),
  imposterId: NonEmptyString.make("imp"),
  timestamp: DateTime.makeUnsafe(NOW),
  request: { method: overrides.method ?? "GET", path: overrides.path ?? "/orders", headers: {}, query: {} },
  response: {
    status: overrides.status ?? 200,
    headers: {},
    proxied: false,
    outcome: overrides.outcome ?? (overrides.matchedStubId !== undefined ? "stub" : "unmatched"),
    ...(overrides.matchedStubId !== undefined ? { matchedStubId: NonEmptyString.make(overrides.matchedStubId) } : {})
  },
  duration: overrides.duration ?? 1
})

const snapshot = (overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot => {
  const timeline = timelineAt(emptyTimeline, NOW)
  return {
    totalRequests: 0,
    requestsPerMinute: 0,
    averageResponseTime: 0,
    errorRate: 0,
    serverErrorRate: 0,
    requestsByMethod: {},
    requestsByStatusCode: {},
    timeline,
    last15Minutes: { requests: 0, serverErrors: 0, unmatched: 0 },
    stubs: new Map(),
    unmatched: [],
    ...overrides
  }
}

const hits = (s: Stub, byResponse: ReadonlyArray<number>, nextIndex?: number): StubHits => ({
  stub: s,
  position: 1,
  hits: byResponse.reduce((a, b) => a + b, 0),
  byResponse,
  nextIndex
})

describe("draftStubFrom", () => {
  it("drafts a stub for the method and path that the admin API accepts as it is", () => {
    const draft = draftStubFrom("get", "/payments/pm_81")
    expect(draft.predicates).toEqual([
      { field: "method", operator: "equals", value: "GET" },
      { field: "path", operator: "equals", value: "/payments/pm_81" }
    ])
    const decoded = Schema.decodeUnknownSync(CreateStubRequest)(draft)
    expect(decoded.responses[0].status).toBe(200)
    expect(decoded.responseMode).toBe("sequential")
  })

  it("links to the stubs page with the request encoded, and reads it back", () => {
    const url = draftStubUrl("post", "/a b?c=1&draft=x")
    expect(url).toBe("/_admin/stubs?draft=POST&path=%2Fa+b%3Fc%3D1%26draft%3Dx")
    const back = draftFromQuery(new URL(url, "http://localhost").searchParams)
    expect(back?.method).toBe("POST")
    expect(back?.path).toBe("/a b?c=1&draft=x")
    expect(back?.stub).toEqual(draftStubFrom("POST", "/a b?c=1&draft=x"))
  })

  it("ignores a query that is not a method and an absolute path", () => {
    const parse = (query: string) => draftFromQuery(new URLSearchParams(query))
    expect(parse("")).toBeNull()
    expect(parse("draft=GET")).toBeNull()
    expect(parse("draft=G%20T&path=/x")).toBeNull()
    expect(parse(`draft=${encodeURIComponent(HOSTILE)}&path=/x`)).toBeNull()
    expect(parse("draft=GET&path=relative")).toBeNull()
    expect(parse(`draft=GET&path=/${"a".repeat(2048)}`)).toBeNull()
  })
})

describe("stubLabel", () => {
  it("reads method and path predicates as a route", () => {
    expect(stubLabel(stub({ predicates: methodPath("get", "/orders") }))).toBe("GET /orders")
    expect(stubLabel(stub({ predicates: [{ field: "path", operator: "equals", value: "/slow" }] }))).toBe("* /slow")
    expect(stubLabel(stub({ predicates: methodPath("GET", "/products/", "startsWith") }))).toBe("GET /products/*")
    expect(stubLabel(stub({ predicates: methodPath("GET", "^/users/\\d+$", "matches") }))).toBe("GET ~^/users/\\d+$")
    expect(stubLabel(stub({ predicates: [{ field: "method", operator: "equals", value: "DELETE" }] }))).toBe(
      "DELETE *"
    )
  })

  it("counts the other predicates, and names a stub with none a catch-all", () => {
    const withHeader = [...methodPath("POST", "/orders"), { field: "headers", operator: "exists", value: "x" }]
    expect(stubLabel(stub({ predicates: withHeader }))).toBe("POST /orders +1")
    expect(stubLabel(stub({ predicates: [] }))).toBe("catch-all")
  })
})

describe("next response", () => {
  const twoStatuses = stub({ responses: [{ status: 200 }, { status: 503 }] })

  it("names the response a sequential stub gives next", () => {
    expect(nextResponseText(hits(twoStatuses, [3, 2], 1))).toBe("sequential, next: 503")
    expect(stubHitsLine(hits(twoStatuses, [812, 812], 0))).toBe("200 × 812 · 503 × 812 · sequential, next: 200")
  })

  it("says which of two responses with the same status is next", () => {
    const repeated = stub({ responses: [{ status: 202 }, { status: 202 }, { status: 500 }], responseMode: "repeat" })
    expect(nextResponseText(hits(repeated, [1, 0, 0], 1))).toBe("repeat, next: 202 (#2)")
  })

  it("says a random stub's next response cannot be known", () => {
    const random = stub({ responses: [{ status: 200 }, { status: 200 }, { status: 503 }], responseMode: "random" })
    expect(nextResponseText(hits(random, [11, 10, 17]))).toBe("random, next: any of 3")
    expect(stubHitsLine(hits(random, [11, 10, 17]))).toContain("random, next: any of 3")
  })

  it("leaves the mode out for one response, and shows its delay", () => {
    const slow = stub({ responses: [{ status: 200, delay: 2000 }] })
    expect(nextResponseText(hits(slow, [96], 0))).toBeUndefined()
    expect(stubHitsLine(hits(slow, [96], 0))).toBe("200 × 96 · delay 2,000 ms")
    const ranged = stub({ responses: [{ status: 200, delay: { min: 150, max: 900 } }, { status: 500 }] })
    expect(stubHitsLine(hits(ranged, [1, 0], 1))).toBe("200 × 1 (delay 150–900 ms) · 500 × 0 · sequential, next: 500")
  })
})

describe("requestsLastMinute", () => {
  const start = Math.floor(NOW / 30_000) * 30_000
  const at = (offsetMs: number, requests: number) =>
    Array.from({ length: requests }).reduce<ReturnType<typeof timelineAt>>(
      (timeline) => recordInTimeline(timeline, start + offsetMs, { requests: 1, serverErrors: 0, unmatched: 0 }),
      emptyTimeline
    )

  it("adds the bucket in progress, the one before, and the older one's share still inside the minute", () => {
    let timeline = emptyTimeline
    for (const [offset, n] of [[-60_000, 30], [-30_000, 10], [0, 4]] as const) {
      for (let i = 0; i < n; i++) {
        timeline = recordInTimeline(timeline, start + offset, { requests: 1, serverErrors: 0, unmatched: 0 })
      }
    }
    // 10 s into the current bucket: 20 s of the oldest bucket is still within the last minute
    expect(requestsLastMinute(timelineAt(timeline, start + 10_000), start + 10_000)).toBeCloseTo(
      4 + 10 + 30 * (20 / 30)
    )
    // At the end of the current bucket the oldest has left the minute
    expect(requestsLastMinute(timelineAt(timeline, start + 29_999), start + 29_999)).toBeCloseTo(14 + 30 / 30_000)
  })

  it("is zero with no traffic", () => {
    expect(requestsLastMinute(timelineAt(at(0, 0), NOW), NOW)).toBe(0)
    expect(requestsLastMinute([], NOW)).toBe(0)
  })
})

describe("buildLiveData", () => {
  it("hides an unmatched group that a current stub now answers, and keeps the others", () => {
    const stubs = [stub({ id: "orders", predicates: methodPath("GET", "/orders") })]
    let groups = recordUnmatched(new Map(), {
      method: "GET",
      path: "/orders",
      atMs: NOW - 5000,
      sample: entry({ path: "/orders" })
    })
    groups = recordUnmatched(groups, {
      method: "GET",
      path: "/health",
      atMs: NOW - 1000,
      sample: entry({ path: "/health" })
    })
    const data = buildLiveData({
      config: config(),
      stubs,
      snapshot: snapshot({ stubs: new Map([["orders", { hits: 2, byResponse: [2], lastHitAt: NOW }]]) }),
      unmatched: Array.from(groups.values()),
      nextIndex: new Map([["orders", 0]]),
      nowMs: NOW
    })
    expect(data.unmatched.map((row) => row.path)).toEqual(["/health"])
    expect(data.stubHits).toEqual([{ stub: stubs[0], position: 1, hits: 2, byResponse: [2], nextIndex: 0 }])
  })
})

// ---------------------------------------------------------------- templates

const liveData = (overrides: Partial<LiveData> = {}): LiveData => ({
  ...buildLiveData({
    config: config(),
    stubs: [],
    snapshot: snapshot(),
    unmatched: [],
    nextIndex: new Map(),
    nowMs: NOW
  }),
  ...overrides
})

describe("requestRow", () => {
  it("links to the request, prints the time in UTC, and names the stub by position and path", () => {
    const stubs = [stub({ id: "a" }), stub({ id: "b", predicates: methodPath("GET", "/orders") })]
    const row = requestRow(entry({ id: "r 1", matchedStubId: "b", status: 503 }), { stubs, protocol: "HTTP" }).value
    expect(row).toContain(`href="/_admin/requests/r%201"`)
    expect(row).toContain(clockTime(NOW))
    expect(row).toContain("#2 /orders")
    expect(row).toContain(`class="req-status num c-error">503<`)
  })

  it("says what answered when no stub did", () => {
    const ctx = { stubs: [], protocol: "S3" }
    expect(requestRow(entry({ status: 404 }), ctx).value).toContain("no match")
    expect(requestRow(entry({ outcome: "extension" }), ctx).value).toContain(">S3<")
    expect(requestRow(entry({ outcome: "proxy" }), ctx).value).toContain(">proxy<")
    expect(requestRow(entry({ matchedStubId: "gone" }), ctx).value).toContain("removed stub")
  })

  it("escapes a hostile path and method", () => {
    const row = requestRow(entry({ method: HOSTILE, path: `/${HOSTILE}` }), { stubs: [], protocol: "HTTP" }).value
    expect(row).not.toContain("<img")
    expect(row).toContain("&lt;img src=x onerror=alert(1)&gt;")
  })

  it("carries the log's sequence number when it has one, for ui.js to order by", () => {
    expect(requestRow(entry({}), { stubs: [], protocol: "HTTP" }, 42).value).toContain(`id="req-req-1" data-seq="42"`)
    expect(requestRow(entry({}), { stubs: [], protocol: "HTTP" }).value).not.toContain("data-seq")
  })

  it("marks a slow answer", () => {
    expect(requestRow(entry({ duration: 2004 }), { stubs: [], protocol: "HTTP" }).value).toContain(
      `class="req-ms num c-warn">2,004 ms<`
    )
  })
})

describe("livePage", () => {
  it("wires the stream, its pause button, the reload and the poll", () => {
    const page = livePage(liveData(), { theme: null, recent: [] }).value
    expect(page).toContain(`data-sse="/_admin/events"`)
    expect(page).toContain(`data-sse-event="request"`)
    expect(page).toContain(`data-sse-reload="/_admin/fragments/requests"`)
    expect(page).toContain(`data-sse-pause="#live-rows"`)
    expect(page).toContain("data-sse-count")
    expect(page).toContain(`data-poll="10000" data-poll-throttle="1000" data-url="/_admin/fragments/live"`)
    // An empty list is :empty, so its placeholder shows
    expect(page).toContain(`data-sse-max="20"></div>`)
    expect(page).not.toContain("cdn.tailwindcss.com")
  })

  it("renders the theme on <html>, and links to the admin UI when it knows where it is", () => {
    expect(livePage(liveData(), { theme: "light", recent: [] }).value).toContain(`<html lang="en" data-theme="light">`)
    expect(livePage(liveData(), { theme: null, recent: [] }).value).toContain(`<html lang="en">`)
    expect(livePage(liveData(), { theme: null, recent: [], adminUiUrl: "http://h:2525/_ui" }).value).toContain(
      `href="http://h:2525/_ui" aria-label="All imposters"`
    )
  })

  it("escapes a hostile imposter name, stub value and unmatched path", () => {
    const hostileStub = stub({ id: "x", predicates: methodPath("GET", `/${HOSTILE}`) })
    const data = liveData({
      config: config({ name: HOSTILE }),
      stubs: [hostileStub],
      stubHits: [{ ...hits(hostileStub, [1], 0), position: 1 }],
      unmatched: [{ method: "GET", path: `/${HOSTILE}`, count: 2, lastSeenAt: NOW - 3000 }]
    })
    const page = livePage(data, { theme: null, recent: [{ entry: entry({ path: `/${HOSTILE}` }), seq: 1 }] }).value
    expect(page).not.toContain("<img")
    expect(page).toContain("/_admin/stubs?draft=GET&amp;path=%2F%3Cimg")
  })

  it("lists unmatched groups with a stub-it link, or says nothing is unmatched", () => {
    const withMisses = liveData({
      unmatched: [
        { method: "GET", path: "/payments/pm_81", count: 7, lastSeenAt: NOW - 3000 },
        { method: "POST", path: "/orders", count: 3, lastSeenAt: NOW - 7000 }
      ]
    })
    const page = livePage(withMisses, { theme: null, recent: [] }).value
    expect(page).toContain("no stub matched · 10")
    expect(page).toContain("× 7 · last 3s ago")
    expect(page).toContain(`href="/_admin/stubs?draft=GET&amp;path=%2Fpayments%2Fpm_81"`)

    const quiet = liveData({ stats: { ...liveData().stats, totalRequests: 5 } })
    expect(livePage(quiet, { theme: null, recent: [] }).value).toContain("nothing unmatched")
  })

  it("says an extension or a proxy answers what no stub matches", () => {
    const s3 = liveData({ config: config({ protocol: "S3" }) })
    expect(livePage(s3, { theme: null, recent: [] }).value).toContain("the S3 extension answers what no stub matches")
  })

  it("shows the totals since start, the 5xx share and the latencies", () => {
    const data = liveData({
      stats: {
        ...liveData().stats,
        totalRequests: 1731,
        serverErrorRate: 0.489,
        p50: 1,
        p95: 2004,
        p99: 2006
      }
    })
    const page = livePage(data, { theme: null, recent: [] }).value
    expect(page).toContain(">1,731<")
    expect(page).toContain(`class="stat-value c-warn">48.9%<`)
    expect(page).toContain("1 · 2,004 · 2,006 <span class=\"stat-unit\">ms</span>")
  })
})

describe("liveFragment", () => {
  it("answers the side panels with the stats and the stubs count out of band", () => {
    const fragment = liveFragment(liveData({ stubs: [stub({})] })).value
    expect(fragment).toContain(`id="live-stats" aria-label="Stats" data-oob`)
    expect(fragment).toContain(`id="tab-stubs-count" data-oob>1<`)
    expect(fragment).toContain("stub hits")
  })
})
