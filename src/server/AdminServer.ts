import * as Layer from "effect/Layer"
import { HttpRouter } from "effect/unstable/http"
import type { ImposterExtension } from "../extensions/Extension"
import { ApiLayer } from "../layers/ApiLayer"
import { makeMainLayer } from "../layers/MainLayer"
import { makeAdminUiRouter } from "../ui/admin/AdminUiRouter"

// Extensions default to none, so existing callers keep a plain-HTTP server
export const makeFullLayer = (extensions: ReadonlyArray<ImposterExtension> = []) =>
  ApiLayer.pipe(Layer.provide(makeMainLayer(extensions)))

// Plain HTTP only, as before extensions existed
export const FullLayer = makeFullLayer()

// disableLogger also silences requests that match no route (v3 logged nothing).
export const makeWebHandler = (extensions: ReadonlyArray<ImposterExtension> = []) =>
  HttpRouter.toWebHandler(makeFullLayer(extensions), { disableLogger: true })

export const makeCompositeHandler = (adminPort: number, extensions: ReadonlyArray<ImposterExtension> = []) => {
  const { dispose, handler: apiHandler } = makeWebHandler(extensions)
  const adminUiRouter = makeAdminUiRouter({ apiHandler, adminPort })

  const handler = async (request: Request): Promise<Response> => {
    const uiResponse = await adminUiRouter(request)
    if (uiResponse !== null) return uiResponse
    return apiHandler(request)
  }

  return { handler, dispose }
}
