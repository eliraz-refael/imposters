import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  HttpProtocol,
  ImposterStatus,
  NonEmptyString,
  NonNegativeInt,
  PaginationMeta,
  PaginationQuery,
  PortNumber,
  Protocol,
  ProtocolFilter,
  StatusFilter
} from "./common.js"
import { DelayMs, ProxyConfig } from "./StubSchema.js"

const AdminPath = Schema.String.check(Schema.isStartsWith("/"))
const HttpMethod = Schema.Literals(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
const StatusCode = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const StringRecord = Schema.Record(Schema.String, Schema.String)
const NumberRecord = Schema.Record(Schema.String, Schema.Number)

// Create Imposter Request Schema - POST /imposters
export const CreateImposterRequest = Schema.Struct({
  name: Schema.optional(NonEmptyString),
  port: Schema.optional(PortNumber),
  protocol: Protocol.pipe(Schema.withDecodingDefault(Effect.succeed(HttpProtocol))),
  adminPath: AdminPath.pipe(Schema.withDecodingDefault(Effect.succeed("/_admin"))),
  proxy: Schema.optional(ProxyConfig)
})
export type CreateImposterRequest = Schema.Schema.Type<typeof CreateImposterRequest>

// Update Imposter Request Schema - PATCH /imposters/{id}
// `protocol` is fixed at creation: an imposter's extension instance is built from it.
export const UpdateImposterRequest = Schema.Struct({
  name: Schema.optional(NonEmptyString),
  status: Schema.optional(ImposterStatus),
  port: Schema.optional(PortNumber),
  adminPath: Schema.optional(AdminPath),
  proxy: Schema.optional(Schema.NullOr(ProxyConfig))
})
export type UpdateImposterRequest = Schema.Schema.Type<typeof UpdateImposterRequest>

// List Imposters Query Schema - GET /imposters query params
export const ListImpostersQuery = Schema.Struct({
  ...PaginationQuery.fields,
  status: StatusFilter,
  protocol: ProtocolFilter
})
export type ListImpostersQuery = Schema.Schema.Type<typeof ListImpostersQuery>

// Route API Schemas
export const CreateRouteRequest = Schema.Struct({
  path: AdminPath,
  method: HttpMethod.pipe(Schema.withDecodingDefault(Effect.succeed("GET" as const))),
  response: Schema.Struct({
    status: StatusCode.pipe(Schema.withDecodingDefault(Effect.succeed(200))),
    headers: Schema.optional(StringRecord),
    body: Schema.optional(Schema.Unknown)
  }),
  delay: Schema.optional(DelayMs)
})
export type CreateRouteRequest = Schema.Schema.Type<typeof CreateRouteRequest>

export const RouteResponse = Schema.Struct({
  id: NonEmptyString,
  path: NonEmptyString,
  method: HttpMethod,
  response: Schema.Struct({
    status: StatusCode,
    headers: Schema.optional(StringRecord),
    body: Schema.optional(Schema.Unknown)
  }),
  delay: Schema.optional(DelayMs),
  createdAt: Schema.DateTimeUtc
})
export type RouteResponse = Schema.Schema.Type<typeof RouteResponse>

export const ListRoutesResponse = Schema.Struct({
  routes: Schema.Array(RouteResponse),
  pagination: PaginationMeta
})
export type ListRoutesResponse = Schema.Schema.Type<typeof ListRoutesResponse>

// Endpoint Summary Schema (for imposter responses)
export const EndpointSummary = Schema.Struct({
  id: NonEmptyString,
  path: NonEmptyString,
  method: NonEmptyString,
  status: StatusCode,
  hasDelay: Schema.Boolean,
  delayMs: Schema.optional(NonNegativeInt)
})
export type EndpointSummary = Schema.Schema.Type<typeof EndpointSummary>

// Statistics Schema
const Rate = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

// Requests, 5xx answers and unmatched requests over a span of time
export const TrafficCounts = Schema.Struct({
  requests: NonNegativeInt,
  serverErrors: NonNegativeInt,
  unmatched: NonNegativeInt
})
export type TrafficCounts = Schema.Schema.Type<typeof TrafficCounts>

// One 30-second bucket of the timeline, starting at `start`
export const TimelinePoint = Schema.Struct({
  start: Schema.DateTimeUtc,
  ...TrafficCounts.fields
})
export type TimelinePoint = Schema.Schema.Type<typeof TimelinePoint>

// How often a stub answered, and which of its responses it gives next
export const StubStatistics = Schema.Struct({
  stubId: NonEmptyString,
  hits: NonNegativeInt,
  // Hits per response, indexed like the stub's `responses`
  byResponse: Schema.Array(NonNegativeInt),
  lastHitAt: Schema.optional(Schema.DateTimeUtc),
  // Absent in random mode, where the next response cannot be known
  nextResponseIndex: Schema.optional(NonNegativeInt)
})
export type StubStatistics = Schema.Schema.Type<typeof StubStatistics>

// Requests no stub, extension or proxy answered, grouped by method and path
export const UnmatchedStatistics = Schema.Struct({
  method: Schema.String,
  path: Schema.String,
  count: NonNegativeInt,
  lastSeenAt: Schema.DateTimeUtc
})
export type UnmatchedStatistics = Schema.Schema.Type<typeof UnmatchedStatistics>

// Counted since the imposter last started (or the last DELETE /stats)
export const Statistics = Schema.Struct({
  totalRequests: NonNegativeInt,
  requestsPerMinute: NonNegativeNumber,
  averageResponseTime: NonNegativeNumber,
  // 4xx and 5xx answers over all requests
  errorRate: Rate,
  // 5xx answers over all requests
  serverErrorRate: Rate,
  requestsByMethod: NumberRecord.pipe(Schema.withDecodingDefault(Effect.sync(() => ({})))),
  requestsByStatusCode: NumberRecord.pipe(Schema.withDecodingDefault(Effect.sync(() => ({})))),
  lastRequestAt: Schema.optional(Schema.DateTimeUtc),
  p50ResponseTime: Schema.optional(Schema.Number),
  p95ResponseTime: Schema.optional(Schema.Number),
  p99ResponseTime: Schema.optional(Schema.Number),
  // The last 15 minutes as 30 buckets of 30 seconds, oldest first; the last is the current one
  timeline: Schema.Array(TimelinePoint),
  // The timeline summed
  last15Minutes: TrafficCounts,
  // Every current stub, in matching order
  stubs: Schema.Array(StubStatistics),
  // Most recently seen first; at most 50 groups, the least recently seen dropped first
  unmatched: Schema.Array(UnmatchedStatistics)
})
export type Statistics = Schema.Schema.Type<typeof Statistics>

// Core Imposter Response Schema
export const ImposterResponse = Schema.Struct({
  id: NonEmptyString,
  name: NonEmptyString,
  port: PortNumber,
  protocol: Protocol,
  status: ImposterStatus,
  endpointCount: NonNegativeInt,
  createdAt: Schema.DateTimeUtc,
  adminUrl: NonEmptyString,
  adminPath: NonEmptyString,
  uptime: Schema.optional(Schema.String), // Formatted duration string
  endpoints: Schema.optional(Schema.Array(EndpointSummary)),
  statistics: Schema.optional(Statistics),
  proxy: Schema.optional(ProxyConfig)
})
export type ImposterResponse = Schema.Schema.Type<typeof ImposterResponse>

// List Imposters Response Schema - GET /imposters
export const ListImpostersResponse = Schema.Struct({
  imposters: Schema.Array(ImposterResponse),
  pagination: PaginationMeta
})
export type ListImpostersResponse = Schema.Schema.Type<typeof ListImpostersResponse>

// Delete Imposter Query Schema - DELETE /imposters/{id}
export const DeleteImposterQuery = Schema.Struct({
  force: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)))
})
export type DeleteImposterQuery = Schema.Schema.Type<typeof DeleteImposterQuery>

// Delete Imposter Response Schema
export const DeleteImposterResponse = Schema.Struct({
  message: NonEmptyString,
  id: NonEmptyString,
  deletedAt: Schema.DateTimeUtc
})
export type DeleteImposterResponse = Schema.Schema.Type<typeof DeleteImposterResponse>

// System Memory Info Schema
export const MemoryInfo = Schema.Struct({
  used: NonEmptyString,
  free: NonEmptyString
})
export type MemoryInfo = Schema.Schema.Type<typeof MemoryInfo>

// System Imposters Summary Schema
export const ImpostersSummary = Schema.Struct({
  total: NonNegativeInt,
  running: NonNegativeInt,
  stopped: NonNegativeInt
})
export type ImpostersSummary = Schema.Schema.Type<typeof ImpostersSummary>

// System Ports Summary Schema
export const PortsSummary = Schema.Struct({
  available: NonNegativeInt,
  allocated: NonNegativeInt
})
export type PortsSummary = Schema.Schema.Type<typeof PortsSummary>

// System Info Schema (for health endpoint)
export const SystemInfo = Schema.Struct({
  memory: MemoryInfo,
  imposters: ImpostersSummary,
  ports: PortsSummary
})
export type SystemInfo = Schema.Schema.Type<typeof SystemInfo>

// Health Response Schema - GET /health
export const HealthResponse = Schema.Struct({
  status: Schema.Literals(["healthy", "unhealthy"]),
  timestamp: Schema.DateTimeUtc,
  version: NonEmptyString,
  uptime: Schema.String, // Formatted duration
  system: SystemInfo
})
export type HealthResponse = Schema.Schema.Type<typeof HealthResponse>

// Server Configuration Schema
export const ServerConfiguration = Schema.Struct({
  maxImposters: PositiveInt,
  portRange: Schema.Struct({
    min: PortNumber,
    max: PortNumber
  }),
  defaultTimeout: PositiveInt,
  logLevel: Schema.Literals(["debug", "info", "warn", "error"])
})
export type ServerConfiguration = Schema.Schema.Type<typeof ServerConfiguration>

// Server Features Schema
export const ServerFeatures = Schema.Struct({
  openApiGeneration: Schema.Boolean,
  clientGeneration: Schema.Boolean,
  authentication: Schema.Boolean,
  clustering: Schema.Boolean
})
export type ServerFeatures = Schema.Schema.Type<typeof ServerFeatures>

// Server Info Schema
export const ServerInfo = Schema.Struct({
  name: NonEmptyString,
  version: NonEmptyString,
  buildTime: Schema.DateTimeUtc,
  platform: NonEmptyString,
  protocols: Schema.Array(Protocol)
})
export type ServerInfo = Schema.Schema.Type<typeof ServerInfo>

// Server Info Response Schema - GET /info
export const ServerInfoResponse = Schema.Struct({
  server: ServerInfo,
  configuration: ServerConfiguration,
  features: ServerFeatures
})
export type ServerInfoResponse = Schema.Schema.Type<typeof ServerInfoResponse>
