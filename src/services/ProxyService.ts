import { Context, Data, Effect, Layer } from "effect"
import type { ProxyConfigDomain } from "../domain/imposter"
import type { RequestContext } from "../matching/RequestMatcher"
import { NonEmptyString } from "../schemas/common"
import type { Stub } from "../schemas/StubSchema"
import { Uuid } from "./Uuid"

export class ProxyError extends Data.TaggedError("ProxyError")<{
  readonly targetUrl: string
  readonly reason: string
  readonly cause?: unknown
}> {}

const HOP_BY_HOP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers"
])

export interface ProxyServiceShape {
  readonly forward: (
    ctx: RequestContext,
    config: ProxyConfigDomain,
    originalUrl: URL
  ) => Effect.Effect<Response, ProxyError>
  readonly recordAsStub: (
    request: RequestContext,
    response: Response
  ) => Effect.Effect<Stub>
}

export class ProxyService extends Context.Tag("ProxyService")<ProxyService, ProxyServiceShape>() {}

export const ProxyServiceLive = Layer.effect(
  ProxyService,
  Effect.gen(function*() {
    const uuid = yield* Uuid

    const forward = (
      ctx: RequestContext,
      config: ProxyConfigDomain,
      originalUrl: URL
    ): Effect.Effect<Response, ProxyError> =>
      Effect.gen(function*() {
        // Build target URL preserving path and query
        const targetBase = config.targetUrl.replace(/\/$/, "")
        const targetUrl = `${targetBase}${originalUrl.pathname}${originalUrl.search}`

        // Build headers
        const headers = new Headers()
        for (const [key, val] of Object.entries(ctx.headers)) {
          if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
            headers.set(key, val)
          }
        }

        // Remove headers specified in config
        for (const h of config.removeHeaders) {
          headers.delete(h)
        }

        // Add headers specified in config
        if (config.addHeaders) {
          for (const [key, val] of Object.entries(config.addHeaders)) {
            headers.set(key, val)
          }
        }

        // Build body
        let body: string | undefined
        if (ctx.body !== undefined && ctx.body !== null) {
          body = typeof ctx.body === "string" ? ctx.body : JSON.stringify(ctx.body)
        }

        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetch(targetUrl, {
              method: ctx.method,
              headers,
              ...(body !== undefined && ctx.method !== "GET" && ctx.method !== "HEAD" ? { body } : {}),
              redirect: config.followRedirects ? "follow" : "manual",
              signal
            }),
          catch: (err) => new ProxyError({ targetUrl, reason: `Failed to reach target: ${err}`, cause: err })
        }).pipe(Effect.timeoutFail({
          duration: `${config.timeout} millis`,
          onTimeout: () => new ProxyError({ targetUrl, reason: `Request timed out after ${config.timeout}ms` })
        }))

        return response
      })

    const recordAsStub = (
      request: RequestContext,
      response: Response
    ): Effect.Effect<Stub> =>
      Effect.gen(function*() {
        const id = yield* uuid.generateShort

        const respHeaders: Record<string, string> = {}
        response.headers.forEach((val, key) => {
          respHeaders[key] = val
        })

        const respText = yield* Effect.promise(() => response.text())
        let respBody: unknown = respText
        const contentType = response.headers.get("content-type") ?? ""
        if (contentType.includes("application/json") && respText) {
          try {
            respBody = JSON.parse(respText)
          } catch {
            // keep as string
          }
        }

        return {
          id: NonEmptyString.make(id),
          predicates: [
            { field: "method" as const, operator: "equals" as const, value: request.method, caseSensitive: true },
            { field: "path" as const, operator: "equals" as const, value: request.path, caseSensitive: true }
          ],
          responses: [{
            status: response.status,
            headers: respHeaders,
            body: respBody
          }],
          responseMode: "sequential" as const
        }
      })

    return { forward, recordAsStub } satisfies ProxyServiceShape
  })
)
