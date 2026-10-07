// @vitest-environment happy-dom
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { ImposterConfig } from "imposters/domain/imposter"
import { NonEmptyString } from "imposters/schemas/common"
import type { RequestLogEntry } from "imposters/schemas/RequestLogSchema"
import { Stub } from "imposters/schemas/StubSchema"
import { emptyTimeline, timelineAt } from "imposters/services/MetricsAggregates"
import { buildLiveData, type LiveData } from "imposters/ui/LiveData"
import { liveFragment, livePage, requestRow } from "imposters/ui/pages/live"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// The live page's markup driven by the browser runtime (ui-assets/ui.ts) in happy-dom: the
// contract between src/ui/pages/live.ts and the data attributes ui.ts reads.

class FakeEventSource extends EventTarget {
  static readonly instances: Array<FakeEventSource> = []
  closed = false
  constructor(readonly url: string) {
    super()
    FakeEventSource.instances.push(this)
  }
  close(): void {
    this.closed = true
  }
  emit(data: string): void {
    this.dispatchEvent(new MessageEvent("request", { data }))
  }
}

const NOW = 1_759_659_292_311
const ctx = { stubs: [], protocol: "HTTP" }

const entry = (id: string, path: string): RequestLogEntry => ({
  id: NonEmptyString.make(id),
  imposterId: NonEmptyString.make("imp"),
  timestamp: DateTime.makeUnsafe(NOW),
  request: { method: "GET", path, headers: {}, query: {} },
  response: { status: 404, headers: {}, proxied: false, outcome: "unmatched" },
  duration: 1
})

const data = (totalRequests: number): LiveData =>
  buildLiveData({
    config: ImposterConfig({
      id: "imp",
      name: "orders-api",
      port: 3202,
      protocol: "HTTP",
      status: "running",
      createdAt: DateTime.makeUnsafe(0)
    }),
    stubs: [],
    snapshot: {
      totalRequests,
      requestsPerMinute: 0,
      averageResponseTime: 0,
      errorRate: 0,
      serverErrorRate: 0,
      requestsByMethod: {},
      requestsByStatusCode: {},
      timeline: timelineAt(emptyTimeline, NOW),
      last15Minutes: { requests: 0, serverErrors: 0, unmatched: 0 },
      stubs: new Map(),
      unmatched: []
    },
    unmatched: [],
    nextIndex: new Map(),
    nowMs: NOW
  })

const fetched: Array<string> = []
let reloadRows: ReadonlyArray<RequestLogEntry> = []
// Set to hold the next rows re-fetch until the test answers it
let holdReload = false
let releaseReload: (() => void) | undefined
// Set to fail the next rows re-fetch with a 500
let failReload = false
let liveTotal = 0
// The rows the live fragment resends the stub cells of, and the stubs it numbers them by
let liveRecent: ReadonlyArray<RequestLogEntry> = []
let liveStubs: ReadonlyArray<Stub> = []

const rowsEl = (): HTMLElement => {
  const el = document.getElementById("live-rows")
  if (el === null) throw new Error("no #live-rows")
  return el
}
const paths = (): Array<string> => Array.from(rowsEl().querySelectorAll(".req-path"), (cell) => cell.textContent ?? "")
const pauseButton = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>("[data-sse-pause]")
  if (el === null) throw new Error("no pause button")
  return el
}
// The latest stream opened for `url`: the page's list, or the plain list beside it
const source = (url = "/_admin/events"): FakeEventSource => {
  const last = FakeEventSource.instances.filter((instance) => instance.url === url).at(-1)
  if (last === undefined) throw new Error(`no EventSource for ${url}`)
  return last
}

// Answers the re-fetch held in flight
const release = (): void => {
  const answer = releaseReload
  if (answer === undefined) throw new Error("no re-fetch in flight")
  releaseReload = undefined
  answer()
}
const reloads = (): number => fetched.filter((url) => url.endsWith("/_admin/fragments/requests")).length
const reconnect = (): void => {
  source().dispatchEvent(new Event("error"))
  source().dispatchEvent(new Event("open"))
}
// Lets pending promise callbacks (a re-fetch landing, the next one starting) run
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const row = (id: string, path: string): string => requestRow(entry(id, path), ctx).value

beforeAll(async () => {
  vi.stubGlobal("EventSource", FakeEventSource)
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input)
    fetched.push(url)
    if (url.endsWith("/_admin/fragments/requests")) {
      // The rows as the server had them when it was asked
      // Without sequence numbers, so rows land as they arrive (the property test covers ordering)
      const body = reloadRows.map((e) => requestRow(e, ctx).value).join("")
      if (failReload) {
        failReload = false
        return Promise.resolve(new Response("down", { status: 500 }))
      }
      if (!holdReload) return Promise.resolve(new Response(body))
      holdReload = false
      return new Promise<Response>((resolve) => {
        releaseReload = () => resolve(new Response(body))
      })
    }
    return Promise.resolve(new Response(liveFragment({ ...data(liveTotal), stubs: liveStubs }, liveRecent).value))
  })
  const page = livePage(data(1), { theme: null, recent: [{ entry: entry("r0", "/first"), seq: 1 }] }).value
  // Beside the page: a list with no data-sse-reload, so nothing to re-fetch from
  const plain = `<section class="panel"><button id="plain-pause" data-sse-pause="#plain-rows"></button>` +
    `<div id="plain-rows" data-sse="/plain" data-sse-event="request" data-sse-max="2"></div></section>`
  document.body.innerHTML = (/<body>([\s\S]*)<\/body>/.exec(page)?.[1] ?? "") + plain
  await import("../../ui-assets/ui")
})

beforeEach(() => {
  if (pauseButton().getAttribute("aria-pressed") === "true") pauseButton().click()
})

describe("ui.ts on the live page", () => {
  it("opens the page's event stream for request events", () => {
    expect(source().url).toBe("/_admin/events")
    expect(source().closed).toBe(false)
  })

  it("on its first open, re-fetches the rows logged since the page was rendered", async () => {
    reloadRows = [entry("gap", "/between-render-and-open"), entry("r0", "/first")]
    source().dispatchEvent(new Event("open"))
    await vi.waitFor(() => expect(paths()).toEqual(["/between-render-and-open", "/first"]))
    expect(fetched).toContain("/_admin/fragments/requests")
  })

  it("an event that arrives while the rows are re-fetched is neither lost nor shown twice", async () => {
    // The server snapshots its rows with d1 logged and d2 not yet
    reloadRows = [entry("d1", "/during"), entry("gap", "/between-render-and-open"), entry("r0", "/first")]
    holdReload = true
    source().dispatchEvent(new Event("error"))
    source().dispatchEvent(new Event("open"))
    await vi.waitFor(() => expect(releaseReload).toBeDefined())
    source().emit(row("d1", "/during"))
    source().emit(row("d2", "/after-the-snapshot"))
    releaseReload?.()
    releaseReload = undefined
    await vi.waitFor(() =>
      expect(paths()).toEqual(["/after-the-snapshot", "/during", "/between-render-and-open", "/first"])
    )
  })

  it("puts a new request at the top, highlighted", () => {
    source().emit(row("r1", "/arrived"))
    expect(paths()[0]).toBe("/arrived")
    expect(rowsEl().firstElementChild?.classList.contains("fresh")).toBe(true)
    expect(rowsEl().firstElementChild?.getAttribute("href")).toBe("/_admin/requests/r1")
  })

  it("pause buffers arrivals and counts them; resume puts them at the top in order", () => {
    const before = paths()
    pauseButton().click()
    expect(pauseButton().getAttribute("aria-pressed")).toBe("true")
    expect(rowsEl().closest(".panel")?.classList.contains("is-paused")).toBe(true)

    source().emit(row("p1", "/while-paused-1"))
    source().emit(row("p2", "/while-paused-2"))
    expect(paths()).toEqual(before)
    expect(pauseButton().querySelector("[data-sse-count]")?.textContent).toBe("2")

    pauseButton().click()
    expect(pauseButton().getAttribute("aria-pressed")).toBe("false")
    expect(paths().slice(0, 3)).toEqual(["/while-paused-2", "/while-paused-1", before[0]])
  })

  it("keeps the latest 20 rows", () => {
    for (let i = 0; i < 25; i++) source().emit(row(`m${i}`, `/many-${i}`))
    expect(rowsEl().children.length).toBe(20)
    expect(paths()[0]).toBe("/many-24")
  })

  it("an arrival refreshes the numbers (throttled), replacing the stats out of band", async () => {
    liveTotal = 4321
    source().emit(row("n1", "/numbers"))
    await vi.waitFor(() => expect(document.getElementById("live-stats")?.textContent).toContain("4,321"), {
      timeout: 3000
    })
    expect(fetched).toContain("/_admin/fragments/live")
    // The request list itself is never polled away
    expect(paths()[0]).toBe("/numbers")
  })

  it("a poll renumbers a listed row's stub, so it reads as the stub's current position", async () => {
    const orders = Schema.decodeUnknownSync(Stub)({
      id: "orders",
      predicates: [{ field: "path", operator: "equals", value: "/orders" }],
      responses: [{ status: 200 }]
    })
    const matched: RequestLogEntry = {
      ...entry("s1", "/orders"),
      response: {
        status: 200,
        headers: {},
        proxied: false,
        outcome: "stub",
        matchedStubId: NonEmptyString.make("orders")
      }
    }
    source().emit(requestRow(matched, { stubs: [orders], protocol: "HTTP" }).value)
    const cell = (): string => document.getElementById("answered-s1")?.textContent ?? ""
    expect(cell()).toBe("#1 /orders")
    // A stub is inserted above it; the next arrival's poll brings the new numbering
    liveStubs = [Schema.decodeUnknownSync(Stub)({ id: "first", predicates: [], responses: [{ status: 200 }] }), orders]
    liveRecent = [matched]
    source().emit(row("s2", "/next"))
    await vi.waitFor(() => expect(cell()).toBe("#2 /orders"), { timeout: 3000 })
    liveStubs = []
    liveRecent = []
  })

  it("a poll leaves an unchanged out-of-band cell in place, keeping a selection inside it; a changed one is swapped", async () => {
    const orders = Schema.decodeUnknownSync(Stub)({
      id: "orders",
      predicates: [{ field: "path", operator: "equals", value: "/orders" }],
      responses: [{ status: 200 }]
    })
    const matched: RequestLogEntry = {
      ...entry("k1", "/orders"),
      response: {
        status: 200,
        headers: {},
        proxied: false,
        outcome: "stub",
        matchedStubId: NonEmptyString.make("orders")
      }
    }
    source().emit(requestRow(matched, { stubs: [orders], protocol: "HTTP" }).value)
    const cell = (): HTMLElement | null => document.getElementById("answered-k1")
    const before = cell()
    if (before === null) throw new Error("no cell")
    const range = document.createRange()
    range.selectNodeContents(before)
    const selection = window.getSelection()
    if (selection === null) throw new Error("no selection")
    selection.removeAllRanges()
    selection.addRange(range)

    // The poll resends the same cell: it stays the same node, and the selection survives
    liveStubs = [orders]
    liveRecent = [matched]
    liveTotal = 7001
    source().emit(row("k2", "/next"))
    await vi.waitFor(() => expect(document.getElementById("live-stats")?.textContent).toContain("7,001"), {
      timeout: 3000
    })
    expect(cell()).toBe(before)
    expect(selection.rangeCount).toBe(1)
    expect(selection.toString()).toBe("#1 /orders")

    // A stub inserted above it: the cell is swapped for the renumbered one
    liveStubs = [Schema.decodeUnknownSync(Stub)({ id: "first", predicates: [], responses: [{ status: 200 }] }), orders]
    liveTotal = 7002
    source().emit(row("k3", "/later"))
    await vi.waitFor(() => expect(cell()?.textContent).toBe("#2 /orders"), { timeout: 3000 })
    expect(cell()).not.toBe(before)
    selection.removeAllRanges()
    liveStubs = []
    liveRecent = []
  })

  it("after a reconnect, re-fetches the recent rows it may have missed", async () => {
    reloadRows = [entry("x2", "/missed-2"), entry("x1", "/missed-1")]
    source().dispatchEvent(new Event("error"))
    source().dispatchEvent(new Event("open"))
    await vi.waitFor(() => expect(paths()).toEqual(["/missed-2", "/missed-1"]))
    expect(fetched).toContain("/_admin/fragments/requests")
  })

  it("a reconnect while paused re-fetches the rows on resume", async () => {
    pauseButton().click()
    const before = reloads()
    reloadRows = [entry("y1", "/missed-while-paused")]
    source().dispatchEvent(new Event("error"))
    source().dispatchEvent(new Event("open"))
    expect(reloads()).toBe(before)
    pauseButton().click()
    await vi.waitFor(() => expect(paths()).toEqual(["/missed-while-paused"]))
    expect(reloads()).toBe(before + 1)
  })

  it("a re-fetch asked for while one is in flight runs after it, so the list ends on the newer answer", async () => {
    reloadRows = [entry("o1", "/older")]
    holdReload = true
    reconnect()
    await vi.waitFor(() => expect(releaseReload).toBeDefined())
    // The stream drops and comes back while the first re-fetch is still out; more was logged meanwhile
    reloadRows = [entry("n1", "/logged-while-down"), entry("o1", "/older")]
    reconnect()
    release()
    await vi.waitFor(() => expect(paths()).toEqual(["/logged-while-down", "/older"]))
  })

  it("rows buffered while paused, resumed during a re-fetch, survive it landing", async () => {
    reloadRows = [entry("s1", "/snapshot")]
    holdReload = true
    reconnect()
    await vi.waitFor(() => expect(releaseReload).toBeDefined())
    pauseButton().click()
    source().emit(row("b1", "/buffered"))
    pauseButton().click()
    release()
    await vi.waitFor(() => expect(paths()).toEqual(["/buffered", "/snapshot"]))
  })

  it("a pause while a re-fetch is in flight freezes the list: the answer and the rows meanwhile wait for resume", async () => {
    reloadRows = [entry("t1", "/snapshot-2")]
    holdReload = true
    reconnect()
    await vi.waitFor(() => expect(releaseReload).toBeDefined())
    source().emit(row("h1", "/held-then-paused"))
    pauseButton().click()
    const frozen = paths()
    const before = reloads()
    release()
    await flush()
    // Paused: the answer is not applied, and the arrival is counted, not shown
    expect(paths()).toEqual(frozen)
    expect(pauseButton().querySelector("[data-sse-count]")?.textContent).toBe("1")
    // Resume re-fetches; the server has logged h1 by now
    reloadRows = [entry("h1", "/held-then-paused"), entry("t1", "/snapshot-2")]
    pauseButton().click()
    await vi.waitFor(() => expect(paths()).toEqual(["/held-then-paused", "/snapshot-2"]))
    expect(reloads()).toBe(before + 1)
  })

  it("with nothing to re-fetch from, resuming after the buffer overflowed shows the latest rows", () => {
    const plainPause = document.getElementById("plain-pause")
    const plainRows = document.getElementById("plain-rows")
    if (plainPause === null || plainRows === null) throw new Error("no plain list")
    plainPause.click()
    for (const id of ["p1", "p2", "p3"]) source("/plain").emit(`<p id="${id}">${id}</p>`)
    plainPause.click()
    expect(Array.from(plainRows.children, (child) => child.id)).toEqual(["p3", "p2"])
  })

  it("a stream that drops during a re-fetch is re-fetched when it opens again, not before", async () => {
    reloadRows = [entry("u1", "/before-the-drop")]
    holdReload = true
    reconnect()
    await vi.waitFor(() => expect(releaseReload).toBeDefined())
    source().dispatchEvent(new Event("error"))
    const before = reloads()
    release()
    await vi.waitFor(() => expect(paths()).toEqual(["/before-the-drop"]))
    await flush()
    // Still down: a re-fetch now would miss what is logged before the stream is back
    expect(reloads()).toBe(before)
    reloadRows = [entry("u2", "/logged-while-down"), entry("u1", "/before-the-drop")]
    source().dispatchEvent(new Event("open"))
    await vi.waitFor(() => expect(paths()).toEqual(["/logged-while-down", "/before-the-drop"]))
  })

  it("resuming while the stream is down waits for it to open before re-fetching", async () => {
    pauseButton().click()
    source().dispatchEvent(new Event("error"))
    reloadRows = [entry("v1", "/before-resume")]
    const before = reloads()
    pauseButton().click()
    await flush()
    expect(reloads()).toBe(before)
    reloadRows = [entry("v2", "/logged-before-open"), entry("v1", "/before-resume")]
    source().dispatchEvent(new Event("open"))
    await vi.waitFor(() => expect(paths()).toEqual(["/logged-before-open", "/before-resume"]))
  })

  it("a failed re-fetch leaves the list stale, so the next resume re-fetches", async () => {
    reloadRows = [entry("w1", "/after-the-failure")]
    failReload = true
    const before = reloads()
    reconnect()
    await vi.waitFor(() => expect(reloads()).toBe(before + 1))
    await flush()
    pauseButton().click()
    pauseButton().click()
    await vi.waitFor(() => expect(paths()).toEqual(["/after-the-failure"]))
  })

  it("a failed re-fetch while the stream stays open is retried on its own", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      reloadRows = [entry("x1", "/after-the-retry")]
      failReload = true
      const before = reloads()
      reconnect()
      await vi.waitFor(() => expect(reloads()).toBe(before + 1))
      // No pause, no reconnect: only a retry can fill the gap
      await vi.advanceTimersByTimeAsync(60_000)
      expect(paths()).toEqual(["/after-the-retry"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("a list paused during a re-fetch is not re-fetched again until resume", async () => {
    reloadRows = [entry("y1", "/in-flight")]
    holdReload = true
    reconnect()
    await vi.waitFor(() => expect(releaseReload).toBeDefined())
    pauseButton().click()
    // Goes stale again while paused and mid re-fetch
    reconnect()
    const frozen = paths()
    const before = reloads()
    release()
    await flush()
    // Paused: the list stays as it is, and nothing is re-fetched
    expect(paths()).toEqual(frozen)
    expect(reloads()).toBe(before)
    reloadRows = [entry("y2", "/logged-while-paused"), entry("y1", "/in-flight")]
    pauseButton().click()
    await vi.waitFor(() => expect(paths()).toEqual(["/logged-while-paused", "/in-flight"]))
  })

  it("closes the stream when the page is hidden", () => {
    const current = source()
    window.dispatchEvent(new Event("pagehide"))
    expect(current.closed).toBe(true)
  })
})
