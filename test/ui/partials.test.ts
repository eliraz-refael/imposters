import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { ImposterConfig } from "imposters/domain/imposter"
import { NonEmptyString } from "imposters/schemas/common"
import type { RequestLogEntry } from "imposters/schemas/RequestLogSchema"
import { Stub } from "imposters/schemas/StubSchema"
import { requestDetailPage } from "imposters/ui/pages/request-detail"
import { formatTimeUtc, requestTablePartial, stubCardPartial } from "imposters/ui/partials"
import { describe, expect, it } from "vitest"

// 2026-10-02T09:05:07.123Z
const instant = DateTime.makeUnsafe(Date.UTC(2026, 9, 2, 9, 5, 7, 123))

const entry = (overrides?: { readonly matchedStubId?: string; readonly proxied?: boolean }): RequestLogEntry => ({
  id: NonEmptyString.make("entry-1"),
  imposterId: NonEmptyString.make("imp-1"),
  timestamp: instant,
  request: { method: "GET", path: "/x", headers: { "x-in": "<in>" }, query: {} },
  response: {
    status: 200,
    headers: { "x-out": "\"out\"" },
    body: "<b>body</b>",
    proxied: overrides?.proxied ?? false,
    outcome: overrides?.proxied === true ? "proxy" : overrides?.matchedStubId !== undefined ? "stub" : "unmatched",
    ...(overrides?.matchedStubId !== undefined ? { matchedStubId: NonEmptyString.make(overrides.matchedStubId) } : {})
  },
  duration: 3
})

const config = (protocol: string) =>
  ImposterConfig({ id: "imp-1", name: "svc", port: 9999, protocol, status: "running", createdAt: instant })

const stub = Schema.decodeUnknownSync(Stub)({
  id: "stub-1",
  predicates: [{ field: "path", operator: "equals", value: "/x\"<script>" }],
  responses: [{ status: 200, body: "line one\nline <two> \"quoted\"" }, { status: 201, body: { a: 1 } }]
})

describe("request times", () => {
  it("formats a timestamp as HH:MM:SS in UTC, labelled", () => {
    expect(formatTimeUtc(instant)).toBe("09:05:07 UTC")
  })

  it("the request table shows the time (not NaN:NaN:NaN) with the full instant as its title", () => {
    const rows = requestTablePartial([entry()]).value
    expect(rows).not.toContain("NaN")
    expect(rows).toContain(">09:05:07 UTC<")
    expect(rows).toContain("title=\"2026-10-02T09:05:07.123Z\"")
  })

  it("the request detail page shows the ISO instant, not a DateTime's toString", () => {
    const page = requestDetailPage({ config: config("HTTP"), entry: entry(), matchedStub: null }).value
    expect(page).toContain("Timestamp: 2026-10-02T09:05:07.123Z")
    expect(page).not.toContain("DateTime.Utc(")
  })
})

describe("stub card", () => {
  it("shows a string body as sent, not as a JSON string literal, and escapes it", () => {
    const card = stubCardPartial(stub).value
    expect(card).toContain("line one\nline &lt;two&gt; &quot;quoted&quot;")
    expect(card).not.toContain("line one\\n")
    expect(card).toContain("&quot;a&quot;: 1")
    expect(card).not.toContain("<script>")
  })

  it("shows a fixed delay and a delay range, never an object's toString", () => {
    const delayed = Schema.decodeUnknownSync(Stub)({
      id: "stub-2",
      predicates: [],
      responses: [{ status: 200, delay: 250 }, { status: 200, delay: { min: 100, max: 500 } }]
    })
    const card = stubCardPartial(delayed).value
    expect(card).toContain("delay 250ms")
    expect(card).toContain("delay 100–500ms")
    expect(card).not.toContain("[object Object]")
  })

  it("has no actions: stubs are changed on the stubs page", () => {
    expect(stubCardPartial(stub).value).not.toContain("hx-delete")
  })
})

describe("request detail page", () => {
  it("shows the matched stub without a Delete button", () => {
    const page =
      requestDetailPage({ config: config("HTTP"), entry: entry({ matchedStubId: "stub-1" }), matchedStub: stub })
        .value
    expect(page).toContain("Matched Stub")
    expect(page).not.toContain("hx-delete")
  })

  it("says what answered an unmatched request", () => {
    const http = requestDetailPage({ config: config("HTTP"), entry: entry(), matchedStub: null }).value
    expect(http).toContain(">No matching stub<")
    const s3 = requestDetailPage({ config: config("S3"), entry: entry(), matchedStub: null }).value
    expect(s3).toContain("No matching stub (answered by S3)")
    const proxied = requestDetailPage({ config: config("HTTP"), entry: entry({ proxied: true }), matchedStub: null })
      .value
    expect(proxied).toContain("No matching stub (proxied)")
  })

  it("escapes headers and bodies", () => {
    const page = requestDetailPage({ config: config("HTTP"), entry: entry(), matchedStub: null }).value
    expect(page).toContain("&lt;in&gt;")
    expect(page).toContain("&quot;out&quot;")
    expect(page).toContain("&lt;b&gt;body&lt;/b&gt;")
    expect(page).not.toContain("<b>body</b>")
  })
})
