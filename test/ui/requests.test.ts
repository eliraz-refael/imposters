import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { ImposterConfig } from "imposters/domain/imposter"
import { NonEmptyString } from "imposters/schemas/common"
import type { CallbackRecord, RequestLogEntry } from "imposters/schemas/RequestLogSchema"
import { Stub } from "imposters/schemas/StubSchema"
import { noticePage, requestDetailPage, requestNotFoundPage } from "imposters/ui/pages/request-detail"
import { requestsPage } from "imposters/ui/pages/requests"
import {
  buildRequestDetail,
  callBody,
  type DetailInput,
  explainEntry,
  parseFilters,
  reasonPhrase,
  responseLine,
  verdictRow
} from "imposters/ui/RequestsData"
import { describe, expect, it } from "vitest"

const HOSTILE = `</script><script>alert("x")</script>'"`
// 2025-10-05T10:14:52.311Z
const NOW = 1_759_659_292_311

const stub = (input: Record<string, unknown>): Stub =>
  Schema.decodeUnknownSync(Stub)({ id: "s1", predicates: [], responses: [{ status: 200 }], ...input })

const methodPath = (method: string, path: string) => [
  { field: "method", operator: "equals", value: method },
  { field: "path", operator: "equals", value: path }
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

interface EntryOpts {
  readonly method?: string
  readonly path?: string
  readonly query?: Record<string, string>
  readonly headers?: Record<string, string>
  readonly body?: unknown
  readonly status?: number
  readonly responseHeaders?: Record<string, string>
  readonly responseBody?: string
  readonly outcome?: RequestLogEntry["response"]["outcome"]
  readonly matchedStubId?: string
  readonly responseIndex?: number
  readonly callbacks?: ReadonlyArray<CallbackRecord>
}

const entry = (o: EntryOpts = {}): RequestLogEntry => ({
  id: NonEmptyString.make("req-1"),
  imposterId: NonEmptyString.make("imp"),
  timestamp: DateTime.makeUnsafe(NOW),
  request: {
    method: o.method ?? "GET",
    path: o.path ?? "/orders",
    headers: o.headers ?? {},
    query: o.query ?? {},
    ...(o.body !== undefined ? { body: o.body } : {})
  },
  response: {
    status: o.status ?? 200,
    headers: o.responseHeaders ?? {},
    ...(o.responseBody !== undefined ? { body: o.responseBody } : {}),
    proxied: o.outcome === "proxy",
    outcome: o.outcome ?? (o.matchedStubId !== undefined ? "stub" : "unmatched"),
    ...(o.matchedStubId !== undefined ? { matchedStubId: NonEmptyString.make(o.matchedStubId) } : {}),
    ...(o.responseIndex !== undefined ? { responseIndex: o.responseIndex } : {})
  },
  duration: 3,
  ...(o.callbacks !== undefined ? { callbacks: o.callbacks } : {})
})

const detail = (input: Partial<DetailInput> & { readonly entry: RequestLogEntry }) =>
  buildRequestDetail({ config: config(), stubs: [], nextIndex: undefined, origin: "http://127.0.0.1:3202", ...input })

const pageOpts = { config: config(), stubCount: 1, theme: null }

const orders = stub({
  id: "orders",
  predicates: methodPath("GET", "/orders"),
  responses: [{ status: 200 }, { status: 503 }]
})
const payments = stub({ id: "payments", predicates: methodPath("POST", "/payments") })

describe("parseFilters", () => {
  it("reads method, path and status, ignoring blanks", () => {
    expect(parseFilters(new URLSearchParams("method=post&path=%2Forders&status=201"))).toEqual({
      filters: { method: "POST", path: "/orders", status: 201 },
      fields: { method: "POST", path: "/orders", status: "201" }
    })
    expect(parseFilters(new URLSearchParams("method=&path=+&status=")).filters).toEqual({})
  })

  it("a status that is not a number is an error, and no filter", () => {
    const parsed = parseFilters(new URLSearchParams("status=5xx"))
    expect(parsed.filters).toEqual({})
    expect(parsed.error).toBe(`Status filter must be a number, got "5xx".`)
    expect(parseFilters(new URLSearchParams("status=1.5")).error).toBeDefined()
  })
})

describe("what answered", () => {
  it("names the stub by its place now, and the response it gave", () => {
    const d = detail({ entry: entry({ matchedStubId: "orders", responseIndex: 1 }), stubs: [payments, orders] })
    expect(d.answered).toEqual({
      kind: "stub",
      stubId: "orders",
      stub: { id: "orders", position: 2, label: "GET /orders" },
      responseIndex: 1,
      responseCount: 2
    })
    const page = requestDetailPage(d, pageOpts).value
    expect(page).toContain(`matched <a href="/_admin/stubs#stub-orders">#2 GET /orders</a>, response 2 of 2`)
  })

  it("a stub since removed, the extension, the proxy and no match", () => {
    const removed = requestDetailPage(detail({ entry: entry({ matchedStubId: "gone-stub-id" }) }), pageOpts).value
    expect(removed).toContain("matched stub <span title=\"gone-stub-id\">gone-stu</span>, since removed")

    const s3 = detail({ entry: entry({ outcome: "extension" }), config: config({ protocol: "S3" }) })
    expect(s3.answered).toEqual({ kind: "extension", protocol: "S3" })
    expect(requestDetailPage(s3, pageOpts).value).toContain("the <span class=\"c-info\">S3</span> extension answered")
    expect(s3.fallback).toBe("the S3 extension")

    const proxied = detail({
      entry: entry({ outcome: "proxy" }),
      config: config({
        proxy: {
          targetUrl: "http://upstream:8080",
          mode: "passthrough",
          removeHeaders: [],
          followRedirects: false,
          timeout: 1000
        }
      })
    })
    expect(requestDetailPage(proxied, pageOpts).value).toContain(
      "proxied to <span class=\"c-info\">http://upstream:8080</span>"
    )

    const none = requestDetailPage(detail({ entry: entry() }), pageOpts).value
    expect(none).toContain(`<span class="c-caution">no stub matched</span>`)
  })

  it("names the response among the stub's, and the next one where it is known", () => {
    expect(responseLine(orders, 1, 0)).toBe("sequential: answered #2 of 2, next is #1")
    expect(responseLine(stub({ ...orders, responseMode: "random" }), 0, undefined)).toBe("random: answered #1 of 2")
    expect(responseLine(stub({ id: "one" }), 0, 0)).toBeUndefined()
    expect(responseLine(orders, undefined, 0)).toBeUndefined()

    const d = detail({ entry: entry({ matchedStubId: "orders", responseIndex: 1 }), stubs: [orders], nextIndex: 0 })
    expect(d.responseLine).toBe("sequential: answered #2 of 2, next is #1")
    expect(requestDetailPage(d, pageOpts).value).toContain("sequential: answered #2 of 2, next is #1")
  })

  it("gives the status its name", () => {
    expect(reasonPhrase(503)).toBe("Service Unavailable")
    expect(reasonPhrase(299)).toBe("")
    const page = requestDetailPage(detail({ entry: entry({ status: 503 }) }), pageOpts).value
    expect(page).toContain(`<span class="label c-error">503 Service Unavailable</span>`)
  })
})

describe("why it matched", () => {
  it("a row per predicate: ✓ or ✗, and what the request had where it adds something", () => {
    expect(
      verdictRow({
        field: "path",
        operator: "equals",
        caseSensitive: true,
        expected: "/orders",
        actual: "/orders",
        matched: true
      })
    )
      .toEqual({ ok: true, predicate: `path equals "/orders"`, ignoresCase: false })
    expect(
      verdictRow({
        field: "method",
        operator: "equals",
        caseSensitive: false,
        expected: "POST",
        actual: "GET",
        matched: false
      })
    )
      .toEqual({ ok: false, predicate: `method equals "POST"`, ignoresCase: true, actual: `"GET"` })
    expect(
      verdictRow({
        field: "headers",
        operator: "exists",
        caseSensitive: true,
        expected: { "x-id": "" },
        actual: {},
        matched: false
      }).actual
    )
      .toBe("no such header")
    expect(
      verdictRow({ field: "body", operator: "contains", caseSensitive: true, expected: "a", matched: false }).actual
    )
      .toBe("no body")
  })

  it("an invalid regex is an error on its row, and matching fails", () => {
    const broken = stub({ id: "broken", predicates: [{ field: "path", operator: "matches", value: "(" }] })
    const explained = explainEntry(entry(), [broken])
    expect(explained.error).toMatch(/Invalid regular expression/)
    expect(explained.others[0]?.rows[0]?.error).toMatch(/Invalid regular expression/)
    const page = requestDetailPage(detail({ entry: entry(), stubs: [broken] }), pageOpts).value
    expect(page).toContain("matching fails now")
    expect(page).toMatch(/<span class="verdict-error c-error">Invalid regular expression/)
    expect(page).toContain("so the imposter would answer 500")
  })

  it("the matching stub's rows, and the others collapsed", () => {
    const d = detail({ entry: entry({ matchedStubId: "orders" }), stubs: [payments, orders] })
    expect(d.explanation.match?.stub.position).toBe(2)
    expect(d.explanation.agrees).toBe(true)
    expect(d.differs).toBeUndefined()
    const page = requestDetailPage(d, pageOpts).value
    expect(page).toContain("why stub #2 matched")
    expect(page).toContain(`<details class="disclose why-others"><summary class="label">the other stub</summary>`)
    expect(page).toContain(`method equals &quot;POST&quot;</span> <span class="c-muted">· got &quot;GET&quot;</span>`)
  })

  it("with no match, every stub's rows are open", () => {
    const page =
      requestDetailPage(detail({ entry: entry({ path: "/nope" }), stubs: [orders, payments] }), pageOpts).value
    expect(page).toContain("why no stub matched")
    expect(page).toContain(
      `<details class="disclose why-others" open><summary class="label">2 stubs, none matched · 404 answers</summary>`
    )
    // "Stub it", to the stubs page's draft
    expect(page).toContain(`href="/_admin/stubs?draft=GET&amp;path=%2Fnope"`)
    expect(page).toContain(">stub it</a>")
  })

  it("a later stub that also matches says the first one wins", () => {
    const catchAll = stub({ id: "all" })
    const page =
      requestDetailPage(detail({ entry: entry({ matchedStubId: "orders" }), stubs: [orders, catchAll] }), pageOpts)
        .value
    expect(page).toContain("matches too, but #1 comes first")
  })

  it("flags it when today's stubs would answer differently", () => {
    // The stub that answered is gone, and another matches now
    const moved = detail({ entry: entry({ matchedStubId: "old" }), stubs: [orders] })
    expect(moved.explanation.agrees).toBe(false)
    expect(moved.differs).toBe(
      "Today's stubs would answer this differently: when it arrived, stub old answered it (since removed); now #1 GET /orders matches."
    )
    const page = requestDetailPage(moved, pageOpts).value
    expect(page).toContain("stub #1 would match now")
    expect(page).toContain(`<p class="why-flag" data-differs>⚠ Today&#39;s stubs would answer this differently`)

    // Unmatched then, stubbed since
    expect(detail({ entry: entry(), stubs: [orders] }).differs).toBe(
      "Today's stubs would answer this differently: when it arrived, no stub matched it; now #1 GET /orders matches."
    )
    // Matched then; its predicates were edited since, and nothing matches now
    const edited = stub({ id: "orders", predicates: methodPath("GET", "/v2/orders") })
    const unstubbed = detail({ entry: entry({ matchedStubId: "orders" }), stubs: [edited] })
    expect(unstubbed.differs).toContain("#1 GET /v2/orders answered it")
    expect(unstubbed.differs).toContain("now no stub matches")
    expect(requestDetailPage(unstubbed, pageOpts).value).toContain("no stub would match now")
  })

  it("an imposter with no stubs says what answers instead", () => {
    const page = requestDetailPage(detail({ entry: entry() }), pageOpts).value
    expect(page).toContain("no stubs to match")
    expect(page).toContain("this imposter has no stubs, so 404 answers every request")
  })
})

describe("bodies", () => {
  it("indents JSON, keeps text as it came, and says when one is not text or was cut", () => {
    const json = detail({ entry: entry({ responseBody: `{"a":[1]}` }) })
    expect(json.response.body).toEqual({ kind: "text", text: "{\n  \"a\": [\n    1\n  ]\n}", cut: false })
    expect(detail({ entry: entry({ body: { sku: "mug" } }) }).body).toEqual({
      kind: "text",
      text: "{\n  \"sku\": \"mug\"\n}",
      cut: false
    })
    expect(detail({ entry: entry({ body: "plain" }) }).body).toEqual({ kind: "text", text: "plain", cut: false })

    const binary = detail({ entry: entry({ method: "PUT", headers: { "content-length": "2048" } }) })
    expect(binary.body).toEqual({ kind: "binary", bytes: 2048 })
    expect(requestDetailPage(binary, pageOpts).value).toContain("a body of 2,048 bytes that is not text")

    const image = detail({ entry: entry({ responseHeaders: { "content-length": "512" } }) })
    expect(image.response.body).toEqual({ kind: "binary", bytes: 512 })

    // A HEAD answer or a 304 declares a length but never carries the body
    const head = detail({ entry: entry({ method: "HEAD", responseHeaders: { "content-length": "512" } }) })
    expect(head.response.body).toEqual({ kind: "none" })
    const notModified = detail({ entry: entry({ status: 304, responseHeaders: { "content-length": "512" } }) })
    expect(notModified.response.body).toEqual({ kind: "none" })
    // The server never reads a GET body, so one declared is not a lost binary body
    expect(detail({ entry: entry({ headers: { "content-length": "20" } }) }).body).toEqual({ kind: "none" })

    const cut = detail({
      entry: entry({ responseHeaders: { "content-length": "20000" }, responseBody: "x".repeat(10240) })
    })
    expect(cut.response.body).toMatchObject({ kind: "text", cut: true })
    expect(requestDetailPage(cut, pageOpts).value).toContain("the first 10 KiB")

    expect(requestDetailPage(detail({ entry: entry() }), pageOpts).value).toContain(
      `<span class="label">no body</span>`
    )
  })
})

describe("the request page", () => {
  it("shows the instant in UTC, the duration, the query decoded and the headers", () => {
    const d = detail({
      entry: entry({ query: { since: "2026-10-01T00:00:00Z" }, headers: { accept: "application/json" } })
    })
    expect(d.target).toBe("/orders?since=2026-10-01T00%3A00%3A00Z")
    const page = requestDetailPage(d, pageOpts).value
    expect(page).toContain(`<time datetime="2025-10-05T10:14:52.311Z">2025-10-05 10:14:52.311 UTC</time> · 3 ms`)
    expect(page).toContain(`/orders<span class="detail-query">?since=2026-10-01T00:00:00Z</span></h2>`)
    expect(page).toContain(`<span>query.since</span><span>2026-10-01T00:00:00Z</span>`)
    expect(page).toContain(`<span>accept</span><span>application/json</span>`)
  })

  it("carries the curl command for data-copy, the replay form and the stub link", () => {
    const d = detail({ entry: entry({ matchedStubId: "orders", headers: { "x-q": "it's" } }), stubs: [orders] })
    expect(d.curl).toBe(`curl http://127.0.0.1:3202/orders \\\n  -H 'x-q: it'\\''s'`)
    const page = requestDetailPage(d, pageOpts).value
    expect(page).toContain(`data-copy="curl http://127.0.0.1:3202/orders \\\n  -H &#39;x-q: it&#39;\\&#39;&#39;s&#39;"`)
    expect(page).toContain(`<pre class="code code-body" data-curl>curl http://127.0.0.1:3202/orders`)
    expect(page).toContain(
      `<form class="inline-form" method="post" action="/_admin/requests/req-1/replay" data-action>`
    )
    expect(page).toContain(">new stub from this</a>")
    // The page's own error slot, for a replay that fails with JS
    expect(page).toContain(`<div class="alert" data-error-slot></div>`)
  })

  it("escapes a hostile path, query, headers and bodies everywhere", () => {
    const hostile = entry({
      method: "POST",
      path: `/x${HOSTILE}`,
      query: { [HOSTILE]: HOSTILE },
      headers: { "x-evil": HOSTILE, "content-type": "text/plain" },
      body: HOSTILE,
      responseHeaders: { "x-out": HOSTILE },
      responseBody: HOSTILE
    })
    const page = requestDetailPage(detail({ entry: hostile }), pageOpts).value
    expect(page).not.toContain("<script>alert")
    expect(page).not.toContain(`"x")`)
    expect(page).toContain("&lt;/script&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;&quot;")

    const list = requestsPage(
      { config: config(), stubs: [], entries: [hostile], total: 1, filters: parseFilters(new URLSearchParams()) },
      { theme: null }
    ).value
    expect(list).not.toContain("<script>alert")
    expect(list).toContain("/x&lt;/script&gt;")
  })

  it("a request no longer in the log is a page that says so", () => {
    const page = requestNotFoundPage(`gone${HOSTILE}`, pageOpts, "replay").value
    expect(page).toContain("request not found")
    expect(page).toContain(", so there is nothing to replay.")
    expect(page).not.toContain("<script>alert")
    expect(noticePage("replay failed", HOSTILE, pageOpts).value).not.toContain("<script>alert")
  })
})

describe("the requests list", () => {
  const list = (entries: ReadonlyArray<RequestLogEntry>, query = "", total = entries.length) =>
    requestsPage(
      { config: config(), stubs: [orders], entries, total, filters: parseFilters(new URLSearchParams(query)) },
      { theme: "light" }
    ).value

  it("is the live view's rows, each linking to its page", () => {
    const page = list([entry({ matchedStubId: "orders", status: 503 })])
    expect(page).toContain(`<html lang="en" data-theme="light">`)
    expect(page).toContain(`<a class="req req-row" id="req-req-1" href="/_admin/requests/req-1">`)
    expect(page).toContain(`<span class="req-status num c-error">503</span>`)
    expect(page).toContain(`#1 /orders</span>`)
    expect(page).toContain(`<h2 class="title" id="log-title">1 request</h2>`)
    expect(page).toContain(`aria-current="page">requests</a>`)
  })

  it("shows the filters in use and how many entries they leave", () => {
    const page = list([entry()], "method=GET&path=%2Forders&status=200", 7)
    expect(page).toContain("1 of 7 requests")
    expect(page).toContain(`<option value="GET" selected>GET</option>`)
    expect(page).toContain(`value="/orders"`)
    expect(page).toContain(`>show all</a>`)
  })

  it("says why it is empty", () => {
    expect(list([], "", 0)).toContain("nothing logged yet: requests to :3202 appear here")
    expect(list([], "status=500", 4)).toContain("no logged request matches these filters")
  })

  it("has the clear and send forms, which work without JS", () => {
    const page = list([])
    expect(page).toContain(`action="/_admin/requests/clear" data-action data-confirm=`)
    expect(page).toContain(`<form class="send-form" method="post" action="/_admin/requests/test" data-action>`)
    expect(page).not.toMatch(/hx-|htmx/)
  })

  it("opens the send form again, as posted, after a refused send", () => {
    const page = requestsPage(
      { config: config(), stubs: [], entries: [], total: 0, filters: parseFilters(new URLSearchParams()) },
      {
        theme: null,
        send: {
          form: { method: "PUT", path: "/x", contentType: "text/plain", headers: HOSTILE, body: "b" },
          error: "Invalid test request: nope"
        }
      }
    ).value
    expect(page).toContain(`<details class="panel send" open>`)
    expect(page).toContain(`<option value="PUT" selected>PUT</option>`)
    expect(page).toContain(`<div class="alert" data-error-slot>Invalid test request: nope</div>`)
    expect(page).not.toContain("<script>alert")
  })
})

describe("outbound calls", () => {
  const cart: CallbackRecord = {
    name: "cart",
    phase: "before",
    method: "GET",
    url: "http://127.0.0.1:3302/carts/7",
    state: "answered",
    status: 200,
    durationMs: 5,
    responseBody: `{"items":[]}`
  }
  // Out of order on purpose: the panel lists before calls first whatever the log's order
  const records: ReadonlyArray<CallbackRecord> = [
    {
      name: "notify",
      phase: "after",
      method: "POST",
      url: "http://127.0.0.1:3304/events",
      state: "pending"
    },
    cart,
    {
      name: "price",
      phase: "before",
      method: "post",
      url: "http://127.0.0.1:3303/quote",
      state: "failed",
      error: "timed out after 2000 ms",
      durationMs: 2001,
      requestBody: "items=1"
    },
    {
      name: "audit",
      phase: "after",
      method: "PUT",
      url: "http://127.0.0.1:3305/audit",
      state: "answered",
      status: 503,
      durationMs: 1
    },
    {
      name: "hook",
      phase: "after",
      method: "POST",
      url: "http://127.0.0.1:3306/x",
      state: "skipped",
      error: "hop limit"
    }
  ]

  it("one row per record, before first: what it called, how it ended and how long it took", () => {
    const d = detail({ entry: entry({ callbacks: records }) })
    expect(d.calls.map((c) => [c.name, c.phase, c.method, c.mark, c.tone, c.result, c.durationMs])).toEqual([
      ["cart", "before", "GET", "✓", "ok", "200 OK", 5],
      ["price", "before", "POST", "✗", "error", "failed: timed out after 2000 ms", 2001],
      ["notify", "after", "POST", "…", "muted", "pending", undefined],
      ["audit", "after", "PUT", "✗", "error", "503 Service Unavailable", 1],
      ["hook", "after", "POST", "–", "muted", "skipped: hop limit", undefined]
    ])
    expect(d.calls[0]?.responseBody).toEqual({ text: "{\n  \"items\": []\n}", cut: false })
    expect(d.calls[1]?.requestBody).toEqual({ text: "items=1", cut: false })
    expect(detail({ entry: entry() }).calls).toEqual([])
  })

  it("a body the log cut at 2 KiB is kept as it is and says so; a short one ending in … was not cut", () => {
    const long = `${"x".repeat(2048)}…`
    expect(callBody(long)).toEqual({ text: long, cut: true })
    // The cut fell inside a 3-byte character, which was dropped: still 2 KiB with the "…"
    const split = `${"x".repeat(2045)}…`
    expect(callBody(split)).toEqual({ text: split, cut: true })
    expect(callBody("wait…")).toEqual({ text: "wait…", cut: false })
    expect(callBody(`{"a":1}`)).toEqual({ text: "{\n  \"a\": 1\n}", cut: false })
    expect(callBody(undefined)).toBeUndefined()
  })

  it("the panel sits between the response and why it matched, and says how to see pending calls settle", () => {
    const page = requestDetailPage(detail({ entry: entry({ callbacks: records }) }), pageOpts).value
    const panel = page.indexOf("data-outbound")
    expect(panel).toBeGreaterThan(page.indexOf(`aria-label="Response"`))
    expect(panel).toBeLessThan(page.indexOf(`aria-labelledby="why-title"`))
    expect(page).toContain(
      `<h2 class="title" id="calls-title">outbound calls</h2><span class="label">5 calls · 1 pending: reload to see it settle</span>`
    )
    expect(page).toContain(`<div class="why-stub" data-call="notify" data-state="pending">`)
    expect(page).toContain(`<span class="c-muted">pending</span>`)
    expect(page).toContain(
      `<span class="c-error">failed: timed out after 2000 ms</span><span class="label">2,001 ms</span>`
    )
    expect(page).toContain(
      `<details class="disclose"><summary class="label">response body</summary><pre class="code code-body">{`
    )
    expect(page).toContain(`<details class="disclose"><summary class="label">request body</summary>`)

    const cut = requestDetailPage(
      detail({ entry: entry({ callbacks: [{ ...cart, responseBody: `${"x".repeat(2048)}…` }] }) }),
      pageOpts
    ).value
    expect(cut).toContain(`<summary class="label">response body · cut at 2 KiB</summary>`)
    expect(cut).toContain("the first 2 KiB: the log keeps no more")
    expect(cut).toContain(`<span class="label">1 call</span>`)
  })

  it("no panel for a request whose response made no calls", () => {
    expect(requestDetailPage(detail({ entry: entry() }), pageOpts).value).not.toContain("outbound calls")
  })

  it("escapes a hostile name, url, error and bodies", () => {
    const hostile: CallbackRecord = {
      name: HOSTILE,
      phase: "before",
      method: HOSTILE,
      url: `http://x/${HOSTILE}`,
      state: "failed",
      error: HOSTILE,
      requestBody: HOSTILE,
      responseBody: HOSTILE
    }
    const page = requestDetailPage(detail({ entry: entry({ callbacks: [hostile] }) }), pageOpts).value
    expect(page).not.toContain("<script>alert")
    expect(page).not.toContain(`"x")`)
    expect(page).toContain(`data-call="&lt;/script&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;&quot;"`)
    expect(page).toContain(`failed: &lt;/script&gt;&lt;script&gt;alert(&quot;x&quot;)`)
  })
})
