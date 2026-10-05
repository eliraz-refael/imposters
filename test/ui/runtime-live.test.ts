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
// Set to hold the next rows re-fetch until the test answers it
let holdReload = false
let releaseReload: (() => void) | undefined
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
const row = (id: string, path: string): string => requestRow(entry(id, path), ctx).value

beforeAll(async () => {
  vi.stubGlobal("EventSource", FakeEventSource)
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input)
    fetched.push(url)
    if (url.endsWith("/_admin/fragments/requests")) {
      // The rows as the server had them when it was asked
      const body = requestRows(reloadRows, ctx).value
      if (!holdReload) return Promise.resolve(new Response(body))
      holdReload = false
      return new Promise<Response>((resolve) => {
        releaseReload = () => resolve(new Response(body))
      })
    }
    return Promise.resolve(new Response(liveFragment(data(liveTotal)).value))
  })
  const page = livePage(data(1), { theme: null, recent: [entry("r0", "/first")] }).value
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

  it("a pause while a re-fetch is in flight keeps the rows that arrived meanwhile until resume", async () => {
    reloadRows = [entry("t1", "/snapshot-2")]
    holdReload = true
    reconnect()
    await vi.waitFor(() => expect(releaseReload).toBeDefined())
    source().emit(row("h1", "/held-then-paused"))
    pauseButton().click()
    const before = reloads()
    release()
    await vi.waitFor(() => expect(paths()).toEqual(["/snapshot-2"]))
    // Paused: counted, not shown
    expect(pauseButton().querySelector("[data-sse-count]")?.textContent).toBe("1")
    pauseButton().click()
    expect(paths()).toEqual(["/held-then-paused", "/snapshot-2"])
    expect(reloads()).toBe(before)
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

  it("closes the stream when the page is hidden", () => {
    const current = source()
    window.dispatchEvent(new Event("pagehide"))
    expect(current.closed).toBe(true)
  })
})
