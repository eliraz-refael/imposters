import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { NonEmptyString } from "imposters/schemas/common"
import type { CallbackRecord, RequestLogEntry } from "imposters/schemas/RequestLogSchema"
import { type LoggedEntry, MAX_ENTRIES, RequestLogger, RequestLoggerLive } from "imposters/services/RequestLogger"
import { describe, expect } from "vitest"

// Settling `after` callbacks as a state machine: random sequences of logs (each with some
// pending records), settles (of any entry ever logged, present or not, and any name), clears,
// removals and overflows past the cap. After every step: a record never returns to pending, a
// settled record never changes, an entry keeps its `seq`, a settle of an entry that is gone
// changes nothing, a settle of a pending record replaces exactly it, and the log holds at most
// MAX_ENTRIES.

const Small = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 0, maximum }))

const Step = Schema.Union([
  Schema.TaggedStruct("Log", { pending: Small(3) }),
  Schema.TaggedStruct("Settle", {
    entry: Small(40),
    name: Small(1),
    state: Schema.Literals(["answered", "failed", "skipped", "pending"]),
    status: Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 599 }))
  }),
  Schema.TaggedStruct("Clear", {}),
  Schema.TaggedStruct("RemoveImposter", {}),
  Schema.TaggedStruct("Overflow", {})
])
type Step = Schema.Schema.Type<typeof Step>

const IMPOSTER = "imp-prop"
const nameOf = (i: number) => `cb${i}`

const pending = (i: number): CallbackRecord => ({
  name: nameOf(i),
  phase: "after",
  method: "POST",
  url: "http://h/e",
  state: "pending"
})

const entryOf = (id: string, pendingCount: number): RequestLogEntry => ({
  id: NonEmptyString.make(id),
  imposterId: NonEmptyString.make(IMPOSTER),
  timestamp: DateTime.makeUnsafe(0),
  request: { method: "GET", path: "/", headers: {}, query: {} },
  response: { status: 200, headers: {}, proxied: false, outcome: "stub" },
  duration: 1,
  ...(pendingCount > 0
    ? {
      callbacks: [
        { ...pending(0), phase: "before", state: "answered", name: "b" },
        ...Array.from({ length: pendingCount }, (_, i) => pending(i))
      ]
    }
    : {})
})

const settledRecord = (step: Extract<Step, { readonly _tag: "Settle" }>): CallbackRecord => ({
  ...pending(step.name),
  state: step.state,
  ...(step.state === "answered" ? { status: step.status, durationMs: 3 } : {}),
  ...(step.state === "failed" ? { error: "timed out after 100 ms", durationMs: 100 } : {}),
  ...(step.state === "skipped" ? { error: "hop limit 8 reached" } : {})
})

type Snapshot = ReadonlyMap<string, LoggedEntry>

const recordsOf = (item: LoggedEntry | undefined): ReadonlyArray<CallbackRecord> => item?.entry.callbacks ?? []

// The invariants between the log before a step and after it
const checkStep = (step: Step, before: Snapshot, after: Snapshot, settledId?: string) => {
  expect(after.size).toBeLessThanOrEqual(MAX_ENTRIES)
  for (const [id, now] of after) {
    const was = before.get(id)
    if (was === undefined) continue
    expect(now.seq).toBe(was.seq)
    const old = recordsOf(was)
    const cur = recordsOf(now)
    expect(cur.map((r) => r.name)).toEqual(old.map((r) => r.name))
    old.forEach((record, i) => {
      // Settled records are frozen, so none can go back to pending either
      if (record.state !== "pending") expect(cur[i]).toEqual(record)
    })
    // Only a settle changes an entry, and only the one it names
    if (step._tag !== "Settle" || id !== settledId) expect(cur).toEqual(old)
  }
  if (step._tag === "Settle" && settledId !== undefined) {
    const was = before.get(settledId)
    if (was === undefined) {
      // A settle of an entry that is gone is a no-op
      expect(after).toEqual(before)
      return
    }
    const target = recordsOf(was).find((r) => r.name === nameOf(step.name) && r.phase === "after")
    const now = recordsOf(after.get(settledId)).find((r) => r.name === nameOf(step.name) && r.phase === "after")
    if (target?.state === "pending" && step.state !== "pending") expect(now).toEqual(settledRecord(step))
    else expect(now).toEqual(target)
  }
}

const runSteps = (steps: ReadonlyArray<Step>) =>
  Effect.gen(function*() {
    const logger = yield* RequestLogger
    const ids: Array<string> = []
    let next = 0
    const snapshot = Effect.map(
      logger.getRecent(IMPOSTER, 10_000),
      (items): Snapshot => new Map(items.map((item) => [item.entry.id, item]))
    )
    const log = (pendingCount: number) => {
      const id = `e${next++}`
      ids.push(id)
      return logger.log(entryOf(id, pendingCount))
    }
    for (const step of steps) {
      const before = yield* snapshot
      let settledId: string | undefined
      switch (step._tag) {
        case "Log":
          yield* log(step.pending)
          break
        case "Settle":
          {
            // Mostly one of the latest entries (likely still logged, with records pending), else any
            const pool = step.entry < 30 ? ids.slice(-2) : ids
            settledId = pool.length === 0 ? "never-logged" : pool[step.entry % pool.length]
          }
          yield* logger.settleCallback(IMPOSTER, settledId ?? "never-logged", settledRecord(step))
          break
        case "Clear":
          yield* logger.clear(IMPOSTER)
          break
        case "RemoveImposter":
          yield* logger.removeImposter(IMPOSTER)
          break
        case "Overflow":
          for (let i = 0; i <= MAX_ENTRIES; i++) yield* log(i % 3 === 0 ? 1 : 0)
          break
      }
      checkStep(step, before, yield* snapshot, settledId)
    }
  }).pipe(
    // A fresh logger for every case
    Effect.provide(Layer.fresh(RequestLoggerLive))
  )

describe("RequestLogger.settleCallback (property)", () => {
  it.effect.prop(
    "settled records are frozen, seq is stable, a missing entry is a no-op, the log stays bounded",
    { steps: Schema.Array(Step) },
    ({ steps }) => runSteps(steps),
    { timeout: 60_000, arbitrary: { runs: 1000, size: 40 } }
  )
})

describe("RequestLogger.settleCallback (pinned counterexamples)", () => {
  // Shrunk from the property against a settle that overwrote an already-settled record
  it.effect("a second settle of the same record leaves the first one in place", () =>
    runSteps([
      { _tag: "Log", pending: 2 },
      { _tag: "Settle", entry: 0, name: 1, state: "failed", status: 200 },
      { _tag: "Settle", entry: 0, name: 1, state: "answered", status: 200 }
    ]))
})
