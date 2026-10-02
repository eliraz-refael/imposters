import {
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  HashMap,
  Layer,
  Option,
  Ref,
  Semaphore
} from "effect"
import * as DateTime from "effect/DateTime"
import { ImposterConfig, type ImposterNotFoundError, type ProxyConfigDomain } from "../domain/imposter.js"
import { type ExtensionInstance, Extensions, findExtension } from "../extensions/Extension.js"
import { extractRequestContext, findMatchingStub, type RequestContext } from "../matching/RequestMatcher.js"
import { buildResponse, makeResponseState, peekIndex, type ResponseState } from "../matching/ResponseGenerator.js"
import { ImposterRepository, type StubNotFoundError } from "../repositories/ImposterRepository.js"
import { HttpProtocol, NonEmptyString } from "../schemas/common.js"
import type { RequestLogEntry, RequestOutcome } from "../schemas/RequestLogSchema.js"
import type { Stub } from "../schemas/StubSchema.js"
import { MetricsService } from "../services/MetricsService.js"
import { ProxyService } from "../services/ProxyService.js"
import { RequestLogger } from "../services/RequestLogger.js"
import { makeUiRouter } from "../ui/UiRouter.js"
import { FiberManager } from "./FiberManager.js"
import { captureResponse } from "./ResponseCapture.js"
import { ServerFactory } from "./ServerFactory.js"
import { answersChanged, applyStubPatch, StubChange } from "./StubChange.js"

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
  /**
   * Adds, edits or removes a stub: writes the repository, hot-reloads a running imposter, and
   * resets what the change invalidates. Removing a stub, or an edit that changes its responses or
   * responseMode, resets that stub's hit counters and response cycle; a predicate-only edit keeps both.
   */
  readonly applyStubChange: (
    id: string,
    change: StubChange
  ) => Effect.Effect<Stub, ImposterNotFoundError | StubNotFoundError>
  /** The index of the response the stub gives next; None for random mode or an unknown stub */
  readonly nextResponseIndex: (id: string, stubId: string) => Effect.Effect<Option.Option<number>>
  /** Restarts the stub's response cycle at its first response (a no-op unless running) */
  readonly resetStub: (id: string, stubId: string) => Effect.Effect<void>
}

export class ImposterServer extends Context.Service<ImposterServer, ImposterServerShape>()("ImposterServer") {}

interface ImposterState {
  readonly stubsRef: Ref.Ref<ReadonlyArray<Stub>>
  readonly proxyConfigRef: Ref.Ref<ProxyConfigDomain | undefined>
  readonly responseState: ResponseState
}

// How a request was answered, for the request log
interface Outcome {
  readonly response: Response
  readonly kind: RequestOutcome
  readonly matchedStubId?: string
  readonly responseIndex?: number
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
    // Serialises every write of a running imposter's stubsRef with the repository write it mirrors.
    // Without it two concurrent changes can reload out of order (each reads the repository, then
    // sets the Ref), leaving the server on an older stub list than the repository holds.
    const stubsLock = yield* Semaphore.make(1)

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
        const uiRouter = makeUiRouter({
          id,
          config,
          stubsRef,
          repo,
          applyStubChange: (change) => applyStubChange(id, change),
          requestLogger,
          runPromise,
          // handler is declared below; it is only called once a request arrives
          fetchSelf: (request) => handler(request)
        })

        const fromStub = (stub: Stub, ctx: RequestContext): Effect.Effect<Outcome> =>
          Effect.gen(function*() {
            const next = yield* responseState.getNextIndex(id, stub.id, stub.responses.length, stub.responseMode)
            const responseIndex = next < stub.responses.length ? next : 0
            const responseConfig = stub.responses[responseIndex] ?? stub.responses[0]
            const delay = responseConfig.delay
            if (delay !== undefined && delay > 0) {
              yield* Effect.sleep(`${delay} millis`)
            }
            const response = yield* Effect.promise(() => buildResponse(responseConfig, ctx))
            return { response, kind: "stub", matchedStubId: stub.id, responseIndex }
          })

        // Record mode saves the proxied answer as a stub, so the next identical request is served locally
        const recordStub = (ctx: RequestContext, response: Response): Effect.Effect<void> =>
          Effect.gen(function*() {
            const newStub = yield* proxyService.recordAsStub(ctx, response.clone())
            yield* applyStubChange(id, StubChange.Add({ stub: newStub })).pipe(Effect.catch(() => Effect.void))
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
            Effect.map((response): Outcome => ({ response, kind: "proxy" }))
          )

        const fromExtension = (ext: ExtensionInstance, ctx: RequestContext): Effect.Effect<Outcome> =>
          ext.handle(ctx).pipe(Effect.map((response): Outcome => ({ response, kind: "extension" })))

        const notFound = (ctx: RequestContext): Outcome => ({
          response: new Response(
            JSON.stringify({ error: "No matching stub found", method: ctx.method, path: ctx.path }),
            { status: 404, headers: { "content-type": "application/json" } }
          ),
          kind: "unmatched"
        })

        const handler = async (request: Request): Promise<Response> => {
          // Try UI router first (returns null if not a /_admin path)
          const uiResponse = await uiRouter(request)
          if (uiResponse !== null) return uiResponse

          return runPromise(
            Effect.gen(function*() {
              const startTime = yield* Clock.currentTimeMillis
              const ctx = yield* Effect.promise(() => extractRequestContext(request))
              // Read after the body: a stub change made during a slow upload must not be answered with the old stubs
              const stubs = yield* Ref.get(stubsRef)
              const proxyConfig = yield* Ref.get(proxyConfigRef)
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

              const duration = (yield* Clock.currentTimeMillis) - startTime
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
                  proxied: outcome.kind === "proxy",
                  outcome: outcome.kind,
                  ...(outcome.responseIndex !== undefined
                    ? { responseIndex: outcome.responseIndex }
                    : {})
                },
                duration
              }
              // Only this run counts: a request still in flight from a stopped run (or one that
              // finished after a restart) would otherwise land in the new run's log and stats.
              // Checked again before the stats, since the log also publishes to subscribers.
              const isCurrentRun = Ref.get(stateMapRef).pipe(
                Effect.map((map) => Option.exists(HashMap.get(map, id), (state) => state.stubsRef === stubsRef))
              )
              if (yield* isCurrentRun) {
                yield* requestLogger.log(logEntry).pipe(Effect.catch(() => Effect.void))
              }
              if (yield* isCurrentRun) {
                // A stub removed, or whose answers changed, while this request was in flight has had
                // its counters restarted; this hit belongs to the old version, so it is not attributed
                const current = (yield* Ref.get(stubsRef)).find((s) => s.id === stub?.id)
                const stale = stub !== undefined && (current === undefined || answersChanged(stub, current))
                const { matchedStubId: _matched, responseIndex: _index, ...unattributed } = logEntry.response
                const metricsEntry: RequestLogEntry = stale ? { ...logEntry, response: unattributed } : logEntry
                yield* metricsService.recordRequest(metricsEntry).pipe(Effect.catch(() => Effect.void))
              }

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
          // Stats count from this start (the previous run's are dropped once the port is ours).
          // Reset before registering: a request recorded in between would be wiped from the
          // stats while staying in the request log.
          Effect.tap(() => metricsService.resetStats(id)),
          Effect.tap(() => Ref.update(stateMapRef, HashMap.set(id, { stubsRef, proxyConfigRef, responseState }))),
          // Stub/proxy changes made between the repo.get above and registration found
          // no state to update; re-read now so the new server does not serve stale stubs.
          Effect.tap(() =>
            repo.get(id).pipe(
              Effect.andThen((latest) =>
                Effect.all([Ref.set(stubsRef, latest.stubs), Ref.set(proxyConfigRef, latest.config.proxy)])
              ),
              Effect.catch(() => Effect.void),
              stubsLock.withPermit
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
              // Only this run's state: never one a later start registered under the same id
              yield* Ref.update(
                stateMapRef,
                (map) =>
                  Option.exists(HashMap.get(map, id), (state) => state.stubsRef === stubsRef)
                    ? HashMap.remove(map, id)
                    : map
              )
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
        // The fiber's onError drops its hot-reload state; removing it here as well would race a
        // concurrent start and drop the new run's state, losing its hot-reload and its stats
        yield* fiberManager.stop(id)
        yield* repo.update(id, (r) => ({
          ...r,
          config: ImposterConfig({ ...r.config, status: "stopped" })
        })).pipe(Effect.catch(() => Effect.void))
        yield* requestLogger.removeImposter(id)
      })

    // Callers hold stubsLock
    const reloadStubs = (id: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        const stubs = yield* repo.getStubs(id).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<Stub>)))
        const stateMap = yield* Ref.get(stateMapRef)
        const state = HashMap.get(stateMap, id)
        if (state._tag === "Some") {
          yield* Ref.set(state.value.stubsRef, stubs)
        }
      })

    const updateStubs = (id: string): Effect.Effect<void> => stubsLock.withPermit(reloadStubs(id))

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

    const runningState = (id: string): Effect.Effect<Option.Option<ImposterState>> =>
      Ref.get(stateMapRef).pipe(Effect.map(HashMap.get(id)))

    const resetStub = (id: string, stubId: string): Effect.Effect<void> =>
      runningState(id).pipe(
        Effect.andThen(Option.match({
          onNone: () => Effect.void,
          onSome: (state) => state.responseState.resetStub(id, stubId)
        }))
      )

    // A stopped imposter starts every cycle over, so its next answer is the first one's
    const nextResponseIndex = (id: string, stubId: string): Effect.Effect<Option.Option<number>> =>
      Effect.gen(function*() {
        const state = yield* runningState(id)
        const stubs = yield* Option.match(state, {
          onNone: () => repo.getStubs(id).pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<Stub>>([]))),
          onSome: (s) => Ref.get(s.stubsRef)
        })
        const stub = stubs.find((s) => s.id === stubId)
        if (stub === undefined) return Option.none()
        return yield* Option.match(state, {
          onNone: () => Effect.succeed(peekIndex(0, stub.responses.length, stub.responseMode)),
          onSome: (s) => s.responseState.peekNextIndex(id, stub.id, stub.responses.length, stub.responseMode)
        })
      })

    // What a stub's counters and cycle no longer describe once it is gone or answers differently
    const forgetStub = (id: string, stubId: string): Effect.Effect<void> =>
      Effect.andThen(metricsService.resetStub(id, stubId), resetStub(id, stubId))

    const applyStubChange = (
      id: string,
      change: StubChange
    ): Effect.Effect<Stub, ImposterNotFoundError | StubNotFoundError> =>
      // Locked, so changes reload in the order they were written; uninterruptible, so a caller
      // that goes away after the write cannot leave the server or the counters behind the repository
      Effect.gen(function*() {
        // Whether the change invalidates the stub's counters and cycle
        const { forget, stub } = yield* StubChange.$match(change, {
          Add: ({ stub }) => repo.addStub(id, stub).pipe(Effect.map((added) => ({ stub: added, forget: false }))),
          Remove: ({ stubId }) =>
            repo.removeStub(id, stubId).pipe(Effect.map((removed) => ({ stub: removed, forget: true }))),
          Update: ({ patch, stubId }) => {
            // Captured inside the repository's atomic update, so a concurrent edit cannot skew the comparison
            let before: Stub | undefined
            return repo.updateStub(id, stubId, (s) => {
              before = s
              return applyStubPatch(s, patch)
            }).pipe(
              Effect.map((after) => ({ stub: after, forget: before === undefined || answersChanged(before, after) }))
            )
          }
        })
        // Hot-reload first: a request that still matched the old stub between a reset and the
        // reload would otherwise advance the new stub's cycle and count against it
        yield* reloadStubs(id)
        if (forget) yield* forgetStub(id, stub.id)
        return stub
      }).pipe(Effect.uninterruptible, stubsLock.withPermit)

    return {
      start,
      stop,
      updateStubs,
      updateProxyConfig,
      isRunning,
      applyStubChange,
      nextResponseIndex,
      resetStub
    } satisfies ImposterServerShape
  })
)
