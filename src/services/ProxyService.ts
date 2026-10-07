import { Context, Data, Effect, Layer } from "effect"
import * as Result from "effect/Result"
import type { ProxyConfigDomain } from "../domain/imposter.js"
import { HOP_HEADER, nextHop, parseHop } from "../matching/Hops.js"
import type { RequestContext } from "../matching/RequestMatcher.js"
import { NonEmptyString } from "../schemas/common.js"
import type { Stub } from "../schemas/StubSchema.js"
import { callOut, type HopLimitError, OutboundHttp } from "./OutboundHttp.js"
import { Uuid } from "./Uuid.js"

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
  // Forwards the request to the target, sending the incoming hop plus one. A request that
  // arrived at the hop limit is refused with HopLimitError (the imposter answers 508).
  // The call counts into `imposterId`'s outbound edges.
  readonly forward: (
    ctx: RequestContext,
    config: ProxyConfigDomain,
    originalUrl: URL,
    imposterId: string
  ) => Effect.Effect<Response, ProxyError | HopLimitError>
  readonly recordAsStub: (
    request: RequestContext,
    response: Response
  ) => Effect.Effect<Stub>
}

export class ProxyService extends Context.Service<ProxyService, ProxyServiceShape>()("ProxyService") {}

export const ProxyServiceLive = Layer.effect(
  ProxyService,
  Effect.gen(function*() {
    const uuid = yield* Uuid
    const outbound = yield* OutboundHttp

    const forward = (
      ctx: RequestContext,
      config: ProxyConfigDomain,
      originalUrl: URL,
      imposterId: string
    ): Effect.Effect<Response, ProxyError | HopLimitError> =>
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

        // Forward the exact request bytes, so binary uploads survive and content-length still matches
        const body = ctx.rawBody.length > 0 ? ctx.rawBody : undefined

        if (!URL.canParse(targetUrl)) {
          return yield* Effect.fail(new ProxyError({ targetUrl, reason: `Invalid target url: ${targetUrl}` }))
        }
        return yield* callOut({
          imposterId,
          via: "proxy",
          request: {
            url: new URL(targetUrl),
            method: ctx.method,
            headers,
            ...(body !== undefined && ctx.method !== "GET" && ctx.method !== "HEAD" ? { body } : {}),
            // The client's hop is not forwarded as is: callOut sends this one, a hop further
            hop: nextHop(parseHop(ctx.headers[HOP_HEADER])),
            redirect: config.followRedirects ? "follow" : "manual"
          },
          timeoutMs: config.timeout,
          // The body streams to the client afterwards: the timeout covers the headers only
          read: (response) => Promise.resolve(Result.succeed(response)),
          statusOf: (response) => response.status
        }).pipe(
          Effect.catchTag("OutboundError", (err) =>
            Effect.fail(
              err.kind === "timeout"
                ? new ProxyError({ targetUrl, reason: `Request timed out after ${config.timeout}ms` })
                : new ProxyError({
                  targetUrl,
                  reason: `Failed to reach target: ${String(err.cause)}`,
                  cause: err.cause
                })
            )),
          Effect.provideService(OutboundHttp, outbound)
        )
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
