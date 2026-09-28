import { Cause, Context, Data, Deferred, Effect, Exit, Fiber, HashMap, Layer, Option, Ref } from "effect"
import * as DateTime from "effect/DateTime"
import { ImposterConfig, type ImposterNotFoundError, type ProxyConfigDomain } from "../domain/imposter"
import { type ExtensionInstance, Extensions, findExtension } from "../extensions/Extension"
import { extractRequestContext, findMatchingStub, type RequestContext } from "../matching/RequestMatcher"
import { buildResponse, makeResponseState } from "../matching/ResponseGenerator"
import { ImposterRepository } from "../repositories/ImposterRepository"
import { HttpProtocol, NonEmptyString } from "../schemas/common"
import type { RequestLogEntry } from "../schemas/RequestLogSchema"
import type { Stub } from "../schemas/StubSchema"
import { MetricsService } from "../services/MetricsService"
import { ProxyService } from "../services/ProxyService"
import { RequestLogger } from "../services/RequestLogger"
import { makeUiRouter } from "../ui/UiRouter"
import { FiberManager } from "./FiberManager"
import { captureResponse } from "./ResponseCapture"
import { ServerFactory } from "./ServerFactory"

export class ImposterServerError extends Data.TaggedError("ImposterServerError")<{
  readonly imposterId: string
  readonly reason: string
}> {}

export interface ImposterServerShape {
  readonly start: (id: string) => Effect.Effect<void, ImposterServerError | ImposterNotFoundError>
  readonly stop: (id: string) => Effect.Effect<void>
  readonly updateStubs: (id: string) => Effect.Effect<void>
  readonly updateProxyConfig: (id: string) => Effect.Effect<void>
  readonly isRunning: (id: string) => Effect.Effect<boolean>
}

export class ImposterServer extends Context.Service<ImposterServer, ImposterServerShape>()("ImposterServer") {}

interface ImposterState {
  readonly stubsRef: Ref.Ref<ReadonlyArray<Stub>>
  readonly proxyConfigRef: Ref.Ref<ProxyConfigDomain | undefined>
}

// How a request was answered, for the request log
interface Outcome {
  readonly response: Response
  readonly matchedStubId?: string | undefined
  readonly proxied: boolean
}

// Why the server fiber ended before its port was bound: stopped, or died during bind
const earlyExitReason = (exit: Exit.Exit<never, unknown>): string =>
  Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
    ? `Imposter server died while binding its port: ${Cause.pretty(exit.cause)}`
    : "Imposter was stopped before its server started"

export const ImposterServerLive = Layer.effect(
  ImposterServer,
  Effect.gen(function*() {
    const repo = yield* ImposterRepository
    const fiberManager = yield* FiberManager
    const serverFactory = yield* ServerFactory
    const requestLogger = yield* RequestLogger
    const metricsService = yield* MetricsService
    const proxyService = yield* ProxyService
    const extensions = yield* Extensions
    const stateMapRef = yield* Ref.make<HashMap.HashMap<string, ImposterState>>(HashMap.empty())

    // The API rejects unknown protocols at create, so a miss here means the registration changed underneath
    const makeExtension = (id: string, config: ImposterConfig): Effect.Effect<ExtensionInstance, ImposterServerError> =>
      Option.match(findExtension(extensions, config.protocol), {
        onNone: () =>
          Effect.fail(
            new ImposterServerError({ imposterId: id, reason: `No extension provides protocol "${config.protocol}"` })
          ),
        onSome: (ext) => ext.make({ id, config })
      })

    const start = (id: string): Effect.Effect<void, ImposterServerError | ImposterNotFoundError> =>
      Effect.gen(function*() {
        const record = yield* repo.get(id)
        const config = record.config

        // A non-HTTP imposter gets a fresh extension instance on every start
        const extension = config.protocol === HttpProtocol ? undefined : yield* makeExtension(id, config)

        // Create per-imposter state
        const stubsRef = yield* Ref.make<ReadonlyArray<Stub>>(record.stubs)
        const proxyConfigRef = yield* Ref.make<ProxyConfigDomain | undefined>(config.proxy)
        const responseState = yield* makeResponseState()

        // Capture the current services for running effects inside the fetch handler
        const services = yield* Effect.context<never>()
        const runPromise = Effect.runPromiseWith(services)

        // UI router for /_admin pages
        const uiRouter = makeUiRouter({ id, config, stubsRef, repo, requestLogger, runPromise })

        const fromStub = (stub: Stub, ctx: RequestContext): Effect.Effect<Outcome> =>
          Effect.gen(function*() {
            const index = yield* responseState.getNextIndex(id, stub.id, stub.responses.length, stub.responseMode)
            const responseConfig = stub.responses[index] ?? stub.responses[0]
            const delay = responseConfig.delay
            if (delay !== undefined && delay > 0) {
              yield* Effect.sleep(`${delay} millis`)
            }
            const response = yield* Effect.promise(() => buildResponse(responseConfig, ctx))
            return { response, matchedStubId: stub.id, proxied: false }
          })

        // Record mode saves the proxied answer as a stub, so the next identical request is served locally
        const recordStub = (ctx: RequestContext, response: Response): Effect.Effect<void> =>
          Effect.gen(function*() {
            const newStub = yield* proxyService.recordAsStub(ctx, response.clone())
            yield* repo.addStub(id, newStub).pipe(Effect.catch(() => Effect.void))
            const freshStubs = yield* repo.getStubs(id).pipe(
              Effect.catch(() => Effect.succeed<ReadonlyArray<Stub>>([]))
            )
            yield* Ref.set(stubsRef, freshStubs)
          })

        const fromProxy = (proxyConfig: ProxyConfigDomain, ctx: RequestContext, url: URL): Effect.Effect<Outcome> =>
          proxyService.forward(ctx, proxyConfig, url).pipe(
            Effect.catchTag("ProxyError", (err) =>
              Effect.succeed(
                new Response(
                  JSON.stringify({ error: "Proxy failed", target: err.targetUrl, reason: err.reason }),
                  { status: 502, headers: { "content-type": "application/json" } }
                )
              )),
            Effect.tap((response) =>
              proxyConfig.mode === "record" && response.status < 500 ? recordStub(ctx, response) : Effect.void
            ),
            Effect.map((response) => ({ response, proxied: true }))
          )

        const fromExtension = (ext: ExtensionInstance, ctx: RequestContext): Effect.Effect<Outcome> =>
          ext.handle(ctx).pipe(Effect.map((response) => ({ response, proxied: false })))

        const notFound = (ctx: RequestContext): Outcome => ({
          response: new Response(
            JSON.stringify({ error: "No matching stub found", method: ctx.method, path: ctx.path }),
            { status: 404, headers: { "content-type": "application/json" } }
          ),
          proxied: false
        })

        const handler = async (request: Request): Promise<Response> => {
          // Try UI router first (returns null if not a /_admin path)
          const uiResponse = await uiRouter(request)
          if (uiResponse !== null) return uiResponse

          return runPromise(
            Effect.gen(function*() {
              const startTime = Date.now()
              const stubs = yield* Ref.get(stubsRef)
              const proxyConfig = yield* Ref.get(proxyConfigRef)
              const ctx = yield* Effect.promise(() => extractRequestContext(request))
              const stub = findMatchingStub(ctx, stubs)

              // Stubs first, then the extension (terminal), then the proxy, then 404
              const outcome = yield* stub !== undefined
                ? fromStub(stub, ctx)
                : extension !== undefined
                ? fromExtension(extension, ctx)
                : proxyConfig !== undefined
                ? fromProxy(proxyConfig, ctx, new URL(request.url))
                : Effect.succeed(notFound(ctx))

              // Capture response for logging; the body is read once, so send the captured copy
              const captured = yield* Effect.promise(() => captureResponse(outcome.response))
              const response = captured.response
              const logBody = captured.logBody

              const duration = Date.now() - startTime
              const logEntry: RequestLogEntry = {
                id: NonEmptyString.make(crypto.randomUUID()),
                imposterId: NonEmptyString.make(id),
                timestamp: DateTime.makeUnsafe(startTime),
                request: {
                  method: ctx.method,
                  path: ctx.path,
                  headers: ctx.headers,
                  query: ctx.query,
                  body: ctx.body
                },
                response: {
                  status: response.status,
                  headers: captured.headers,
                  ...(logBody !== undefined ? { body: logBody } : {}),
                  ...(outcome.matchedStubId !== undefined
                    ? { matchedStubId: NonEmptyString.make(outcome.matchedStubId) }
                    : {}),
                  proxied: outcome.proxied
                },
                duration
              }
              yield* requestLogger.log(logEntry).pipe(Effect.catch(() => Effect.void))
              yield* metricsService.recordRequest(logEntry).pipe(Effect.catch(() => Effect.void))

              return response
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.succeed(
                  new Response(
                    JSON.stringify({ error: "Internal server error", details: String(cause) }),
                    { status: 500, headers: { "content-type": "application/json" } }
                  )
                )
              )
            )
          )
        }

        // Completed by the server fiber: succeeds once the port is bound, fails if
        // binding fails or the fiber is interrupted before it gets that far.
        const ready = yield* Deferred.make<void, ImposterServerError>()

        const acquireServer = serverFactory.create({ port: config.port, fetch: handler }).pipe(
          Effect.mapError((err) =>
            new ImposterServerError({ imposterId: id, reason: `Failed to bind port ${err.port}: ${err.reason}` })
          ),
          // Register hot-reload state only once bound; the onError below removes it.
          // Doing it inside the fiber keeps it ordered after any previous fiber's
          // cleanup (FiberManager.start awaits that before forking this one).
          Effect.tap(() => Ref.update(stateMapRef, HashMap.set(id, { stubsRef, proxyConfigRef }))),
          // Stub/proxy changes made between the repo.get above and registration found
          // no state to update; re-read now so the new server does not serve stale stubs.
          Effect.tap(() =>
            repo.get(id).pipe(
              Effect.andThen((latest) =>
                Effect.all([Ref.set(stubsRef, latest.stubs), Ref.set(proxyConfigRef, latest.config.proxy)])
              ),
              Effect.catch(() => Effect.void)
            )
          ),
          Effect.tap(() => Deferred.succeed(ready, undefined))
        )

        // The release is the server's stop Effect, so interrupting this fiber
        // completes only after the port has been released.
        const fiberEffect = Effect.acquireRelease(acquireServer, (server) => server.stop(true)).pipe(
          Effect.andThen(Effect.never),
          Effect.scoped
        )

        const supervisedEffect = fiberEffect.pipe(
          // Crash supervision: runs for bind failures, crashes after start, and stop()
          Effect.onError(() =>
            Effect.gen(function*() {
              yield* Ref.update(stateMapRef, HashMap.remove(id))
              yield* repo.update(id, (r) => ({
                ...r,
                config: ImposterConfig({ ...r.config, status: "stopped" })
              })).pipe(Effect.catch(() => Effect.void))
              yield* responseState.reset(id)
            })
          ),
          // Deferred.fail is a no-op once `ready` has succeeded
          Effect.tapError((err) => Deferred.fail(ready, err))
        )

        const fiber = yield* fiberManager.start(id, supervisedEffect)

        // Resolve only once the port is bound. The fiber can also exit without ever
        // completing `ready` — interrupted before it first ran (so no finalizer of
        // its own was registered) or a defect — so race against its exit too.
        // On failure, wait for the fiber to exit so its cleanup has run and
        // FiberMap has dropped the entry before the caller sees the error.
        yield* Effect.raceFirst(
          Deferred.await(ready),
          Fiber.await(fiber).pipe(
            Effect.andThen((exit) =>
              Deferred.fail(ready, new ImposterServerError({ imposterId: id, reason: earlyExitReason(exit) }))
            ),
            Effect.andThen(Deferred.await(ready))
          )
        ).pipe(Effect.tapError(() => Fiber.await(fiber)))

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
        })).pipe(Effect.catch(() => Effect.void))
        yield* requestLogger.removeImposter(id)
      })

    const updateStubs = (id: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        const stubs = yield* repo.getStubs(id).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<Stub>)))
        const stateMap = yield* Ref.get(stateMapRef)
        const state = HashMap.get(stateMap, id)
        if (state._tag === "Some") {
          yield* Ref.set(state.value.stubsRef, stubs)
        }
      })

    const updateProxyConfig = (id: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        const record = yield* repo.get(id).pipe(Effect.catch(() => Effect.succeed(null)))
        if (record === null) return
        const stateMap = yield* Ref.get(stateMapRef)
        const state = HashMap.get(stateMap, id)
        if (state._tag === "Some") {
          yield* Ref.set(state.value.proxyConfigRef, record.config.proxy)
        }
      })

    const isRunning = (id: string): Effect.Effect<boolean> => fiberManager.isRunning(id)

    return { start, stop, updateStubs, updateProxyConfig, isRunning } satisfies ImposterServerShape
  })
)
