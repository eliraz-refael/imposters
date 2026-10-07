import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { ImposterConfig } from "imposters/domain/imposter"
import { NonEmptyString } from "imposters/schemas/common"
import type { RequestLogEntry } from "imposters/schemas/RequestLogSchema"
import { emptyTimeline, timelineAt } from "imposters/services/MetricsAggregates"
import { buildLiveData } from "imposters/ui/LiveData"
import { liveFragment, livePage, RECENT_ROWS, requestRow, requestRows } from "imposters/ui/pages/live"
import { afterAll, beforeAll, vi } from "vitest"

/**
 * A harness for the live page's request list: the real ui-assets/ui.ts on the real live-page
 * markup (in the calling test's happy-dom), against a fake server log, a fake EventSource and
 * re-fetches that stay in flight until a step answers them. `runCase` plays a sequence of steps,
 * checks the invariants after every one, and at the end requires the list to converge on the
 * server's newest rows once the stream is up, nothing is paused and every re-fetch is answered.
 * test/ui/runtime-live.prop.test.ts generates the cases; runtime-live.examples.test.ts pins the
 * ones it found.
 */

// ---------------------------------------------------------------- the steps

export const Step = Schema.Union([
  // The stream opens (its first line arrives), or reopens after a drop
  Schema.TaggedStruct("Open", {}),
  // The connection drops; the browser will reconnect (CONNECTING)
  Schema.TaggedStruct("Drop", {}),
  // The browser gives up on the stream (CLOSED), as on an HTTP error answer
  Schema.TaggedStruct("GiveUp", {}),
  // The browser's reconnect attempt fails too; it keeps trying (still CONNECTING)
  Schema.TaggedStruct("Retrying", {}),
  // The server logs requests: each is sent on an open stream, and arrives at once
  Schema.TaggedStruct("Log", { count: Schema.Literals([1, 2, 25]) }),
  // The server logs requests whose events are still in flight on an open stream: they arrive,
  // in log order, at a later Deliver, or never if the stream drops first
  Schema.TaggedStruct("LogInFlight", { count: Schema.Literals([1, 2, 25]) }),
  Schema.TaggedStruct("Deliver", { all: Schema.Boolean }),
  Schema.TaggedStruct("Pause", {}),
  Schema.TaggedStruct("Resume", {}),
  // The oldest re-fetch in flight is answered: the newest rows as of when it was sent (the server
  // read its log at once) or as of now (the server read it just before answering), or an error
  Schema.TaggedStruct("AnswerOk", { late: Schema.Boolean }),
  Schema.TaggedStruct("AnswerFail", {}),
  Schema.TaggedStruct("Advance", { ms: Schema.Literals([100, 1000, 5000, 30000]) }),
  Schema.TaggedStruct("PageHide", {}),
  Schema.TaggedStruct("PageShow", { persisted: Schema.Boolean })
])
export type Step = typeof Step.Type

export const Case = Schema.Struct({
  // Requests logged before the page was rendered
  initial: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 25 })),
  steps: Schema.Array(Step).check(Schema.isMaxLength(60))
})
export type Case = typeof Case.Type

// ---------------------------------------------------------------- episodes

// Uniform random steps rarely line up into the states that break a live list, so most of a
// generated scenario is episodes: short scripts aimed at them, with their details generated.
// `Random` keeps everything else reachable.
const Many = Schema.Literals([20, 25, 45])
export const Episode = Schema.Union([
  Schema.TaggedStruct("Random", { steps: Schema.Array(Step).check(Schema.isMaxLength(8)) }),
  // A row in flight from before a re-fetch is sent arrives after its answer, with `newer` rows
  // logged in between (so it may not be in the answer at all)
  Schema.TaggedStruct("LateEvent", { newer: Many, late: Schema.Boolean, deliverFirst: Schema.Boolean }),
  // A burst while a re-fetch is in flight, perhaps paused, perhaps with the stream dropping
  Schema.TaggedStruct("BurstDuringRefetch", {
    burst: Many,
    inFlight: Schema.Boolean,
    late: Schema.Boolean,
    drop: Schema.Boolean,
    pause: Schema.Boolean
  }),
  // Pause and resume around a re-fetch's answer, with rows arriving on both sides of it
  Schema.TaggedStruct("PauseAroundAnswer", {
    count: Schema.Literals([1, 2, 25]),
    late: Schema.Boolean,
    deliverFirst: Schema.Boolean,
    resumeFirst: Schema.Boolean
  }),
  // The stream drops (or is given up on) while a re-fetch is out, and more is logged meanwhile
  Schema.TaggedStruct("DropMidRefetch", { giveUp: Schema.Boolean, late: Schema.Boolean, fail: Schema.Boolean })
])
export type Episode = typeof Episode.Type

export const Scenario = Schema.Struct({
  initial: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 25 })),
  episodes: Schema.Array(Episode).check(Schema.isMaxLength(10))
})
export type Scenario = typeof Scenario.Type

const logMany = (n: 20 | 25 | 45, inFlight: boolean): ReadonlyArray<Step> => {
  const tag = inFlight ? "LogInFlight" : "Log"
  if (n === 20) return Array.from({ length: 10 }, (): Step => ({ _tag: tag, count: 2 }))
  if (n === 25) return [{ _tag: tag, count: 25 }]
  return [{ _tag: tag, count: 25 }, ...Array.from({ length: 10 }, (): Step => ({ _tag: tag, count: 2 }))]
}

const deliverAll: Step = { _tag: "Deliver", all: true }

const when = (condition: boolean, ...steps: ReadonlyArray<Step>): ReadonlyArray<Step> => condition ? steps : []

// The steps an episode plays
export const expand = (episode: Episode): ReadonlyArray<Step> => {
  switch (episode._tag) {
    case "Random":
      return episode.steps
    case "LateEvent":
      // The open's re-fetch fails; its retry is sent with one row still in flight
      return [
        { _tag: "Open" },
        { _tag: "AnswerFail" },
        { _tag: "LogInFlight", count: 1 },
        { _tag: "Advance", ms: 1000 },
        ...logMany(episode.newer, true),
        ...when(episode.deliverFirst, deliverAll),
        { _tag: "AnswerOk", late: episode.late },
        deliverAll
      ]
    case "BurstDuringRefetch":
      return [
        { _tag: "Drop" },
        { _tag: "Open" },
        ...when(episode.pause, { _tag: "Pause" }),
        ...logMany(episode.burst, episode.inFlight),
        episode.drop ? { _tag: "Drop" } : { _tag: "Deliver", all: false },
        { _tag: "AnswerOk", late: episode.late },
        { _tag: "Open" },
        ...when(episode.pause, { _tag: "Resume" }),
        deliverAll
      ]
    case "PauseAroundAnswer":
      return [
        { _tag: "Drop" },
        { _tag: "Open" },
        { _tag: "LogInFlight", count: episode.count },
        { _tag: "Pause" },
        ...when(episode.deliverFirst, deliverAll),
        ...when(episode.resumeFirst, { _tag: "Resume" }),
        { _tag: "AnswerOk", late: episode.late },
        { _tag: "LogInFlight", count: episode.count },
        deliverAll,
        { _tag: "Resume" }
      ]
    case "DropMidRefetch":
      return [
        { _tag: "Drop" },
        { _tag: "Open" },
        { _tag: "LogInFlight", count: 1 },
        deliverAll,
        { _tag: episode.giveUp ? "GiveUp" : "Drop" },
        { _tag: "Log", count: 25 },
        { _tag: "AnswerOk", late: episode.late },
        ...when(episode.fail, { _tag: "AnswerFail" }),
        { _tag: "Advance", ms: 1000 },
        { _tag: "Open" }
      ]
  }
}

export const toCase = (scenario: Scenario): Case => ({
  initial: scenario.initial,
  steps: scenario.episodes.flatMap(expand)
})

// ---------------------------------------------------------------- the fakes

const NOW = 1_759_659_292_311
const ctx = { stubs: [], protocol: "HTTP" }
const CONNECTING = 0
const OPEN = 1
const CLOSED = 2

class FakeEventSource extends EventTarget {
  readyState = CONNECTING
  // Events sent and not yet arrived, oldest first; lost when the connection drops
  readonly inFlight: Array<number> = []
  // Closed by the page (close()), not by the browser giving up
  closedByPage = false
  constructor(readonly url: string) {
    super()
    world.sources.push(this)
  }
  close(): void {
    this.closedByPage = true
    this.readyState = CLOSED
  }
}

const entry = (id: number): RequestLogEntry => ({
  id: NonEmptyString.make(`r${String(id)}`),
  imposterId: NonEmptyString.make("imp"),
  timestamp: DateTime.makeUnsafe(NOW),
  request: { method: "GET", path: `/p${String(id)}`, headers: {}, query: {} },
  response: { status: 404, headers: {}, proxied: false, outcome: "unmatched" },
  duration: 1
})

const liveData = buildLiveData({
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
    totalRequests: 0,
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

interface InFlight {
  // The newest rows when the re-fetch was sent: the most it can know
  readonly rows: ReadonlyArray<number>
  readonly answer: (response: Response) => void
}

interface World {
  // Every logged request id, oldest first
  readonly log: Array<number>
  readonly sources: Array<FakeEventSource>
  readonly inFlight: Array<InFlight>
  hidden: boolean
  // Rows the page has received and is holding back (paused or mid re-fetch): its badge's count
  waiting: number
}

const freshWorld = (log: Array<number>): World => ({ log, sources: [], inFlight: [], hidden: false, waiting: 0 })

let world: World = freshWorld([])

const newest = (log: ReadonlyArray<number>): ReadonlyArray<number> => log.slice(-RECENT_ROWS).reverse()
// In the fake log an id is its own sequence number
const logged = (id: number) => ({ entry: entry(id), seq: id })
const rowsHtml = (ids: ReadonlyArray<number>): string => requestRows(ids.map(logged), ctx).value

const fakeFetch = (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input)
  if (url.endsWith("/page")) {
    const page = livePage(liveData, { theme: null, recent: newest(world.log).map(logged) }).value
    return Promise.resolve(new Response(/<body>([\s\S]*)<\/body>/.exec(page)?.[1] ?? ""))
  }
  if (url.endsWith("/_admin/fragments/requests")) {
    const rows = newest(world.log)
    return new Promise((resolve) => world.inFlight.push({ rows, answer: resolve }))
  }
  return Promise.resolve(new Response(liveFragment(liveData, []).value))
}

// ---------------------------------------------------------------- driving the page

// Lets every promise, timer of zero delay and body read settle
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(0)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

const element = (selector: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(selector)
  if (el === null) throw new Error(`no ${selector}`)
  return el
}

const listed = (): Array<number> =>
  Array.from(element("#live-rows").children, (row) => Number(row.id.replace(/^req-r/, "")))

const isPaused = (): boolean => element("[data-sse-pause]").getAttribute("aria-pressed") === "true"

// The stream the page holds: the latest one it opened and has not closed
const stream = (): FakeEventSource | undefined => {
  const last = world.sources.at(-1)
  return last === undefined || last.closedByPage ? undefined : last
}

const persistedPageshow = (persisted: boolean): Event => {
  const event = new Event("pageshow")
  Object.defineProperty(event, "persisted", { value: persisted })
  return event
}

const badge = (): string => element("[data-sse-pause] [data-sse-count]").textContent ?? ""

// An event arrives: shown at once, or held back (counted) while paused or mid re-fetch. A row
// the list already shows (a re-fetch answer carried it) is not new, so the badge does not count it.
const arrive = (source: FakeEventSource, id: number): void => {
  const held = isPaused() || world.inFlight.length > 0
  if (held && !listed().includes(id)) world.waiting = Math.min(world.waiting + 1, RECENT_ROWS)
  source.dispatchEvent(new MessageEvent("request", { data: requestRow(entry(id), ctx, id).value }))
}

const lose = (source: FakeEventSource): void => {
  source.inFlight.length = 0
}

const answerOldest = (ok: boolean, late: boolean): void => {
  const next = world.inFlight.shift()
  if (next === undefined) return
  const rows = late ? newest(world.log) : next.rows
  next.answer(ok ? new Response(rowsHtml(rows)) : new Response("unavailable", { status: 503 }))
}

const apply = async (step: Step): Promise<void> => {
  const source = stream()
  switch (step._tag) {
    case "Open":
      if (source !== undefined && source.readyState === CONNECTING) {
        source.readyState = OPEN
        source.dispatchEvent(new Event("open"))
      }
      break
    case "Drop":
      if (source !== undefined && source.readyState === OPEN) {
        lose(source)
        source.readyState = CONNECTING
        source.dispatchEvent(new Event("error"))
      }
      break
    case "Retrying":
      if (source !== undefined && source.readyState === CONNECTING) source.dispatchEvent(new Event("error"))
      break
    case "GiveUp":
      if (source !== undefined && source.readyState !== CLOSED) {
        lose(source)
        source.readyState = CLOSED
        source.dispatchEvent(new Event("error"))
      }
      break
    case "Log":
    case "LogInFlight":
      for (let i = 0; i < step.count; i++) {
        const id = world.log.length + 1
        world.log.push(id)
        const open = stream()
        if (open === undefined || open.readyState !== OPEN) continue
        // In flight behind earlier events, or arrives at once (and so only with nothing ahead of it)
        if (step._tag === "LogInFlight" || open.inFlight.length > 0) open.inFlight.push(id)
        else arrive(open, id)
      }
      break
    case "Deliver":
      if (source !== undefined && source.readyState === OPEN) {
        for (const id of source.inFlight.splice(0, step.all ? source.inFlight.length : 1)) arrive(source, id)
      }
      break
    case "Pause":
      if (!isPaused()) element("[data-sse-pause]").click()
      break
    case "Resume":
      if (isPaused()) element("[data-sse-pause]").click()
      break
    case "AnswerOk":
      answerOldest(true, step.late)
      break
    case "AnswerFail":
      answerOldest(false, false)
      break
    case "Advance":
      await vi.advanceTimersByTimeAsync(step.ms)
      break
    case "PageHide":
      if (!world.hidden) {
        world.hidden = true
        if (source !== undefined) lose(source)
        window.dispatchEvent(new Event("pagehide"))
      }
      break
    case "PageShow":
      // A persisted pageshow restores a hidden page; a plain one is a load, which this page already had
      if (step.persisted === world.hidden) {
        world.hidden = false
        window.dispatchEvent(persistedPageshow(step.persisted))
      }
      break
  }
  await flush()
  // Shown as soon as the page is neither paused nor re-fetching
  if (!isPaused() && world.inFlight.length === 0) world.waiting = 0
}

const fail = (message: string, at: number, steps: ReadonlyArray<Step>): never => {
  throw new Error(`${message} after step ${String(at)} of ${JSON.stringify(steps.slice(0, at + 1))}`)
}

// The invariants that hold after every step
const check = (before: ReadonlyArray<number>, wasPaused: boolean, at: number, steps: ReadonlyArray<Step>) => {
  const ids = listed()
  if (new Set(ids).size !== ids.length) fail(`a row is listed twice: ${JSON.stringify(ids)}`, at, steps)
  if (ids.length > RECENT_ROWS) fail(`${String(ids.length)} rows listed`, at, steps)
  if (wasPaused && isPaused() && JSON.stringify(ids) !== JSON.stringify(before)) {
    fail(`the list changed while paused: ${JSON.stringify(before)} → ${JSON.stringify(ids)}`, at, steps)
  }
  for (const id of ids) if (!world.log.includes(id)) fail(`r${String(id)} was never logged`, at, steps)
  if (isPaused() && badge() !== String(world.waiting)) {
    fail(`the paused badge says ${badge()}, ${String(world.waiting)} rows are waiting`, at, steps)
  }
  // Ids are logged in increasing order, so newest first is strictly decreasing
  for (let i = 1; i < ids.length; i++) {
    if ((ids[i] ?? 0) >= (ids[i - 1] ?? 0)) fail(`rows out of order: ${JSON.stringify(ids)}`, at, steps)
  }
}

// Stream up, nothing paused or hidden, every re-fetch answered, retries given time
const quiesce = async (): Promise<void> => {
  for (let round = 0; round < 8; round++) {
    if (world.hidden) await apply({ _tag: "PageShow", persisted: true })
    if (isPaused()) await apply({ _tag: "Resume" })
    await apply({ _tag: "Open" })
    await apply({ _tag: "Deliver", all: true })
    while (world.inFlight.length > 0) await apply({ _tag: "AnswerOk", late: false })
    await apply({ _tag: "Advance", ms: 30000 })
  }
}

export const runCase = async ({ initial, steps }: Case): Promise<void> => {
  world = freshWorld(Array.from({ length: initial }, (_, i) => i + 1))
  vi.clearAllTimers()
  // A fresh list: swapped in by a data-action, which starts its stream and closes the last case's
  document.body.innerHTML = `<div id="host"></div><button id="load" data-action="GET /page" data-target="#host">`
  element("#load").click()
  await flush()
  if (world.sources.length !== 1) throw new Error("the page did not open its stream")

  for (const [at, step] of steps.entries()) {
    const before = listed()
    const wasPaused = isPaused()
    await apply(step)
    check(before, wasPaused, at, steps)
  }
  await quiesce()
  check(listed(), false, steps.length, steps)
  const expected = newest(world.log)
  const ids = listed()
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    fail(
      `did not converge: listed ${JSON.stringify(ids)}, the server's newest ${JSON.stringify(expected)}`,
      steps.length,
      steps
    )
  }
}

// Registers the fakes and loads ui.ts once for the calling test file; each case swaps in a fresh list
export const useLiveListHarness = (): void => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal("fetch", fakeFetch)
    await import("../../ui-assets/ui")
  })
  afterAll(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
}
