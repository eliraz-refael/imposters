import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Clock from "effect/Clock"
import * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"
import { Uuid } from "../services/Uuid.js"

// Schemas for validation
const ImposterNameSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(100),
  Schema.pattern(/^[a-zA-Z0-9-_]+$/)
)

const PortSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.between(1024, 65535)
)

type ImposterStatus = "running" | "stopped" | "starting" | "stopping"

const CreateImposterRequestSchema = Schema.Struct({
  name: Schema.optional(ImposterNameSchema),
  port: Schema.optional(PortSchema)
})

// Domain types using tagged interfaces
export interface ImposterConfig {
  readonly _tag: "ImposterConfig"
  readonly id: string
  readonly name: string
  readonly port: number
  readonly status: ImposterStatus
  readonly createdAt: DateTime.Utc
}

export const ImposterConfig = Data.tagged<ImposterConfig>("ImposterConfig")

export interface CreateImposterRequest {
  readonly _tag: "CreateImposterRequest"
  readonly name?: string
  readonly port?: number
}

export const CreateImposterRequest = Data.tagged<CreateImposterRequest>("CreateImposterRequest")

export interface ImposterRef {
  readonly _tag: "ImposterRef"
  readonly config: ImposterConfig
  readonly startTime: DateTime.Utc
  readonly endpointCount: number
}

export const ImposterRef = Data.tagged<ImposterRef>("ImposterRef")

// Tagged errors
export class ImposterError extends Data.TaggedError("ImposterError")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

export class PortInUseError extends Data.TaggedError("PortInUseError")<{
  readonly port: number
}> {}

export class ImposterNotFoundError extends Data.TaggedError("ImposterNotFoundError")<{
  readonly id: string
}> {}

/**
 * Parses and validates imposter creation request
 */
export const parseCreateImposterRequest = (
  input: unknown
): Effect.Effect<typeof CreateImposterRequestSchema.Type, ParseResult.ParseError> =>
  Schema.decodeUnknown(CreateImposterRequestSchema)(input)

/**
 * Creates a new imposter configuration from validated input
 */
export const createImposterConfig = (
  validatedInput: typeof CreateImposterRequestSchema.Type
) =>
  Effect.gen(function*() {
    const uuid = yield* Uuid
    const id = yield* uuid.generateShort
    const name = validatedInput.name ?? id

    return ImposterConfig({
      id,
      name,
      port: validatedInput.port ?? 0, // Will be assigned by port allocator if 0
      status: "starting",
      createdAt: DateTime.unsafeNow()
    })
  })

/**
 * Creates a new imposter from raw input (parse + create)
 */
export const newImposterConfig = (input: unknown) =>
  Effect.gen(function*() {
    const validated = yield* parseCreateImposterRequest(input)
    return yield* createImposterConfig(validated)
  })

/**
 * Updates imposter status
 */
export const updateImposterStatus = (status: ImposterStatus) => (config: ImposterConfig): ImposterConfig =>
  ImposterConfig({
    ...config,
    status
  })

/**
 * Updates imposter port
 */
export const updateImposterPort = (port: number) => (config: ImposterConfig): ImposterConfig =>
  ImposterConfig({
    ...config,
    port
  })

/**
 * Calculates imposter uptime using Effect's Duration
 */
export const calculateUptime = (startTime: DateTime.Utc) =>
  Effect.map(Clock.currentTimeMillis, (now) =>
    Duration.millis(now - DateTime.toEpochMillis(startTime)))

/**
 * Creates an ImposterRef from config and runtime info
 */
export const createImposterRef =
  (startTime: DateTime.Utc) => (endpointCount: number) => (config: ImposterConfig): ImposterRef =>
    ImposterRef({
      config,
      startTime,
      endpointCount
    })

/**
 * Extracts imposter summary for API responses
 */
export const toImposterSummary = (ref: ImposterRef) =>
  Effect.map(calculateUptime(ref.startTime), (uptime) => ({
    id: ref.config.id,
    name: ref.config.name,
    port: ref.config.port,
    status: ref.config.status,
    endpointCount: ref.endpointCount,
    createdAt: DateTime.formatIso(ref.config.createdAt),
    uptime: Duration.format(uptime)
  }))

/**
 * Gets uptime in human readable format
 */
export const getUptimeFormatted = (ref: ImposterRef) =>
  Effect.map(calculateUptime(ref.startTime), Duration.format)

/**
 * Checks if imposter is running
 */
export const isRunning = (config: ImposterConfig): boolean => config.status === "running"

/**
 * Checks if imposter can be started
 */
export const canStart = (config: ImposterConfig): boolean => config.status === "stopped" || config.status === "starting"

/**
 * Checks if imposter can be stopped
 */
export const canStop = (config: ImposterConfig): boolean => config.status === "running" || config.status === "stopping"
