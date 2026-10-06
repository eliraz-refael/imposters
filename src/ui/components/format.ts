import * as DateTime from "effect/DateTime"

/**
 * How the UIs print numbers and times. Pure: anything relative takes `now` as an argument, so a
 * page reads the clock once (through the admin API) and every row agrees.
 */

// A dash for a value that does not apply: a stopped imposter, a rate with no requests
export const NONE = "—"

const grouped = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")

/** A whole number with thousands separators: 1095 → "1,095" */
export const count = (n: number): string => (n < 0 ? "-" : "") + grouped(String(Math.round(Math.abs(n))))

/** A small quantity keeps one decimal, a large one is grouped: 0.27 → "0.3", 73 → "73", 1250 → "1,250" */
export const decimal = (n: number): string => (Math.abs(n) < 10 && !Number.isInteger(n) ? n.toFixed(1) : count(n))

/** A share as a percentage with one decimal: (171, 1000) → "17.1%"; nothing to divide by → "—" */
export const percent = (part: number, total: number): string =>
  total > 0 ? `${((part / total) * 100).toFixed(1)}%` : NONE

/** A duration in milliseconds, without its unit: 2004 → "2,004", 0.75 → "0.8", 0 → "<1" (timings are whole ms) */
export const millis = (ms: number): string => (ms < 0.5 ? "<1" : decimal(ms))

/** A duration in milliseconds, with its unit: 2004 → "2,004 ms" */
export const ms = (value: number): string => `${millis(value)} ms`

/** "1 stub", "2 stubs" */
export const plural = (n: number, one: string, many: string = `${one}s`): string =>
  `${count(n)} ${n === 1 ? one : many}`

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** How long before `nowMs` the instant `thenMs` was, coarsely: "just now", "42s ago", "3m ago", "5h ago", "2d ago" */
export const ago = (thenMs: number, nowMs: number): string => {
  const elapsed = Math.max(0, nowMs - thenMs)
  if (elapsed < SECOND) return "just now"
  if (elapsed < MINUTE) return `${String(Math.floor(elapsed / SECOND))}s ago`
  if (elapsed < HOUR) return `${String(Math.floor(elapsed / MINUTE))}m ago`
  if (elapsed < DAY) return `${String(Math.floor(elapsed / HOUR))}h ago`
  return `${String(Math.floor(elapsed / DAY))}d ago`
}

/**
 * The two largest whole units of an Effect `Duration.format` string, which is how the admin API
 * reports uptime: "1h 12m 1s 234ms 500000ns" → "1h 12m", "42s 7ms" → "42s", "0" → "0s"
 */
export const shortDuration = (formatted: string): string => {
  const units = formatted.split(" ").filter((part) => /^\d+[dhms]$/.test(part))
  return units.length === 0 ? "0s" : units.slice(0, 2).join(" ")
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0")

/** The time of day in UTC, to the millisecond: 1759659292311 → "10:14:52.311" */
export const clockTime = (epochMs: number): string => {
  const at = DateTime.toPartsUtc(DateTime.makeUnsafe(epochMs))
  return `${pad(at.hour)}:${pad(at.minute)}:${pad(at.second)}.${pad(at.millisecond, 3)}`
}

/** The date and time in UTC, to the millisecond: 1759659292311 → "2025-10-05 10:14:52.311" */
export const dateTime = (epochMs: number): string => {
  const at = DateTime.toPartsUtc(DateTime.makeUnsafe(epochMs))
  return `${pad(at.year, 4)}-${pad(at.month)}-${pad(at.day)} ${clockTime(epochMs)}`
}
