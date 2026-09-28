import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import type { NonEmptyString, PortNumber } from "../schemas/common"
import type { CreateStubRequest } from "../schemas/StubSchema"
import { HandlerHttpClientLive } from "./HandlerHttpClient"
import { ImpostersClient, ImpostersClientLive } from "./ImpostersClient"

export interface StubConfig {
  readonly predicates?: ReadonlyArray<{
    readonly field: "method" | "path" | "headers" | "query" | "body"
    readonly operator: "equals" | "contains" | "startsWith" | "matches" | "exists"
    readonly value: unknown
    readonly caseSensitive?: boolean
  }>
  readonly responses: readonly [ResponseConfigInput, ...ReadonlyArray<ResponseConfigInput>]
  readonly responseMode?: "sequential" | "random" | "repeat"
}

interface ResponseConfigInput {
  readonly status?: number
  readonly headers?: Record<string, string>
  readonly body?: unknown
  readonly delay?: number
}

export interface WithImposterConfig {
  readonly port?: number
  readonly name?: string
  readonly stubs?: ReadonlyArray<StubConfig>
}

export interface ImposterTestContext {
  readonly id: string
  readonly port: number
}

const asPort = (n: number) => n as PortNumber
const asNes = (s: string) => s as NonEmptyString

const toStubPayload = (stub: StubConfig): CreateStubRequest => ({
  predicates: (stub.predicates ?? []).map((p) => ({
    field: p.field,
    operator: p.operator,
    value: p.value,
    caseSensitive: p.caseSensitive ?? true
  })),
  responses: stub.responses.map((r) => ({
    status: r.status ?? 200,
    ...(r.headers !== undefined ? { headers: r.headers } : {}),
    ...(r.body !== undefined ? { body: r.body } : {}),
    ...(r.delay !== undefined ? { delay: r.delay } : {})
  })) as unknown as CreateStubRequest["responses"],
  responseMode: stub.responseMode ?? "sequential"
})

export const withImposter = <A, E>(
  config: WithImposterConfig,
  testFn: (ctx: ImposterTestContext) => Effect.Effect<A, E, ImpostersClient>
): Effect.Effect<A, E | Error, ImpostersClient> =>
  Effect.acquireUseRelease(
    Effect.gen(function*() {
      const client = yield* ImpostersClient
      const imp = yield* client.imposters.createImposter({
        payload: {
          ...(config.port !== undefined ? { port: asPort(config.port) } : {}),
          ...(config.name !== undefined ? { name: asNes(config.name) } : {}),
          protocol: "HTTP" as const,
          adminPath: "/_admin"
        }
      })

      for (const stub of config.stubs ?? []) {
        yield* client.imposters.addStub({
          params: { imposterId: imp.id },
          payload: toStubPayload(stub)
        })
      }

      yield* client.imposters.updateImposter({
        params: { id: imp.id },
        payload: { status: "running" }
      })

      yield* Effect.sleep("150 millis")

      return { id: imp.id as string, port: imp.port as number }
    }),
    (ctx) => testFn(ctx),
    (ctx) =>
      Effect.gen(function*() {
        const client = yield* ImpostersClient
        yield* client.imposters.deleteImposter({
          params: { id: ctx.id },
          query: { force: true }
        }).pipe(Effect.catch(() => Effect.void))
      }).pipe(Effect.catch(() => Effect.void))
  )

export const makeTestServer = <E>(fullLayer: Layer.Layer<never, E, HttpRouter.HttpRouter>) => {
  const { dispose, handler } = HttpRouter.toWebHandler(fullLayer, { disableLogger: true })
  const clientLayer = ImpostersClientLive().pipe(
    Layer.provide(HandlerHttpClientLive(handler))
  )
  return { handler, dispose, clientLayer }
}
