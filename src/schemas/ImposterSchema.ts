import * as Schema from "effect/Schema"
import {
  ImposterStatus,
  NonEmptyString,
  PaginationMeta,
  PaginationQuery,
  PortNumber,
  Protocol,
  ProtocolFilter,
  StatusFilter
} from "./common"
import { ProxyConfig } from "./StubSchema"

// Create Imposter Request Schema - POST /imposters
export const CreateImposterRequest = Schema.Struct({
  name: Schema.optional(NonEmptyString),
  port: Schema.optional(PortNumber),
  protocol: Schema.optionalWith(Protocol, { default: () => "HTTP" as const }),
  adminPath: Schema.optionalWith(
    Schema.String.pipe(Schema.startsWith("/")),
    { default: () => "/_admin" }
  ),
  proxy: Schema.optional(ProxyConfig)
})
export type CreateImposterRequest = Schema.Schema.Type<typeof CreateImposterRequest>

// Update Imposter Request Schema - PATCH /imposters/{id}
export const UpdateImposterRequest = Schema.Struct({
  name: Schema.optional(NonEmptyString),
  status: Schema.optional(ImposterStatus),
  port: Schema.optional(PortNumber),
  adminPath: Schema.optional(Schema.String.pipe(Schema.startsWith("/"))),
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
  path: Schema.String.pipe(Schema.startsWith("/")),
  method: Schema.optionalWith(
    Schema.Literal("GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"),
    { default: () => "GET" as const }
  ),
  response: Schema.Struct({
    status: Schema.optionalWith(
      Schema.Number.pipe(Schema.int(), Schema.between(100, 599)),
      { default: () => 200 }
    ),
    headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
    body: Schema.optional(Schema.Unknown)
  }),
  delay: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(0, 60000)))
})
export type CreateRouteRequest = Schema.Schema.Type<typeof CreateRouteRequest>

export const RouteResponse = Schema.Struct({
  id: NonEmptyString,
  path: NonEmptyString,
  method: Schema.Literal("GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"),
  response: Schema.Struct({
    status: Schema.Number.pipe(Schema.int(), Schema.between(100, 599)),
    headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
    body: Schema.optional(Schema.Unknown)
  }),
  delay: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(0, 60000))),
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
  status: Schema.Number.pipe(Schema.int(), Schema.between(100, 599)),
  hasDelay: Schema.Boolean,
  delayMs: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative()))
})
export type EndpointSummary = Schema.Schema.Type<typeof EndpointSummary>

// Statistics Schema
export const Statistics = Schema.Struct({
  totalRequests: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  requestsPerMinute: Schema.Number.pipe(Schema.nonNegative()),
  averageResponseTime: Schema.Number.pipe(Schema.nonNegative()),
  errorRate: Schema.Number.pipe(Schema.between(0, 1)),
  requestsByMethod: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Number }),
    { default: () => ({}) }
  ),
  requestsByStatusCode: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Number }),
    { default: () => ({}) }
  ),
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
  endpointCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
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
  force: Schema.optionalWith(Schema.Boolean, { default: () => false })
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
  total: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  running: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  stopped: Schema.Number.pipe(Schema.int(), Schema.nonNegative())
})
export type ImpostersSummary = Schema.Schema.Type<typeof ImpostersSummary>

// System Ports Summary Schema
export const PortsSummary = Schema.Struct({
  available: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  allocated: Schema.Number.pipe(Schema.int(), Schema.nonNegative())
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
  status: Schema.Literal("healthy", "unhealthy"),
  timestamp: Schema.DateTimeUtc,
  version: NonEmptyString,
  uptime: Schema.String, // Formatted duration
  system: SystemInfo
})
export type HealthResponse = Schema.Schema.Type<typeof HealthResponse>

// Server Configuration Schema
export const ServerConfiguration = Schema.Struct({
  maxImposters: Schema.Number.pipe(Schema.int(), Schema.positive()),
  portRange: Schema.Struct({
    min: PortNumber,
    max: PortNumber
  }),
  defaultTimeout: Schema.Number.pipe(Schema.int(), Schema.positive()),
  logLevel: Schema.Literal("debug", "info", "warn", "error")
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
