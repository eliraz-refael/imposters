import { HttpApiEndpoint } from "@effect/platform"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { pipe } from "effect/Function"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Uuid } from "src/services/Uuid.js"

// Schemas for mock endpoint creation
const MockResponseSchema = Schema.Struct({
  status: Schema.optionalWith(Schema.Number.pipe(Schema.int(), Schema.between(100, 599)), { default: () => 200 }),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  body: Schema.Unknown
})

const CreateMockEndpointRequestSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  path: Schema.String.pipe(
    Schema.startsWith("/"),
    Schema.pattern(/^\/[a-zA-Z0-9\-._~!$&'()*+,;=:@/{}[\]]*$/)
  ),
  method: Schema.optionalWith(
    Schema.Literal("GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"),
    { default: () => "GET" }
  ),
  response: MockResponseSchema,
  delay: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(0, 60000)))
})

// Domain types
export interface MockEndpoint {
  readonly _tag: "MockEndpoint"
  readonly id: string
  readonly endpoint: HttpApiEndpoint.HttpApiEndpoint.Any
  readonly delay: Option.Option<Duration.Duration>
  readonly createdAt: Date
  readonly originalConfig: typeof CreateMockEndpointRequestSchema.Type
}

export const MockEndpoint = Data.tagged<MockEndpoint>("MockEndpoint")

export interface CreateMockEndpointRequest {
  readonly _tag: "CreateMockEndpointRequest"
  readonly id?: string
  readonly path: string
  readonly method?: string
  readonly response: {
    readonly status?: number
    readonly headers?: Record<string, string>
    readonly body: unknown
  }
  readonly delay?: number
}

export const CreateMockEndpointRequest = Data.tagged<CreateMockEndpointRequest>("CreateMockEndpointRequest")

// Tagged errors
export interface EndpointError {
  readonly _tag: "EndpointError"
  readonly reason: string
  readonly field?: string
  readonly value?: unknown
}

export const EndpointError = Data.tagged<EndpointError>("EndpointError")

export interface EndpointNotFoundError {
  readonly _tag: "EndpointNotFoundError"
  readonly id: string
}

export const EndpointNotFoundError = Data.tagged<EndpointNotFoundError>("EndpointNotFoundError")

/**
 * Parses and validates mock endpoint creation request
 */
export const parseCreateMockEndpointRequest = (
  input: unknown
) => Schema.decodeUnknown(CreateMockEndpointRequestSchema)(input)

/**
 * Creates an HttpApiEndpoint from validated input
 */
export const createHttpApiEndpoint = (
  validatedInput: typeof CreateMockEndpointRequestSchema.Type
): HttpApiEndpoint.HttpApiEndpoint.Any => {
  const { method, path, response } = validatedInput

  // Create the response schema with the actual body
  // const responseSchema = Schema.Struct({
  //   ...response,
  //   body: Schema.Unknown // We'll use the actual body value
  // })

  // Create base endpoint based on method
  const baseEndpoint = (() => {
    switch (method) {
      case "GET":
        return HttpApiEndpoint.get(validatedInput.id || "mock", path)
      case "POST":
        return HttpApiEndpoint.post(validatedInput.id || "mock", path)
      case "PUT":
        return HttpApiEndpoint.put(validatedInput.id || "mock", path)
      case "DELETE":
        return HttpApiEndpoint.del(validatedInput.id || "mock", path)
      case "PATCH":
        return HttpApiEndpoint.patch(validatedInput.id || "mock", path)
      case "HEAD":
        return HttpApiEndpoint.head(validatedInput.id || "mock", path)
      case "OPTIONS":
        return HttpApiEndpoint.options(validatedInput.id || "mock", path)
      default:
        return HttpApiEndpoint.get(validatedInput.id || "mock", path)
    }
  })()

  // Add success response
  const endpointWithResponse = baseEndpoint.addSuccess(
    Schema.Unknown, // Use unknown for flexible mock responses
    { status: response.status }
  )

  // Add headers if provided
  if (response.headers && Object.keys(response.headers).length > 0) {
    return endpointWithResponse.setHeaders(
      Schema.Struct(
        Object.fromEntries(
          Object.keys(response.headers).map((key) => [key, Schema.String])
        )
      )
    )
  }

  return endpointWithResponse
}

/**
 * Creates a MockEndpoint from validated input
 */
export const createMockEndpoint = (
  validatedInput: typeof CreateMockEndpointRequestSchema.Type
): Effect.Effect<MockEndpoint, never, UuidService> =>
  Effect.gen(function*() {
    const uuid = yield* Uuid
    const id = validatedInput.id ?? (yield* uuid.generateShort)

    // Create the HttpApiEndpoint
    const endpoint = createHttpApiEndpoint({
      ...validatedInput,
      id
    })

    return MockEndpoint({
      id,
      endpoint,
      delay: pipe(
        validatedInput.delay,
        Option.fromNullable,
        Option.map(Duration.millis)
      ),
      createdAt: new Date(),
      originalConfig: validatedInput
    })
  })

/**
 * Creates a new mock endpoint from raw input (parse + create)
 */
export const newMockEndpoint = (input: unknown) =>
  Effect.gen(function*() {
    const validated = yield* parseCreateMockEndpointRequest(input)
    return yield* createMockEndpoint(validated)
  })

/**
 * Updates a mock endpoint preserving creation time and ID
 */
export const updateMockEndpoint =
  (updates: Partial<typeof CreateMockEndpointRequestSchema.Type>) => (existingEndpoint: MockEndpoint) =>
    Effect.gen(function*() {
      const updateRequest = {
        id: existingEndpoint.id,
        path: updates.path ?? existingEndpoint.originalConfig.path,
        method: updates.method ?? existingEndpoint.originalConfig.method,
        response: updates.response ?? existingEndpoint.originalConfig.response,
        delay: updates.delay ?? existingEndpoint.originalConfig.delay
      }

      const updated = yield* createMockEndpoint(updateRequest)

      return MockEndpoint({
        ...updated,
        createdAt: existingEndpoint.createdAt
      })
    })

/**
 * Extracts endpoint summary for API responses
 */
export const toEndpointSummary = (mockEndpoint: MockEndpoint) => ({
  id: mockEndpoint.id,
  path: mockEndpoint.originalConfig.path,
  method: mockEndpoint.originalConfig.method,
  status: mockEndpoint.originalConfig.response.status,
  hasDelay: Option.isSome(mockEndpoint.delay),
  delayMs: pipe(
    mockEndpoint.delay,
    Option.map(Duration.toMillis),
    Option.getOrUndefined
  ),
  createdAt: mockEndpoint.createdAt.toISOString()
})

/**
 * Gets delay in milliseconds for compatibility
 */
export const getDelayMillis = (mockEndpoint: MockEndpoint): Option.Option<number> =>
  Option.map(mockEndpoint.delay, Duration.toMillis)

/**
 * Checks if endpoint has custom headers
 */
export const hasCustomHeaders = (mockEndpoint: MockEndpoint): boolean =>
  !!(mockEndpoint.originalConfig.response.headers &&
    Object.keys(mockEndpoint.originalConfig.response.headers).length > 0)

/**
 * Gets headers as record or empty object
 */
export const getHeaders = (mockEndpoint: MockEndpoint): Record<string, string> =>
  mockEndpoint.originalConfig.response.headers ?? {}

/**
 * Checks if endpoint has delay configured
 */
export const hasDelay = (mockEndpoint: MockEndpoint): boolean => Option.isSome(mockEndpoint.delay)

/**
 * Creates a minimal mock endpoint for testing
 */
export const createMinimalMockEndpoint = (path: string) => (method: "GET" | "POST" | "PUT" | "DELETE" = "GET") =>
  Effect.gen(function*() {
    const uuid = yield* Uuid
    const id = yield* uuid.generateShort

    const config = {
      id,
      path,
      method,
      response: {
        status: 200,
        body: { message: "OK" }
      }
    }

    return yield* createMockEndpoint(config)
  })
