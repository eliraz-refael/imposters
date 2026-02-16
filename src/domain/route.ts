import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { pipe } from "effect/Function"
import * as Option from "effect/Option"
import type * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"
import { Uuid } from "../services/Uuid.js"

const HttpMethodSchema = Schema.Literal("GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS")

const StatusCodeSchema = Schema.Number.pipe(Schema.int(), Schema.between(100, 599))

const DelaySchema = Schema.Number.pipe(Schema.int(), Schema.between(0, 60000))

const PathSchema = Schema.String.pipe(
  Schema.startsWith("/"),
  Schema.pattern(/^\/[a-zA-Z0-9\-._~!$&'()*+,;=:@/{}[\]]*$/)
)

const ResponseSchema = Schema.Struct({
  status: Schema.optionalWith(StatusCodeSchema, { default: () => 200 }),
  headers: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String })
  ),
  body: Schema.Unknown
})

const CreateRouteRequestSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  path: PathSchema,
  method: Schema.optionalWith(HttpMethodSchema, { default: () => "GET" }),
  response: ResponseSchema,
  delay: Schema.optional(DelaySchema)
})

export interface Route {
  readonly _tag: "Route"
  readonly id: string
  readonly path: string
  readonly method: typeof HttpMethodSchema.Type
  readonly response: Response
  readonly delay: Option.Option<Duration.Duration>
  readonly createdAt: DateTime.Utc
}

export const Route = Data.tagged<Route>("Route")

export interface Response {
  readonly _tag: "Response"
  readonly status: number
  readonly headers: Option.Option<Record<string, string>>
  readonly body: unknown
}

export const Response = Data.tagged<Response>("Response")

export interface CreateRouteRequest {
  readonly _tag: "CreateRouteRequest"
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

export const CreateRouteRequest = Data.tagged<CreateRouteRequest>("CreateRouteRequest")

// Tagged errors
export class RouteError extends Data.TaggedError("RouteError")<{
  readonly reason: string
  readonly field?: string
  readonly value?: unknown
}> {}

export class RouteNotFoundError extends Data.TaggedError("RouteNotFoundError")<{
  readonly id: string
}> {}

// Pure functions following Effect patterns

/**
 * Parses and validates route creation request
 */
export const parseCreateRouteRequest = (
  input: unknown
): Effect.Effect<typeof CreateRouteRequestSchema.Type, ParseResult.ParseError> =>
  Schema.decodeUnknown(CreateRouteRequestSchema)(input)

/**
 * Creates a new route from validated input
 */
export const createRoute = (
  validatedInput: typeof CreateRouteRequestSchema.Type
) =>
  Effect.gen(function*() {
    const uuid = yield* Uuid
    const id = validatedInput.id ?? (yield* uuid.generate)

    const response = Response({
      status: validatedInput.response.status,
      headers: Option.fromNullable(validatedInput.response.headers),
      body: validatedInput.response.body
    })

    return Route({
      id,
      path: validatedInput.path,
      method: validatedInput.method,
      response,
      delay: pipe(
        validatedInput.delay,
        Option.fromNullable,
        Option.map(Duration.millis)
      ),
      createdAt: DateTime.unsafeNow()
    })
  })

/**
 * Creates a new route from raw input (parse + create)
 */
export const newRoute = (input: unknown) =>
  Effect.gen(function*() {
    const validated = yield* parseCreateRouteRequest(input)
    return yield* createRoute(validated)
  })

/**
 * Updates a route preserving creation time and ID
 */
export const updateRoute = (updates: Partial<typeof CreateRouteRequestSchema.Type>) => (existingRoute: Route) =>
  Effect.gen(function*() {
    const updateRequest = {
      id: existingRoute.id,
      path: updates.path ?? existingRoute.path,
      method: updates.method ?? existingRoute.method,
      response: updates.response ?? {
        status: existingRoute.response.status,
        headers: Option.getOrUndefined(existingRoute.response.headers),
        body: existingRoute.response.body
      },
      delay: updates.delay ?? pipe(
        existingRoute.delay,
        Option.map(Duration.toMillis),
        Option.getOrUndefined
      )
    }

    const updated = yield* createRoute(updateRequest)

    return Route({
      ...updated,
      createdAt: existingRoute.createdAt
    })
  })

/**
 * Substitutes parameters in a string using Effect's String utilities
 */
const substituteInString = (params: Record<string, string>) => (str: string): string =>
  Object.entries(params).reduce((acc, [key, value]) => acc.replaceAll(`{{${key}}}`, value), str)

/**
 * Recursively substitutes parameters in unknown data structure
 */
export const substituteParams = (params: Record<string, string>) => (body: unknown): unknown => {
  if (typeof body === "string") return substituteInString(params)(body)
  if (Array.isArray(body)) return body.map(substituteParams(params))
  // TypeScript narrows `typeof body === "object"` to `object | null`, but we've excluded null and Array above.
  // The cast to Record<string, unknown> is necessary since TS cannot narrow `object` to an indexable type.
  if (body !== null && typeof body === "object") {
    return Object.fromEntries(
      Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, substituteParams(params)(v)])
    )
  }
  return body
}

/**
 * Creates a response with substituted parameters
 */
export const createResponseWithParams = (params: Record<string, string>) => (response: Response): Response =>
  Response({
    ...response,
    body: substituteParams(params)(response.body)
  })

/**
 * Extracts route summary for API responses
 */
export const toRouteSummary = (route: Route) => ({
  id: route.id,
  path: route.path,
  method: route.method,
  status: route.response.status,
  hasDelay: Option.isSome(route.delay),
  delayMs: pipe(
    route.delay,
    Option.map(Duration.toMillis),
    Option.getOrUndefined
  ),
  createdAt: DateTime.formatIso(route.createdAt)
})

/**
 * Gets delay in milliseconds for compatibility
 */
export const getDelayMillis = (route: Route): Option.Option<number> => Option.map(route.delay, Duration.toMillis)

/**
 * Checks if route has custom headers
 */
export const hasCustomHeaders = (route: Route): boolean => Option.isSome(route.response.headers)

/**
 * Gets headers as record or empty object
 */
export const getHeaders = (route: Route): Record<string, string> =>
  pipe(
    route.response.headers,
    Option.getOrElse(() => ({}))
  )

/**
 * Checks if route has delay configured
 */
export const hasDelay = (route: Route): boolean => Option.isSome(route.delay)

/**
 * Creates a minimal route for testing
 */
export const createMinimalRoute = (path: string) => (method: typeof HttpMethodSchema.Type = "GET") =>
  Effect.gen(function*() {
    const uuid = yield* Uuid
    const id = yield* uuid.generateShort

    return Route({
      id,
      path,
      method,
      response: Response({
        status: 200,
        headers: Option.none(),
        body: { message: "OK" }
      }),
      delay: Option.none(),
      createdAt: DateTime.unsafeNow()
    })
  })
