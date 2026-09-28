import { Clock, DateTime, Effect } from "effect"
import * as Duration from "effect/Duration"
import * as Schema from "effect/Schema"

// Common enums
export const ImposterStatus = Schema.Literals(["running", "stopped", "starting", "stopping"])
export type ImposterStatus = Schema.Schema.Type<typeof ImposterStatus>

// The built-in protocol. Any other protocol is provided by an imposter extension.
export const HttpProtocol = "HTTP"

// Uppercase letters and digits, starting with a letter: "HTTP", "S3", ...
export const ProtocolPattern = /^[A-Z][A-Z0-9]*$/
export const Protocol = Schema.String.check(Schema.isPattern(ProtocolPattern))
export type Protocol = Schema.Schema.Type<typeof Protocol>

// Utility schemas for validation
export const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("PositiveInteger")
)
export type PositiveInteger = Schema.Schema.Type<typeof PositiveInteger>

export const NonEmptyString = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("NonEmptyString")
)
export type NonEmptyString = Schema.Schema.Type<typeof NonEmptyString>

export const PortNumber = Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65535 })).pipe(
  Schema.brand("PortNumber")
)
export type PortNumber = Schema.Schema.Type<typeof PortNumber>

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const PaginationQuery = Schema.Struct({
  // Defaults are encoded values, so they are decoded (and brand-checked) like any input.
  limit: PositiveInteger.pipe(Schema.withDecodingDefault(Effect.succeed(50))),
  offset: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0)))
})
export type PaginationQuery = Schema.Schema.Type<typeof PaginationQuery>

export const PaginationMeta = Schema.Struct({
  total: NonNegativeInt,
  limit: PositiveInteger,
  offset: NonNegativeInt,
  hasMore: Schema.Boolean
})
export type PaginationMeta = Schema.Schema.Type<typeof PaginationMeta>

export const ErrorCode = Schema.Literals([
  // Validation errors
  "VALIDATION_ERROR",
  "INVALID_ENDPOINT",
  // Resource errors
  "IMPOSTER_NOT_FOUND",
  "PORT_IN_USE",
  "IMPOSTER_BUSY",
  // System errors
  "SYSTEM_ERROR",
  "CONFIRMATION_REQUIRED",
  // Conflict errors
  "ENDPOINT_CONFLICT"
])
export type ErrorCode = Schema.Schema.Type<typeof ErrorCode>

export const ErrorDetails = Schema.Struct({
  code: ErrorCode,
  message: NonEmptyString,
  field: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Unknown),
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
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
export const currentDateTime = Effect.map(Clock.currentTimeMillis, (ms) => DateTime.makeUnsafe(ms))

// Helper to format duration as uptime string (HH:MM:SS)
export const formatDurationAsUptime = (duration: Duration.Duration): string => {
  return Duration.format(duration)
}
