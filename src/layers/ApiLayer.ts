import { HttpApiBuilder, HttpApiSwagger, HttpServer } from "@effect/platform"
import * as Layer from "effect/Layer"
import { AdminApi } from "../api/AdminApi.js"
import { ImpostersHandlersLive } from "../api/ImpostersHandlers.js"
import { SystemHandlersLive } from "../api/SystemHandlers.js"

const HandlerLayers = Layer.mergeAll(ImpostersHandlersLive, SystemHandlersLive)

const ApiLive = HttpApiBuilder.api(AdminApi).pipe(Layer.provide(HandlerLayers))

// Middleware layers need Api — provide it from ApiLive
const MiddlewareLive = Layer.mergeAll(
  HttpApiBuilder.middlewareOpenApi(),
  HttpApiSwagger.layer()
).pipe(Layer.provide(ApiLive))

export const ApiLayer = Layer.mergeAll(
  ApiLive,
  MiddlewareLive,
  HttpServer.layerContext
)
