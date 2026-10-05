// @vitest-environment happy-dom
import * as DateTime from "effect/DateTime"
import { ImposterConfig } from "imposters/domain/imposter"
import { NonEmptyString } from "imposters/schemas/common"
import type { RequestLogEntry } from "imposters/schemas/RequestLogSchema"
import { emptyTimeline, timelineAt } from "imposters/services/MetricsAggregates"
import { buildLiveData, type LiveData } from "imposters/ui/LiveData"
import { liveFragment, livePage, requestRow, requestRows } from "imposters/ui/pages/live"
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
let liveTotal = 0

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
const source = (): FakeEventSource => {
  const last = FakeEventSource.instances.at(-1)
  if (last === undefined) throw new Error("no EventSource")
  return last
}
const row = (id: string, path: string): string => requestRow(entry(id, path), ctx).value

beforeAll(async () => {
  vi.stubGlobal("EventSource", FakeEventSource)
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input)
    fetched.push(url)
    const body = url.endsWith("/_admin/fragments/requests")
      ? requestRows(reloadRows, ctx).value
      : liveFragment(data(liveTotal)).value
    return Promise.resolve(new Response(body))
  })
  const page = livePage(data(1), { theme: null, recent: [entry("r0", "/first")] }).value
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(page)?.[1] ?? ""
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

  it("after a reconnect, re-fetches the recent rows it may have missed", async () => {
    reloadRows = [entry("x2", "/missed-2"), entry("x1", "/missed-1")]
    source().dispatchEvent(new Event("error"))
    source().dispatchEvent(new Event("open"))
    await vi.waitFor(() => expect(paths()).toEqual(["/missed-2", "/missed-1"]))
    expect(fetched).toContain("/_admin/fragments/requests")
  })

  it("closes the stream when the page is hidden", () => {
    const current = source()
    window.dispatchEvent(new Event("pagehide"))
    expect(current.closed).toBe(true)
  })
})
