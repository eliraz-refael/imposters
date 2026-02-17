import { HttpApiSchema } from "@effect/platform"
import * as Schema from "effect/Schema"

export class ApiNotFoundError extends Schema.TaggedError<ApiNotFoundError>()(
  "ApiNotFoundError",
  { message: Schema.String, resourceType: Schema.String, resourceId: Schema.String },
  HttpApiSchema.annotations({ status: 404 })
) {}

export class ApiConflictError extends Schema.TaggedError<ApiConflictError>()(
  "ApiConflictError",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 409 })
) {}

export class ApiServiceError extends Schema.TaggedError<ApiServiceError>()(
  "ApiServiceError",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 503 })
) {}
