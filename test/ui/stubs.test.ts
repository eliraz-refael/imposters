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
  callHost,
  callsView,
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
      unmatched: [],
      outbound: []
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
  predicates: [
    { field: "path", operator: "equals", value: HOSTILE_PATH },
    { field: "headers", operator: "equals", value: { [HOSTILE_HEADER]: HOSTILE_BODY } }
  ],
  responses: [{
    status: 200,
    headers: { "x-evil": HOSTILE_HEADER, [HOSTILE_HEADER]: HOSTILE_PATH },
    body: HOSTILE_BODY
  }]
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
    const area = document.querySelector<HTMLTextAreaElement>("#stub-json")
    // happy-dom keeps the newline written after <textarea>, which a browser's parser drops
    expect(area?.value).toBe(`\n${text}`)
    const parsed = parseDraftText(area?.value ?? "")
    expect(parsed.ok && parsed.draft).toEqual(draftFromStub(hostile))
  })

  it("escape hostile values in the form's rows, which hold them as written", () => {
    const text = draftToText(draftFromStub(hostile))
    const page = stubsPage(data({ stubs: [hostile] }), {
      theme: null,
      editor: { editing: { id: hostile.id, position: 1 }, text, insert: "last" }
    }).value
    expect(page).not.toContain("<img")
    expect(page).not.toContain(`' onmouseover`)
    document.body.innerHTML = body(page)
    expect(document.querySelectorAll("script, img, [onmouseover], [onerror]")).toHaveLength(0)
    const value = (key: string): string | undefined => {
      const el = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-k]"))
        .find((control) => control.dataset.k === key)
      return el?.value
    }
    expect(value("c0.value")).toBe(HOSTILE_PATH)
    expect(value("c1.name")).toBe(HOSTILE_HEADER)
    expect(value("c1.value")).toBe(HOSTILE_BODY)
    expect(value("r0.h0.value")).toBe(HOSTILE_HEADER)
    expect(value("r0.h1.name")).toBe(HOSTILE_HEADER)
    expect(value("r0.h1.value")).toBe(HOSTILE_PATH)
    expect(value("r0.body")).toBe(HOSTILE_BODY)
    // A header name is in a schema path too, quoted
    const headerValue = document.querySelector<HTMLElement>("[data-k='r0.h1.value']")
    expect(headerValue?.dataset.path).toBe(`responses[0].headers[${JSON.stringify(HOSTILE_HEADER)}]`)
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

  it("says callbacks don't run in preview, only for a stub that has them", () => {
    const preview = { matched: 0, total: 0 }
    const withCallbacks = editorStatus({
      check: run(checkStubText(JSON.stringify({
        responses: [{ callbacks: { after: [{ name: "notify", method: "POST", url: "http://127.0.0.1:3004/e" }] } }]
      }))),
      preview
    }).value
    expect(withCallbacks).toContain("callbacks don't run in preview")
    const without = editorStatus({ check: run(checkStubText(`{ "responses": [{}] }`)), preview }).value
    expect(without).not.toContain("callbacks don't run in preview")
  })

  it("a problem names its place both ways: the JSON line (a link to it) and the form's control", () => {
    const text = draftToText({ responses: [{ status: "ok" }] })
    const status = editorStatus({ check: run(checkStubText(text)) }).value
    document.body.innerHTML = status
    const item = document.querySelector("li")
    expect(item?.getAttribute("data-problem-path")).toBe(`["responses",0,"status"]`)
    expect(item?.querySelector(".in-json")?.textContent).toBe(
      "line 3: responses[0].status must be an HTTP status code (100–599), like 200, not \"ok\""
    )
    expect(item?.querySelector(".in-json a")?.getAttribute("href")).toBe("#stub-json")
    expect(item?.querySelector(".in-json a")?.getAttribute("data-line")).toBe("3")
    expect(item?.querySelector(".in-form")?.textContent).toBe(
      "response 1 · status must be an HTTP status code (100–599), like 200, not \"ok\""
    )
    expect(item?.querySelector(".in-form a")?.getAttribute("data-goto")).toBe(`["responses",0,"status"]`)
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
    // The form and its tabs wait for editor.js, the stubs page's own script
    expect(page).toContain(`<div class="editor-tabs" data-editor-tabs hidden>`)
    expect(page).toContain(`<div class="stub-form" id="editor-form" data-form-view hidden>`)
    expect(page).toContain(`<fieldset class="seg" data-editor-mode>`)
    expect(page).toMatch(
      /<script defer src="\/_admin\/assets\/ui\.[0-9a-f]{10}\.js"><\/script>\s*<script defer src="\/_admin\/assets\/editor\.[0-9a-f]{10}\.js"><\/script>/
    )
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
    expect(edit).toContain(`edit stub<span id="stub-position-a b"> #2</span>`)
    expect(edit).not.toContain(`name="position"`)
    expect(edit).toContain(" data-focus")
  })

  it("the editor's form skips the browser's own validation: the hidden form view must not block a post", () => {
    // A status out of the number input's range: the hidden input is invalid, and only the
    // server's check may refuse the stub
    const text = JSON.stringify({ responses: [{ status: 999 }] })
    const editor = stubEditor({ text, insert: "last" }).value
    expect(editor).toContain(`max="599" step="1" data-c="status"`)
    expect(editor).toMatch(/<form method="post"[^>]* novalidate>/)
  })

  it("a delete's answer keeps the editor, and renumbers the heading of the stub it edits", () => {
    const second = stub({ id: "s2" })
    const answer = stubsAnswer(data({ stubs: [orders, second] })).value
    expect(answer).not.toContain(`id="stub-editor"`)
    expect(answer).toContain(`<span id="stub-position-s2" data-oob> #2</span>`)
    expect(answer).toContain(`id="tab-stubs-count" data-oob>2<`)
  })

  it("a delete of the stub being edited drops the number from its heading", () => {
    const answer = stubsAnswer(data({ stubs: [orders] }), undefined, "gone").value
    expect(answer).toContain(`<span id="stub-position-gone" data-oob></span>`)
  })

  it("an action's answer: the list, then the editor and the tab count out of band", () => {
    const answer = stubsAnswer(data({ stubs: [orders] }), newEditor).value
    expect(answer).toMatch(/id="stub-editor"[^>]* data-oob>/)
    expect(answer).toContain(`id="tab-stubs-count" data-oob>1<`)
    expect(answer.indexOf("Stub 1")).toBeLessThan(answer.indexOf("stub-editor"))
  })
})

describe("callbacks on the cards", () => {
  const checkout = stub({
    id: "checkout",
    responses: [
      {
        status: 201,
        callbacks: {
          parallel: true,
          before: [
            { name: "cart", url: "http://127.0.0.1:3302/carts/{{request.query.cart}}" },
            { name: "price", method: "POST", url: "https://User:pw@Pricing.Example.com:8443/quote", onError: "fail" }
          ],
          after: [{ name: "notify", method: "POST", url: "http://{{request.query.hook}}/events" }]
        }
      },
      { status: 200 }
    ]
  })

  it("a response's calls: a summary line, then each call's method and host, before first", () => {
    const [card] = data({ stubs: [checkout] }).cards
    expect(card?.responses[0]?.calls).toEqual({
      summary: "before (parallel) → cart, price · after → notify",
      calls: [
        { name: "cart", method: "GET", host: "127.0.0.1:3302", failsAnswer: false },
        { name: "price", method: "POST", host: "pricing.example.com:8443", failsAnswer: true },
        { name: "notify", method: "POST", host: "{{request.query.hook}}", failsAnswer: false }
      ]
    })
    // A response without callbacks has no calls at all, so it renders as before
    expect(card?.responses[1]).not.toHaveProperty("calls")
  })

  it("names only the phases a response uses, and parallel only with before calls", () => {
    const decode = (callbacks: Record<string, unknown>) =>
      callsView(stub({ responses: [{ callbacks }] }).responses[0]?.callbacks)
    expect(decode({ after: [{ name: "hook", url: "http://h/x" }], parallel: true })?.summary).toBe("after → hook")
    expect(decode({ before: [{ name: "a", url: "http://h/x" }] })?.summary).toBe("before → a")
    expect(decode({})).toBeUndefined()
    expect(callsView(undefined)).toBeUndefined()
  })

  it("the host is what comes after the scheme, without credentials, path, query or fragment", () => {
    expect(callHost("http://127.0.0.1:3302/carts/7")).toBe("127.0.0.1:3302")
    expect(callHost("HTTPS://API.example.com?x=1")).toBe("api.example.com")
    expect(callHost("http://a:b@host#frag")).toBe("host")
    expect(callHost("http://${$lowercase(request.query.h)}/x")).toBe("${$lowercase(request.query.h)}")
    expect(callHost("http://${request.query.a ? 'x' : 'y'}/p")).toBe("${request.query.a ? 'x' : 'y'}")
    expect(callHost("http://{{request.query.a/b}}:80/p")).toBe("{{request.query.a/b}}:80")
  })

  it("the card shows the summary and each call, marks onError fail, and leaves other responses alone", () => {
    const page = stubsPage(data({ stubs: [checkout] }), { theme: null, editor: newEditor }).value
    document.body.innerHTML = body(page)
    const answers = document.querySelectorAll(".answer")
    const calls = answers[0]?.querySelector("[data-calls]")
    expect(calls?.children[0]?.textContent).toBe("before (parallel) → cart, price · after → notify")
    expect(Array.from(calls?.children ?? []).slice(1).map((line) => line.textContent)).toEqual([
      "cart GET 127.0.0.1:3302",
      "price POST pricing.example.com:8443 onError fail",
      "notify POST {{request.query.hook}}"
    ])
    expect(calls?.querySelector(".c-caution")?.textContent).toBe("onError fail")
    expect(answers[1]?.querySelector("[data-calls]")).toBeNull()
  })

  it("a stub without callbacks renders exactly as it did", () => {
    const page = stubsPage(data({ stubs: [orders] }), { theme: null, editor: newEditor }).value
    expect(page).not.toContain("data-calls")
    expect(page).not.toContain("answer-calls")
  })

  it("escapes a hostile host", () => {
    // No "/" in it, so all of it is the host
    const host = "<img src=x onerror=alert(4)>"
    const evil = stub({ id: "evil", responses: [{ callbacks: { after: [{ name: "x", url: `http://${host}?q` }] } }] })
    const page = stubsPage(data({ stubs: [evil] }), { theme: null, editor: newEditor }).value
    expect(page).not.toContain("<img src=x")
    expect(page).toContain("&lt;img src=x onerror=alert(4)&gt;")
    document.body.innerHTML = body(page)
    expect(document.querySelectorAll("script, img, [onerror]")).toHaveLength(0)
    expect(document.querySelector("[data-calls]")?.textContent).toContain(`x GET ${host}`)
  })
})
