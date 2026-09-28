import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  ImposterStatus,
  NonEmptyString,
  NonNegativeInt,
  PaginationMeta,
  PaginationQuery,
  PortNumber,
  Protocol,
  ProtocolFilter,
  StatusFilter
} from "./common"
import { ProxyConfig } from "./StubSchema"

const AdminPath = Schema.String.check(Schema.isStartsWith("/"))
const HttpMethod = Schema.Literals(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
const StatusCode = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))
const DelayMs = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60000 }))
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const StringRecord = Schema.Record(Schema.String, Schema.String)
const NumberRecord = Schema.Record(Schema.String, Schema.Number)

// Create Imposter Request Schema - POST /imposters
export const CreateImposterRequest = Schema.Struct({
  name: Schema.optional(NonEmptyString),
  port: Schema.optional(PortNumber),
  protocol: Protocol.pipe(Schema.withDecodingDefault(Effect.succeed("HTTP" as const))),
  adminPath: AdminPath.pipe(Schema.withDecodingDefault(Effect.succeed("/_admin"))),
  proxy: Schema.optional(ProxyConfig)
})
export type CreateImposterRequest = Schema.Schema.Type<typeof CreateImposterRequest>

// Update Imposter Request Schema - PATCH /imposters/{id}
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
export const Statistics = Schema.Struct({
  totalRequests: NonNegativeInt,
  requestsPerMinute: NonNegativeNumber,
  averageResponseTime: NonNegativeNumber,
  errorRate: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  requestsByMethod: NumberRecord.pipe(Schema.withDecodingDefault(Effect.sync(() => ({})))),
  requestsByStatusCode: NumberRecord.pipe(Schema.withDecodingDefault(Effect.sync(() => ({})))),
  lastRequestAt: Schema.optional(Schema.DateTimeUtc),
  p50ResponseTime: Schema.optional(Schema.Number),
  p95ResponseTime: Schema.optional(Schema.Number),
  p99ResponseTime: Schema.optional(Schema.Number)
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
