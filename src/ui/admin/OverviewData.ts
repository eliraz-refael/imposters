import * as DateTime from "effect/DateTime"
import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * What the /_ui overview shows, read from the admin API's JSON (`GET /imposters?stats=true`,
 * `/health`, `/info`) and summarised by pure functions, so the page template only formats.
 */

const Counts = Schema.Struct({ requests: Schema.Number, serverErrors: Schema.Number, unmatched: Schema.Number })
export type Counts = typeof Counts.Type

// The fields of the API's imposter JSON (with ?stats=true) that the overview shows
const ImposterJson = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  port: Schema.Number,
  status: Schema.String,
  protocol: Schema.String,
  endpointCount: Schema.Number,
  adminPath: Schema.String,
  statistics: Schema.optional(Schema.Struct({
    lastRequestAt: Schema.optional(Schema.DateTimeUtcFromString),
    p95ResponseTime: Schema.optional(Schema.Number),
    timeline: Schema.Array(Counts),
    last15Minutes: Counts
  }))
})
type ImposterJson = typeof ImposterJson.Type

export const decodeImposterPage = Schema.decodeUnknownOption(
  Schema.Struct({ imposters: Schema.Array(ImposterJson), pagination: Schema.Struct({ hasMore: Schema.Boolean }) })
)

export const decodeHealth = Schema.decodeUnknownOption(
  Schema.Struct({ timestamp: Schema.DateTimeUtcFromString, uptime: Schema.String })
)

export const decodeInfo = Schema.decodeUnknownOption(
  Schema.Struct({
    server: Schema.Struct({ protocols: Schema.Array(Schema.String) }),
    configuration: Schema.Struct({ portRange: Schema.Struct({ min: Schema.Number, max: Schema.Number }) })
  })
)

export interface ImposterRow {
  readonly id: string
  readonly name: string
  readonly port: number
  readonly protocol: string
  readonly running: boolean
  readonly stubs: number
  // The imposter's own /_admin UI, on the host the admin UI was reached through
  readonly uiUrl: string
  // Requests per 30-second bucket over the last 15 minutes, oldest first, for the sparkline. The
  // bucket in progress is left out: it is always partial, so drawn it would dip at the right edge.
  readonly timeline: ReadonlyArray<number>
  readonly last15: Counts
  readonly p95?: number
  readonly lastRequestAtMs?: number
}

const ZERO: Counts = { requests: 0, serverErrors: 0, unmatched: 0 }

export const toRow = (imp: ImposterJson, host: string): ImposterRow => {
  const stats = imp.statistics
  return {
    id: imp.id,
    name: imp.name,
    port: imp.port,
    protocol: imp.protocol,
    running: imp.status === "running",
    stubs: imp.endpointCount,
    uiUrl: `http://${host}:${String(imp.port)}${imp.adminPath}`,
    timeline: stats?.timeline.slice(0, -1).map((point) => point.requests) ?? [],
    last15: stats?.last15Minutes ?? ZERO,
    ...(stats?.p95ResponseTime !== undefined ? { p95: stats.p95ResponseTime } : {}),
    ...(stats?.lastRequestAt !== undefined ? { lastRequestAtMs: DateTime.toEpochMillis(stats.lastRequestAt) } : {})
  }
}

// A share of 5xx answers at or above this marks an imposter (and the strip) as failing
export const HOT_SERVER_ERROR_RATE = 0.05

export const isHot = (counts: Counts): boolean =>
  counts.requests > 0 && counts.serverErrors / counts.requests >= HOT_SERVER_ERROR_RATE

// Only an HTTP imposter can leave a request unmatched: an extension answers every request stubs miss
export const countsUnmatched = (row: ImposterRow): boolean => row.protocol === "HTTP"

export interface Summary {
  readonly total: number
  readonly running: number
  readonly stubs: number
  // Over the running imposters, the last 15 minutes
  readonly last15: Counts
  readonly timeline: ReadonlyArray<number>
  // The imposter with the most 5xx answers, if any had one
  readonly mostServerErrors?: ImposterRow
  // The imposter with the highest p95 since it started
  readonly slowest?: { readonly row: ImposterRow; readonly p95: number }
  // The imposter with the most unmatched requests, if any had one
  readonly mostUnmatched?: ImposterRow
}

const addCounts = (a: Counts, b: Counts): Counts => ({
  requests: a.requests + b.requests,
  serverErrors: a.serverErrors + b.serverErrors,
  unmatched: a.unmatched + b.unmatched
})

// Bucket-wise sum; every timeline is aligned to the same 30-second boundaries
const addTimelines = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): ReadonlyArray<number> =>
  Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0))

const maxBy = (rows: ReadonlyArray<ImposterRow>, score: (row: ImposterRow) => number): ImposterRow | undefined =>
  rows.reduce<ImposterRow | undefined>(
    (best, row) => score(row) > 0 && (best === undefined || score(row) > score(best)) ? row : best,
    undefined
  )

/**
 * The strip above the table. Traffic is summed over running imposters only, as the rows show
 * none for a stopped one; stubs count every imposter.
 */
export const summarize = (rows: ReadonlyArray<ImposterRow>): Summary => {
  const running = rows.filter((row) => row.running)
  const slowRow = maxBy(running, (row) => row.p95 ?? 0)
  const mostServerErrors = maxBy(running, (row) => row.last15.serverErrors)
  const mostUnmatched = maxBy(running.filter(countsUnmatched), (row) => row.last15.unmatched)
  return {
    total: rows.length,
    running: running.length,
    stubs: rows.reduce((sum, row) => sum + row.stubs, 0),
    last15: running.map((row) => row.last15).reduce(addCounts, ZERO),
    timeline: running.map((row) => row.timeline).reduce(addTimelines, []),
    ...(mostServerErrors !== undefined ? { mostServerErrors } : {}),
    ...(slowRow?.p95 !== undefined ? { slowest: { row: slowRow, p95: slowRow.p95 } } : {}),
    ...(mostUnmatched !== undefined ? { mostUnmatched } : {})
  }
}

/** Everything the page renders */
export interface Overview {
  readonly imposters: ReadonlyArray<ImposterRow>
  readonly summary: Summary
  // From /health: the admin API's clock, read once so every "ago" on the page agrees, and the
  // server's uptime as Duration.format prints it
  readonly health: Option.Option<{ readonly nowMs: number; readonly uptime: string }>
  // What the create form offers: HTTP, then each registered extension's
  readonly protocols: ReadonlyArray<string>
  readonly portRange: Option.Option<{ readonly min: number; readonly max: number }>
  // Where the admin server listens, for the header pill and the footer
  readonly bindHost: string
  readonly adminPort: number
  readonly version: string
}
