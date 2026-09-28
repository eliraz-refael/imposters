import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SchemaIssue from "effect/SchemaIssue"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError, HttpApiSwagger } from "effect/unstable/httpapi"
import { AdminApi } from "../api/AdminApi"
import { ImpostersHandlersLive } from "../api/ImpostersHandlers"
import { SystemHandlersLive } from "../api/SystemHandlers"

const HandlerLayers = Layer.mergeAll(ImpostersHandlersLive, SystemHandlersLive)

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

// Effect v4 answers a request that fails schema decoding with an empty 400.
// Users configuring stubs through the API need to know what was rejected, so
// render the failure as JSON, in the same `HttpApiDecodeError` shape v3 used.
const DecodeErrorBody = HttpRouter.middleware(
  (httpEffect) =>
    httpEffect.pipe(
      // HttpApiBuilder turns schema failures into defects before they reach middleware.
      Effect.catchDefect((defect) =>
        HttpApiError.HttpApiSchemaError.is(defect)
          ? Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              {
                _tag: "HttpApiDecodeError",
                kind: defect.kind,
                message: defect.cause.message,
                issues: formatIssues(defect.cause.issue).issues
              },
              { status: 400 }
            )
          )
          : Effect.die(defect)
      )
    ),
  { global: true }
)

// Routes for the typed API, the OpenAPI document and the Swagger UI. They are
// registered on the HttpRouter that HttpRouter.toWebHandler supplies.
export const ApiLayer = Layer.mergeAll(
  HttpApiBuilder.layer(AdminApi, { openapiPath: "/openapi.json" }),
  HttpApiSwagger.layer(AdminApi),
  DecodeErrorBody
).pipe(
  Layer.provide(HandlerLayers),
  Layer.provide(HttpServer.layerServices),
  // v3 did not log each request; keep the CLI output quiet.
  Layer.provide(HttpRouter.disableLogger)
)
