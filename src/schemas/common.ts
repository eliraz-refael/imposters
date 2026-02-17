import { Clock, DateTime, Effect } from "effect"
import * as Duration from "effect/Duration"
import * as Schema from "effect/Schema"

// Common enums
export const ImposterStatus = Schema.Literal("running", "stopped", "starting", "stopping")
export type ImposterStatus = Schema.Schema.Type<typeof ImposterStatus>

export const Protocol = Schema.Literal("HTTP")
export type Protocol = Schema.Schema.Type<typeof Protocol>

// Utility schemas for validation
export const PositiveInteger = Schema.Number.pipe(
  Schema.int(),
  Schema.positive(),
  Schema.brand("PositiveInteger")
)
export type PositiveInteger = Schema.Schema.Type<typeof PositiveInteger>

export const NonEmptyString = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("NonEmptyString")
)
export type NonEmptyString = Schema.Schema.Type<typeof NonEmptyString>

export const PortNumber = Schema.Number.pipe(
  Schema.int(),
  Schema.between(1024, 65535),
  Schema.brand("PortNumber")
)
export type PortNumber = Schema.Schema.Type<typeof PortNumber>

export const PaginationQuery = Schema.Struct({
  // PositiveInteger.make() is safe here — 50 is a compile-time constant that always passes validation
  limit: Schema.optionalWith(PositiveInteger, { default: () => PositiveInteger.make(50) }),
  offset: Schema.optionalWith(
    Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
    { default: () => 0 }
  )
})
export type PaginationQuery = Schema.Schema.Type<typeof PaginationQuery>

export const PaginationMeta = Schema.Struct({
  total: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  limit: PositiveInteger,
  offset: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  hasMore: Schema.Boolean
})
export type PaginationMeta = Schema.Schema.Type<typeof PaginationMeta>

export const ErrorCode = Schema.Union(
  // Validation errors
  Schema.Literal("VALIDATION_ERROR"),
  Schema.Literal("INVALID_ENDPOINT"),
  // Resource errors
  Schema.Literal("IMPOSTER_NOT_FOUND"),
  Schema.Literal("PORT_IN_USE"),
  Schema.Literal("IMPOSTER_BUSY"),
  // System errors
  Schema.Literal("SYSTEM_ERROR"),
  Schema.Literal("CONFIRMATION_REQUIRED"),
  // Conflict errors
  Schema.Literal("ENDPOINT_CONFLICT")
)
export type ErrorCode = Schema.Schema.Type<typeof ErrorCode>

export const ErrorDetails = Schema.Struct({
  code: ErrorCode,
  message: NonEmptyString,
  field: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Unknown),
  details: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown }))
})
export type ErrorDetails = Schema.Schema.Type<typeof ErrorDetails>

export const ErrorResponse = Schema.Struct({
  error: ErrorDetails
})
export type ErrorResponse = Schema.Schema.Type<typeof ErrorResponse>

// Common query filters
export const StatusFilter = Schema.optional(ImposterStatus)
export const ProtocolFilter = Schema.optional(Protocol)

// DateTime schemas using Effect's DateTime
export const DateTimeSchema = Schema.DateTimeUtc
export type DateTimeSchema = Schema.Schema.Type<typeof DateTimeSchema>

// Helper to create current DateTime
export const currentDateTime = Effect.map(Clock.currentTimeMillis, (ms) => DateTime.unsafeMake(ms))

// Helper to format duration as uptime string (HH:MM:SS)
export const formatDurationAsUptime = (duration: Duration.Duration): string => {
  return Duration.format(duration)
}
