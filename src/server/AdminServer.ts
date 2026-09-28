import * as Layer from "effect/Layer"
import { HttpRouter } from "effect/unstable/http"
import { ApiLayer } from "../layers/ApiLayer"
import { MainLayer } from "../layers/MainLayer"
import { makeAdminUiRouter } from "../ui/admin/AdminUiRouter"

export const FullLayer = ApiLayer.pipe(Layer.provide(MainLayer))

// disableLogger also silences requests that match no route (v3 logged nothing).
export const makeWebHandler = () => HttpRouter.toWebHandler(FullLayer, { disableLogger: true })

export const makeCompositeHandler = (adminPort: number) => {
  const { dispose, handler: apiHandler } = makeWebHandler()
  const adminUiRouter = makeAdminUiRouter({ apiHandler, adminPort })

  const handler = async (request: Request): Promise<Response> => {
    const uiResponse = await adminUiRouter(request)
    if (uiResponse !== null) return uiResponse
    return apiHandler(request)
  }

  return { handler, dispose }
}
