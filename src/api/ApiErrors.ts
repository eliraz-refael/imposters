import * as Schema from "effect/Schema"

export class ApiNotFoundError extends Schema.TaggedError<ApiNotFoundError>()(
  "ApiNotFoundError",
  { message: Schema.String, resourceType: Schema.String, resourceId: Schema.String },
  { httpApiStatus: 404 }
) {}

export class ApiConflictError extends Schema.TaggedError<ApiConflictError>()(
  "ApiConflictError",
  { message: Schema.String },
  { httpApiStatus: 409 }
) {}

export class ApiServiceError extends Schema.TaggedError<ApiServiceError>()(
  "ApiServiceError",
  { message: Schema.String },
  { httpApiStatus: 503 }
) {}

export class ApiBadRequestError extends Schema.TaggedError<ApiBadRequestError>()(
  "ApiBadRequestError",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}
