// @vitest-environment happy-dom
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ImposterConfig } from "imposters/domain/imposter"
import { Stub } from "imposters/schemas/StubSchema"
import { emptyTimeline, timelineAt } from "imposters/services/MetricsAggregates"
import type { StubCounters } from "imposters/services/MetricsAggregates"
import { checkStubText, problemLines, type StubCheck } from "imposters/ui/editor/checkStub"
import { draftToText, parseDraftText } from "imposters/ui/editor/draftText"
import { buildLiveData } from "imposters/ui/LiveData"
import { type EditorState, editorStatus, stubEditor, stubsAnswer, stubsPage } from "imposters/ui/pages/stubs"
import { draftFromStub } from "imposters/ui/stubDraft"
import {
  bodyPreview,
  buildStubsData,
  delayLabel,
  hitsLine,
  sentBodyPreview,
  type StubsData
} from "imposters/ui/StubsData"
import { describe, expect, it } from "vitest"

// The stubs page: its view-model (cards, next marker, delays, hits, the fallback), the server's
// check of the editor's text, and the templates, with hostile values escaped everywhere

const NOW = 1_759_659_292_311
const HOSTILE_PATH = "/</textarea><script>alert(1)</script>"
const HOSTILE_HEADER = "a\"b' onmouseover=alert(2)"
const HOSTILE_BODY = "</script><img src=x onerror=alert(3)>"

const stub = (input: Record<string, unknown>): Stub =>
  Schema.decodeUnknownSync(Stub)({ id: "s1", predicates: [], responses: [{ status: 200 }], ...input })

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

const data = (input: {
  readonly stubs: ReadonlyArray<Stub>
  readonly counters?: ReadonlyArray<[string, StubCounters]>
  readonly nextIndex?: ReadonlyArray<[string, number]>
  readonly config?: ImposterConfig
}): StubsData =>
  buildStubsData(buildLiveData({
    config: input.config ?? config(),
    stubs: input.stubs,
    snapshot: {
      totalRequests: 0,
      requestsPerMinute: 0,
      averageResponseTime: 0,
      errorRate: 0,
      serverErrorRate: 0,
      requestsByMethod: {},
      requestsByStatusCode: {},
      timeline: timelineAt(emptyTimeline, NOW),
      last15Minutes: { requests: 0, serverErrors: 0, unmatched: 0 },
      stubs: new Map(input.counters ?? []),
      unmatched: []
    },
    unmatched: [],
    nextIndex: new Map(input.nextIndex ?? []),
    nowMs: NOW
  }))

const orders = stub({
  id: "035e9a87-long-id",
  predicates: [
    { field: "method", operator: "equals", value: "GET" },
    { field: "path", operator: "equals", value: "/Orders", caseSensitive: false }
  ],
  responses: [
    { status: 200, body: { orders: [] } },
    { status: 503, body: { error: "service_unavailable" }, delay: { min: 100, max: 500 } }
  ]
})

const newEditor: EditorState = { text: "{}", insert: "last" }

const run = <A>(effect: Effect.Effect<A>): A => Effect.runSync(effect)

describe("the view-model", () => {
  it("a card per stub, in order, with chips, per-response hits and the next marker", () => {
    const [card] = data({
      stubs: [orders],
      counters: [[orders.id, { hits: 1624, byResponse: [812, 812], lastHitAt: NOW - 3000 }]],
      nextIndex: [[orders.id, 1]]
    }).cards
    expect(card).toMatchObject({
      position: 1,
      shortId: "035e9a87",
      label: "GET /Orders",
      mode: "sequential",
      hitsLine: "1,624 hits · last 3s ago"
    })
    expect(card?.predicates).toEqual([
      { field: "method", operator: "equals", value: "\"GET\"", ignoresCase: false },
      { field: "path", operator: "equals", value: "\"/Orders\"", ignoresCase: true }
    ])
    expect(card?.responses).toEqual([
      { status: 200, tone: "ok", hits: 812, next: false, delay: undefined, body: "{ \"orders\": [] }" },
      {
        status: 503,
        tone: "error",
        hits: 812,
        next: true,
        delay: "after 100–500 ms",
        body: "{ \"error\": \"service_unavailable\" }"
      }
    ])
  })

  it("no next marker in random mode or with one response, and no per-response hits with one response", () => {
    const random = stub({ id: "r", responseMode: "random", responses: [{ status: 200 }, { status: 500 }] })
    const single = stub({ id: "one", responses: [{ status: 404, delay: 2000 }] })
    const cards = data({ stubs: [random, single], nextIndex: [["one", 0]] }).cards
    expect(cards[0]?.responses.map((r) => r.next)).toEqual([false, false])
    expect(cards[1]?.responses).toEqual([
      { status: 404, tone: "caution", hits: undefined, next: false, delay: "after 2,000 ms", body: undefined }
    ])
    expect(cards[1]?.hitsLine).toBe("no hits yet")
  })

  it("delays, hits lines and body previews", () => {
    expect(delayLabel(2000)).toBe("after 2,000 ms")
    expect(delayLabel({ min: 100, max: 500 })).toBe("after 100–500 ms")
    expect(hitsLine(1, NOW, NOW)).toBe("1 hit · last just now")
    expect(bodyPreview("line one\n  line two")).toBe("line one line two")
    expect(bodyPreview({ a: [1, { b: null }] })).toBe("{ \"a\": [1, { \"b\": null }] }")
    expect(bodyPreview("x".repeat(500))?.length).toBe(160)
    expect(sentBodyPreview("{\"id\":\"pm_81\"}")).toBe("{ \"id\": \"pm_81\" }")
    expect(sentBodyPreview("plain text")).toBe("plain text")
    expect(sentBodyPreview("")).toBeUndefined()
  })

  it("what answers when no stub matches: a 404, the extension, or the proxy", () => {
    expect(data({ stubs: [] }).fallback).toEqual({ kind: "notFound", unmatched: 0 })
    expect(data({ stubs: [], config: config({ protocol: "S3" }) }).fallback).toEqual({
      kind: "extension",
      protocol: "S3"
    })
    const proxied = config({
      proxy: {
        targetUrl: "https://api.example.com",
        mode: "record",
        removeHeaders: [],
        followRedirects: true,
        timeout: 1000
      }
    })
    expect(data({ stubs: [], config: proxied }).fallback).toEqual({
      kind: "proxy",
      mode: "record",
      targetUrl: "https://api.example.com"
    })
  })
})

describe("checkStubText", () => {
  it("a valid stub, with the schema's defaults", () => {
    const check = run(checkStubText(`{ "responses": [{ "body": "ok" }] }`))
    expect(check._tag).toBe("Valid")
    if (check._tag === "Valid") {
      expect(check.stub).toEqual({
        predicates: [],
        responses: [{ status: 200, body: "ok" }],
        responseMode: "sequential"
      })
    }
  })

  it("a syntax error, with its line and column", () => {
    const check = run(checkStubText("{\n  \"responses\": [}\n"))
    expect(problemLines(check)).toEqual([
      "line 2, column 17: unexpected \"}\": expected a value: a string in double quotes, a number, true, false, null, an object or a list"
    ])
  })

  it("every schema problem, in plain English, at the line it is about", () => {
    const text = draftToText({
      predicates: [{ field: "url", operator: "equals", value: "/" }],
      responses: [{ status: "ok" }]
    })
    expect(problemLines(run(checkStubText(text)))).toEqual([
      "line 3: predicates[0].field must be one of method, path, headers, query or body, not \"url\"",
      "line 6: responses[0].status must be an HTTP status code (100–599), like 200, not \"ok\""
    ])
  })
})

describe("draftFromStub", () => {
  it("prints a stub back as it was likely written: caseSensitive only where it is off", () => {
    expect(draftFromStub(orders).predicates).toEqual([
      { field: "method", operator: "equals", value: "GET" },
      { field: "path", operator: "equals", value: "/Orders", caseSensitive: false }
    ])
    // And the editor reads it back as the same stub
    const check = run(checkStubText(draftToText(draftFromStub(orders))))
    expect(check._tag === "Valid" && check.stub).toEqual({
      predicates: orders.predicates,
      responses: orders.responses,
      responseMode: orders.responseMode
    })
  })
})

const hostile = stub({
  id: "h1",
  predicates: [{ field: "path", operator: "equals", value: HOSTILE_PATH }],
  responses: [{ status: 200, headers: { "x-evil": HOSTILE_HEADER }, body: HOSTILE_BODY }]
})

const body = (page: string): string => /<body>([\s\S]*)<\/body>/.exec(page)?.[1] ?? ""

describe("the templates", () => {
  // The HTML spec drops one newline straight after <textarea>, so the template writes one there:
  // a posted text that starts with a blank line comes back whole, and every line number holds
  it("gives back the exact text in the textarea, a leading blank line included", () => {
    const text = "\n{\n  \"responses\": [{ \"status\": \"ok\" }]\n}"
    const html = stubEditor({ text, insert: "last" }).value
    const raw = /<textarea id="stub-json"[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1] ?? ""
    expect(raw.startsWith("\n")).toBe(true)
    // What a browser's parser makes of it: one leading newline dropped, then the entities read
    const parsed = raw.replace(/^\n/, "").replaceAll("&quot;", "\"").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
      .replaceAll("&#39;", "'").replaceAll("&amp;", "&")
    expect(parsed).toBe(text)
  })

  it("escape hostile stub values in the cards", () => {
    const page = stubsPage(data({ stubs: [hostile] }), { theme: null, editor: newEditor }).value
    expect(page).not.toContain("<script>alert(1)")
    expect(page).not.toContain("<img src=x")
    expect(page).toContain("&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;")
    document.body.innerHTML = body(page)
    expect(document.querySelectorAll("script")).toHaveLength(0)
    expect(document.querySelector(".tok-value")?.textContent).toBe(JSON.stringify(HOSTILE_PATH))
    expect(document.querySelector(".answer .code")?.textContent).toBe(HOSTILE_BODY)
  })

  it("escape hostile values in the prefilled JSON, which reads back as the same stub", () => {
    const text = draftToText(draftFromStub(hostile))
    const page = stubsPage(data({ stubs: [hostile] }), {
      theme: null,
      editor: { editing: { id: hostile.id, position: 1 }, text, insert: "last" }
    }).value
    expect(page).not.toContain(`</textarea><script>`)
    document.body.innerHTML = body(page)
    expect(document.querySelectorAll("script")).toHaveLength(0)
    const area = document.querySelector("textarea")
    // happy-dom keeps the newline written after <textarea>, which a browser's parser drops
    expect(area?.value).toBe(`\n${text}`)
    const parsed = parseDraftText(area?.value ?? "")
    expect(parsed.ok && parsed.draft).toEqual(draftFromStub(hostile))
  })

  it("escape hostile values the status and the problems quote", () => {
    const check: StubCheck = run(checkStubText(JSON.stringify({ responses: [{ status: HOSTILE_BODY }] })))
    const status = editorStatus({ check }).value
    expect(status).not.toContain("<img")
    const preview = editorStatus({
      check: run(checkStubText(`{ "responses": [{}] }`)),
      preview: {
        matched: 1,
        total: 2,
        sample: {
          request: { method: "GET", path: HOSTILE_PATH },
          response: { status: 200, headers: {}, body: HOSTILE_BODY }
        },
        error: HOSTILE_BODY
      }
    }).value
    expect(preview).not.toContain("<script>")
    expect(preview).not.toContain("<img")
    expect(preview).toContain("would answer 1 of the 2 unmatched requests")
  })

  it("the page: the header's tab count, the cards' actions, and the editor's data hooks", () => {
    const page = stubsPage(data({ stubs: [orders] }), { theme: "light", editor: newEditor }).value
    expect(page).toContain(`<html lang="en" data-theme="light">`)
    expect(page).toMatch(
      /<a class="tab" href="\/_admin\/stubs" aria-current="page">stubs<span class="tab-count" id="tab-stubs-count">1</
    )
    expect(page).toContain(`action="/_admin/stubs/035e9a87-long-id/delete" data-action data-target="#stub-list"`)
    expect(page).toContain(`data-confirm="Delete stub #1 (GET /Orders)?"`)
    expect(page).toContain(`href="/_admin/stubs?edit=035e9a87-long-id#stub-editor"`)
    expect(page).toContain(`data-stub-editor data-preview-url="/_admin/stubs/preview"`)
    expect(page).toContain(`<fieldset class="seg" data-editor-mode hidden>`)
    expect(page).toContain(`<span class="tok-op">any case</span>`)
    expect(page).not.toContain("cdn.tailwindcss.com")
  })

  it("the editor: add (with insert first/last, the stub-it heading) or edit (with its own action)", () => {
    const add = stubEditor({ text: "{}", insert: "first", from: { method: "GET", path: "/payments/pm_81" } }).value
    expect(add).toContain(`<form method="post" action="/_admin/stubs"`)
    expect(add).toContain("from GET /payments/pm_81")
    expect(add).toContain(`<input type="radio" name="position" value="first" checked>`)
    expect(add).toContain(">add stub</button>")
    const edit = stubEditor({ editing: { id: "a b", position: 2 }, text: "{}", insert: "last", focus: true }).value
    expect(edit).toContain(`action="/_admin/stubs/a%20b"`)
    expect(edit).toContain("edit stub #2")
    expect(edit).not.toContain(`name="position"`)
    expect(edit).toContain(" data-focus")
  })

  it("an action's answer: the list, then the editor and the tab count out of band", () => {
    const answer = stubsAnswer(data({ stubs: [orders] }), newEditor).value
    expect(answer).toMatch(/id="stub-editor"[^>]* data-oob>/)
    expect(answer).toContain(`id="tab-stubs-count" data-oob>1<`)
    expect(answer.indexOf("Stub 1")).toBeLessThan(answer.indexOf("stub-editor"))
  })
})
