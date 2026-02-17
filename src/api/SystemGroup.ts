import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { HealthResponse, ServerInfoResponse } from "../schemas/ImposterSchema"

export const SystemGroup = HttpApiGroup.make("system", { topLevel: true })
  .add(
    HttpApiEndpoint.get("healthCheck", "/health")
      .addSuccess(HealthResponse)
  )
  .add(
    HttpApiEndpoint.get("serverInfo", "/info")
      .addSuccess(ServerInfoResponse)
  )
