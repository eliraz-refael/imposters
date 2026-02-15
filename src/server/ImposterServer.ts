import { Context, Data, Effect, HashMap, Layer, Ref, Runtime } from "effect"
import * as DateTime from "effect/DateTime"
import { ImposterConfig, ImposterNotFoundError } from "../domain/imposter.js"
import { extractRequestContext, findMatchingStub } from "../matching/RequestMatcher.js"
import { buildResponse, makeResponseState } from "../matching/ResponseGenerator.js"
import { ImposterRepository } from "../repositories/ImposterRepository.js"
import { NonEmptyString } from "../schemas/common.js"
import type { RequestLogEntry } from "../schemas/RequestLogSchema.js"
import type { Stub } from "../schemas/StubSchema.js"
import { RequestLogger } from "../services/RequestLogger.js"
import { makeUiRouter } from "../ui/UiRouter.js"
import { ServerFactory } from "./BunServer.js"
import { FiberManager } from "./FiberManager.js"

export class ImposterServerError extends Data.TaggedError("ImposterServerError")<{
  readonly imposterId: string
  readonly reason: string
}> {}

export interface ImposterServerShape {
  readonly start: (id: string) => Effect.Effect<void, ImposterServerError | ImposterNotFoundError>
  readonly stop: (id: string) => Effect.Effect<void>
  readonly updateStubs: (id: string) => Effect.Effect<void>
  readonly isRunning: (id: string) => Effect.Effect<boolean>
}

export class ImposterServer extends Context.Tag("ImposterServer")<ImposterServer, ImposterServerShape>() {}

interface ImposterState {
  readonly stubsRef: Ref.Ref<ReadonlyArray<Stub>>
}

export const ImposterServerLive = Layer.effect(
  ImposterServer,
  Effect.gen(function*() {
    const repo = yield* ImposterRepository
    const fiberManager = yield* FiberManager
    const serverFactory = yield* ServerFactory
    const requestLogger = yield* RequestLogger
    const stateMapRef = yield* Ref.make<HashMap.HashMap<string, ImposterState>>(HashMap.empty())

    const start = (id: string): Effect.Effect<void, ImposterServerError | ImposterNotFoundError> =>
      Effect.gen(function*() {
        const record = yield* repo.get(id)
        const config = record.config

        // Create per-imposter state
        const stubsRef = yield* Ref.make<ReadonlyArray<Stub>>(record.stubs)
        const responseState = yield* makeResponseState()

        // Store state for hot-reload
        yield* Ref.update(stateMapRef, HashMap.set(id, { stubsRef } as ImposterState))

        // Capture runtime for running effects inside fetch handler
        const rt = yield* Effect.runtime<never>()
        const runPromise = Runtime.runPromise(rt)

        // UI router for /_admin pages
        const uiRouter = makeUiRouter({ id, config, stubsRef, repo, requestLogger, runPromise })

        const handler = async (request: Request): Promise<Response> => {
          // Try UI router first (returns null if not a /_admin path)
          const uiResponse = await uiRouter(request)
          if (uiResponse !== null) return uiResponse

          return runPromise(
            Effect.gen(function*() {
              const startTime = Date.now()
              const stubs = yield* Ref.get(stubsRef)
              const ctx = yield* Effect.promise(() => extractRequestContext(request))
              const stub = findMatchingStub(ctx, stubs)

              let response: Response
              if (!stub) {
                response = new Response(
                  JSON.stringify({ error: "No matching stub found", method: ctx.method, path: ctx.path }),
                  { status: 404, headers: { "content-type": "application/json" } }
                )
              } else {
                const responses = stub.responses
                const index = yield* responseState.getNextIndex(id, stub.id, responses.length, stub.responseMode)
                const responseConfig = responses[index]!
                const delay = responseConfig.delay
                if (delay !== undefined && delay > 0) {
                  yield* Effect.sleep(`${delay} millis`)
                }
                response = buildResponse(responseConfig, ctx)
              }

              // Capture response for logging
              const respText = yield* Effect.promise(() => response.text())
              const respHeaders: Record<string, string> = {}
              response.headers.forEach((val, key) => { respHeaders[key] = val })
              // Reconstruct since .text() consumed body
              response = new Response(respText, { status: response.status, headers: response.headers })

              const logBody = respText.length > 10240 ? respText.slice(0, 10240) : (respText || undefined)

              const duration = Date.now() - startTime
              const logEntry: RequestLogEntry = {
                id: NonEmptyString.make(crypto.randomUUID()),
                imposterId: NonEmptyString.make(id),
                timestamp: DateTime.unsafeMake(startTime),
                request: {
                  method: ctx.method,
                  path: ctx.path,
                  headers: ctx.headers,
                  query: ctx.query,
                  body: ctx.body
                },
                response: {
                  status: response.status,
                  headers: respHeaders,
                  ...(logBody !== undefined ? { body: logBody } : {}),
                  ...(stub ? { matchedStubId: NonEmptyString.make(stub.id) } : {})
                },
                duration
              }
              yield* requestLogger.log(logEntry).pipe(Effect.catchAll(() => Effect.void))

              return response
            }).pipe(
              Effect.catchAllCause((cause) =>
                Effect.succeed(new Response(
                  JSON.stringify({ error: "Internal server error", details: String(cause) }),
                  { status: 500, headers: { "content-type": "application/json" } }
                ))
              )
            )
          )
        }

        // Build the long-running fiber effect with acquireRelease
        const fiberEffect = Effect.acquireRelease(
          Effect.try({
            try: () => serverFactory.create({ port: config.port, fetch: handler }),
            catch: (err) => new ImposterServerError({ imposterId: id, reason: `Failed to bind port ${config.port}: ${err}` })
          }),
          (server) => Effect.sync(() => server.stop(true))
        ).pipe(
          Effect.andThen(Effect.never),
          Effect.scoped
        )

        // Wrap fiber in onError for crash supervision
        const supervisedEffect = fiberEffect.pipe(
          Effect.onError(() =>
            Effect.gen(function*() {
              yield* Ref.update(stateMapRef, HashMap.remove(id))
              yield* repo.update(id, (r) => ({
                ...r,
                config: ImposterConfig({ ...r.config, status: "stopped" })
              })).pipe(Effect.catchAll(() => Effect.void))
              yield* responseState.reset(id)
            })
          )
        ) as Effect.Effect<never, unknown>

        yield* fiberManager.start(id, supervisedEffect)

        // Update status to running
        yield* repo.update(id, (r) => ({
          ...r,
          config: ImposterConfig({ ...r.config, status: "running" })
        })).pipe(Effect.catchTag("ImposterNotFoundError", () => Effect.void))
      })

    const stop = (id: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        yield* fiberManager.stop(id)
        yield* Ref.update(stateMapRef, HashMap.remove(id))
        yield* repo.update(id, (r) => ({
          ...r,
          config: ImposterConfig({ ...r.config, status: "stopped" })
        })).pipe(Effect.catchAll(() => Effect.void))
        yield* requestLogger.removeImposter(id)
      })

    const updateStubs = (id: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        const stubs = yield* repo.getStubs(id).pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<Stub>)))
        const stateMap = yield* Ref.get(stateMapRef)
        const state = HashMap.get(stateMap, id)
        if (state._tag === "Some") {
          yield* Ref.set(state.value.stubsRef, stubs)
        }
      })

    const isRunning = (id: string): Effect.Effect<boolean> =>
      fiberManager.isRunning(id)

    return { start, stop, updateStubs, isRunning } satisfies ImposterServerShape
  })
)
