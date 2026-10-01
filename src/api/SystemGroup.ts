import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { HealthResponse, ServerInfoResponse } from "../schemas/ImposterSchema.js"

export const SystemGroup = HttpApiGroup.make("system", { topLevel: true })
  .add(HttpApiEndpoint.get("healthCheck", "/health", { success: HealthResponse }))
  .add(HttpApiEndpoint.get("serverInfo", "/info", { success: ServerInfoResponse }))
