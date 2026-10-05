import * as Layer from "effect/Layer"
import { HttpRouter } from "effect/unstable/http"
import type { ImposterExtension } from "../extensions/Extension.js"
import { ApiLayer } from "../layers/ApiLayer.js"
import { makeMainLayer } from "../layers/MainLayer.js"
import { makeAdminUiRouter } from "../ui/admin/AdminUiRouter.js"
import { DEFAULT_HOST } from "./ServerFactory.js"

// Extensions default to none, so existing callers keep a plain-HTTP server
export const makeFullLayer = (
  extensions: ReadonlyArray<ImposterExtension> = [],
  host: string = DEFAULT_HOST,
  adminPort?: number
) => ApiLayer.pipe(Layer.provide(makeMainLayer(extensions, host, adminPort)))

// Plain HTTP only, as before extensions existed
export const FullLayer = makeFullLayer()

// disableLogger also silences requests that match no route (v3 logged nothing).
export const makeWebHandler = (
  extensions: ReadonlyArray<ImposterExtension> = [],
  host: string = DEFAULT_HOST,
  adminPort?: number
) => HttpRouter.toWebHandler(makeFullLayer(extensions, host, adminPort), { disableLogger: true })

export const makeCompositeHandler = (
  adminPort: number,
  extensions: ReadonlyArray<ImposterExtension> = [],
  host: string = DEFAULT_HOST
) => {
  const { dispose, handler: apiHandler } = makeWebHandler(extensions, host, adminPort)
  const adminUiRouter = makeAdminUiRouter({ apiHandler, adminPort, host })

  const handler = async (request: Request): Promise<Response> => {
    const uiResponse = await adminUiRouter(request)
    if (uiResponse !== null) return uiResponse
    return apiHandler(request)
  }

  return { handler, dispose }
}
