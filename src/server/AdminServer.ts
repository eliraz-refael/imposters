import { HttpApiBuilder } from "@effect/platform"
import * as Layer from "effect/Layer"
import { ApiLayer } from "../layers/ApiLayer.js"
import { MainLayer } from "../layers/MainLayer.js"
import { makeAdminUiRouter } from "../ui/admin/AdminUiRouter.js"

export const FullLayer = ApiLayer.pipe(Layer.provide(MainLayer))

export const makeWebHandler = () => HttpApiBuilder.toWebHandler(FullLayer)

export const makeCompositeHandler = (adminPort: number) => {
  const { dispose, handler: apiHandler } = HttpApiBuilder.toWebHandler(FullLayer)
  const adminUiRouter = makeAdminUiRouter({ apiHandler, adminPort })

  const handler = async (request: Request): Promise<Response> => {
    const uiResponse = await adminUiRouter(request)
    if (uiResponse !== null) return uiResponse
    return apiHandler(request)
  }

  return { handler, dispose }
}
