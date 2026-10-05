import type { ImposterConfig } from "../domain/imposter.js"
import type { Delay, Predicate, ResponseConfig } from "../schemas/StubSchema.js"
import { ago, count } from "./components/format.js"
import { type LiveData, type StubHits, stubLabel } from "./LiveData.js"

/**
 * What the stubs page (`/_admin/stubs`) shows, built from the live page's data by pure
 * functions, so the template only formats: a card per stub in matching order, and what answers
 * a request none of them matches.
 */

/** A predicate as a chip: `path equals "/orders"` */
export interface PredicateChip {
  readonly field: string
  readonly operator: string
  // The value as JSON, so a string shows its quotes and an object its braces; none for `exists` without one
  readonly value: string
  // Set only when the predicate ignores case (matching is case-sensitive by default)
  readonly ignoresCase: boolean
}

export type StatusTone = "ok" | "caution" | "error"

/** One response of a stub's card */
export interface ResponseView {
  readonly status: number
  readonly tone: StatusTone
  // Times it was given; undefined when the stub has one response (the stub's own hits say it)
  readonly hits: number | undefined
  // The response the stub gives next: only when there is a choice and it is known (not random)
  readonly next: boolean
  // "after 2,000 ms", "after 100–500 ms"
  readonly delay: string | undefined
  // The body on one line, shortened; undefined when there is none
  readonly body: string | undefined
}

export interface StubCard {
  readonly id: string
  // The id's first 8 characters, as the cards show it
  readonly shortId: string
  // From 1, in matching order
  readonly position: number
  // "GET /orders": for the delete confirmation
  readonly label: string
  readonly mode: string
  readonly hits: number
  // "1,624 hits · last 3s ago", or "no hits yet"
  readonly hitsLine: string
  readonly predicates: ReadonlyArray<PredicateChip>
  readonly responses: ReadonlyArray<ResponseView>
}

/** What answers a request no stub matches */
export type Fallback =
  | { readonly kind: "notFound"; readonly unmatched: number }
  | { readonly kind: "extension"; readonly protocol: string }
  | { readonly kind: "proxy"; readonly mode: string; readonly targetUrl: string }

export interface StubsData {
  readonly config: ImposterConfig
  readonly cards: ReadonlyArray<StubCard>
  readonly fallback: Fallback
}

const BODY_PREVIEW = 160

/** A delay as a card shows it: "after 2,000 ms", or "after 100–500 ms" for a range */
export const delayLabel = (delay: Delay): string =>
  typeof delay === "number" ? `after ${count(delay)} ms` : `after ${count(delay.min)}–${count(delay.max)} ms`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// JSON on one line with room to breathe: { "orders": [] }
const oneLine = (value: unknown): string => {
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[${value.map(oneLine).join(", ")}]`
  if (isRecord(value)) {
    const entries = Object.entries(value)
    return entries.length === 0
      ? "{}"
      : `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${oneLine(v)}`).join(", ")} }`
  }
  return JSON.stringify(value) ?? String(value)
}

/** A body on one line, at most `max` characters: a string as it is sent, anything else as JSON */
export const bodyPreview = (body: unknown, max = BODY_PREVIEW): string | undefined => {
  if (body === undefined) return undefined
  const text = typeof body === "string" ? body.replaceAll(/\s*\n\s*/g, " ") : oneLine(body)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** A response body as sent (text): JSON shown as bodyPreview shows it, anything else as it is */
export const sentBodyPreview = (text: string, max = BODY_PREVIEW): string | undefined => {
  if (text === "") return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return bodyPreview(parsed, max)
  } catch {
    return bodyPreview(text, max)
  }
}

export const statusTone = (status: number): StatusTone => status >= 500 ? "error" : status >= 400 ? "caution" : "ok"

export const predicateChip = (predicate: Predicate): PredicateChip => ({
  field: predicate.field,
  operator: predicate.operator,
  value: predicate.value === undefined ? "" : oneLine(predicate.value),
  ignoresCase: !predicate.caseSensitive
})

const responseView = (row: StubHits, response: ResponseConfig, index: number): ResponseView => {
  const several = row.stub.responses.length > 1
  return {
    status: response.status,
    tone: statusTone(response.status),
    hits: several ? (row.byResponse[index] ?? 0) : undefined,
    next: several && row.stub.responseMode !== "random" && row.nextIndex === index,
    delay: response.delay === undefined ? undefined : delayLabel(response.delay),
    body: bodyPreview(response.body)
  }
}

/** "1,624 hits · last 3s ago", "1 hit · last just now", or "no hits yet" */
export const hitsLine = (hits: number, lastHitAt: number | undefined, nowMs: number): string => {
  if (hits === 0) return "no hits yet"
  const total = `${count(hits)} ${hits === 1 ? "hit" : "hits"}`
  return lastHitAt === undefined ? total : `${total} · last ${ago(lastHitAt, nowMs)}`
}

export const stubCard = (row: StubHits, nowMs: number): StubCard => ({
  id: row.stub.id,
  shortId: row.stub.id.slice(0, 8),
  position: row.position,
  label: stubLabel(row.stub),
  mode: row.stub.responseMode,
  hits: row.hits,
  hitsLine: hitsLine(row.hits, row.lastHitAt, nowMs),
  predicates: row.stub.predicates.map(predicateChip),
  responses: row.stub.responses.map((response, i) => responseView(row, response, i))
})

// An extension or a proxy answers whatever no stub matches; otherwise it is a 404, and the
// requests that got one (and still would) are counted
export const fallbackOf = (live: LiveData): Fallback => {
  if (live.config.protocol !== "HTTP") return { kind: "extension", protocol: live.config.protocol }
  if (live.config.proxy !== undefined) {
    return { kind: "proxy", mode: live.config.proxy.mode, targetUrl: live.config.proxy.targetUrl }
  }
  return { kind: "notFound", unmatched: live.unmatched.reduce((sum, row) => sum + row.count, 0) }
}

export const buildStubsData = (live: LiveData): StubsData => ({
  config: live.config,
  cards: live.stubHits.map((row) => stubCard(row, live.nowMs)),
  fallback: fallbackOf(live)
})
