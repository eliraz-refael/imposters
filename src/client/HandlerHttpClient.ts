import { HttpClient, HttpClientResponse } from "@effect/platform"
import { Effect, Layer } from "effect"

export const makeHandlerHttpClient = (
  handler: (request: Request) => Promise<Response>
): HttpClient.HttpClient =>
  HttpClient.make((request, url) =>
    Effect.tryPromise({
      try: async () => {
        const method = request.method
        const headers: Record<string, string> = {}
        for (const key of Object.keys(request.headers)) {
          headers[key] = request.headers[key]!
        }

        let body: BodyInit | undefined
        switch (request.body._tag) {
          case "Uint8Array":
            body = new globalThis.Uint8Array(request.body.body)
            break
          case "Raw": {
            const raw = request.body.body
            body = typeof raw === "string" ? raw : JSON.stringify(raw)
            break
          }
          case "Empty":
            body = undefined
            break
          default:
            body = undefined
        }

        const webRequest = new Request(url.toString(), {
          method,
          headers,
          ...(body !== undefined ? { body } : {})
        })

        const webResponse = await handler(webRequest)
        return HttpClientResponse.fromWeb(request, webResponse)
      },
      catch: (error) => {
        throw error
      }
    })
  )

export const HandlerHttpClientLive = (
  handler: (request: Request) => Promise<Response>
): Layer.Layer<HttpClient.HttpClient> => Layer.succeed(HttpClient.HttpClient, makeHandlerHttpClient(handler))
