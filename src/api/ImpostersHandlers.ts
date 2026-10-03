import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ImposterConfig, type ProxyConfigDomain } from "../domain/imposter.js"
import { Extensions, findExtension, supportedProtocols } from "../extensions/Extension.js"
import { contextFromCaptured, explainStubs } from "../matching/Explain.js"
import { previewStub } from "../matching/Preview.js"
import {
  type ImposterRecord,
  ImposterRepository,
  type StubIndexOutOfRangeError
} from "../repositories/ImposterRepository.js"
import { HttpProtocol, NonEmptyString } from "../schemas/common.js"
import type { ExplainResponse } from "../schemas/ExplainSchema.js"
import type { Statistics } from "../schemas/ImposterSchema.js"
import type { Stub } from "../schemas/StubSchema.js"
import { ImposterServer } from "../server/ImposterServer.js"
import { StubChange } from "../server/StubChange.js"
import { AppConfig } from "../services/AppConfig.js"
import { MetricsService } from "../services/MetricsService.js"
import { PortAllocator } from "../services/PortAllocator.js"
import { RequestLogger } from "../services/RequestLogger.js"
import { Uuid } from "../services/Uuid.js"
import { AdminApi } from "./AdminApi.js"
import { ApiBadRequestError, ApiConflictError, ApiNotFoundError, ApiServiceError } from "./ApiErrors.js"
import { buildPaginationMeta, toImposterResponse, toStatistics } from "./Conversions.js"

// Extensions are terminal (they answer every unmatched request), so a proxy on one would never run
const proxyOnExtensionError = (protocol: string) =>
  new ApiBadRequestError({
    message:
      `Proxy is only supported on ${HttpProtocol} imposters; a ${protocol} imposter answers unmatched requests itself`
  })

export const ImpostersHandlersLive = HttpApiBuilder.group(AdminApi, "imposters", (handlers) =>
  Effect.gen(function*() {
    // Resolve services once at layer build time. In v4, a service yielded
    // inside a handler becomes a per-request requirement instead.
    const repo = yield* ImposterRepository
    const imposterServer = yield* ImposterServer
    const allocator = yield* PortAllocator
    const config = yield* AppConfig
    const uuid = yield* Uuid
    const metricsService = yield* MetricsService
    const requestLogger = yield* RequestLogger
    const extensions = yield* Extensions

    const checkProtocol = (protocol: string): Effect.Effect<void, ApiBadRequestError> =>
      protocol === HttpProtocol || Option.isSome(findExtension(extensions, protocol))
        ? Effect.void
        : Effect.fail(
          new ApiBadRequestError({
            message: `Unknown protocol "${protocol}". Available: ${supportedProtocols(extensions).join(", ")}`
          })
        )

    const statisticsFor = (id: string, stubs: ReadonlyArray<Stub>): Effect.Effect<Statistics> =>
      Effect.gen(function*() {
        const snapshot = yield* metricsService.getStats(id)
        const next = new Map<string, number>()
        for (const stub of stubs) {
          const index = yield* imposterServer.nextResponseIndex(id, stub.id)
          if (Option.isSome(index)) next.set(stub.id, index.value)
        }
        return toStatistics(snapshot, stubs, next)
      })

    const withStatistics = (record: ImposterRecord) =>
      Effect.all({ response: toImposterResponse(record), statistics: statisticsFor(record.config.id, record.stubs) })
        .pipe(Effect.map(({ response, statistics }) => ({ ...response, statistics })))

    const imposterNotFound = (e: { readonly id: string }) =>
      new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
    const stubNotFound = (e: { readonly stubId: string }) =>
      new ApiNotFoundError({ message: "Stub not found", resourceType: "stub", resourceId: e.stubId })
    // Only an add has a position, so an edit or a removal cannot fail with one
    const insertOnly = (e: StubIndexOutOfRangeError) => Effect.die(e)

    return handlers
      .handle("createImposter", ({ payload }) =>
        Effect.gen(function*() {
          const all = yield* repo.getAll
          if (all.length >= config.maxImposters) {
            return yield* Effect.fail(
              new ApiServiceError({ message: `Maximum number of imposters (${config.maxImposters}) reached` })
            )
          }

          yield* checkProtocol(payload.protocol)
          if (payload.proxy !== undefined && payload.protocol !== HttpProtocol) {
            return yield* Effect.fail(proxyOnExtensionError(payload.protocol))
          }

          const id = yield* uuid.generateShort
          const name = payload.name ?? NonEmptyString.make(id)

          const port = yield* allocator.allocate(payload.port).pipe(
            Effect.catchTags({
              PortAllocatorError: (e) => Effect.fail(new ApiConflictError({ message: e.reason })),
              PortExhaustedError: (e) =>
                Effect.fail(new ApiServiceError({ message: `No available ports in range ${e.rangeMin}-${e.rangeMax}` }))
            })
          )

          const imposterConfig = ImposterConfig({
            id,
            name,
            port,
            protocol: payload.protocol,
            status: "stopped",
            createdAt: DateTime.nowUnsafe(),
            ...(payload.proxy !== undefined ? { proxy: payload.proxy } : {})
          })

          const record = yield* repo.create(imposterConfig)
          return yield* toImposterResponse(record)
        }))
      .handle("listImposters", ({ query }) =>
        Effect.gen(function*() {
          const all = yield* repo.getAll

          const filtered = all
            .filter((r) => query.status === undefined || r.config.status === query.status)
            .filter((r) => query.protocol === undefined || r.config.protocol === query.protocol)

          filtered.sort((a, b) =>
            DateTime.toEpochMillis(a.config.createdAt) - DateTime.toEpochMillis(b.config.createdAt)
          )

          const total = filtered.length
          const paged = filtered.slice(query.offset, query.offset + query.limit)
          const imposters = yield* Effect.forEach(paged, query.stats === true ? withStatistics : toImposterResponse)

          return {
            imposters,
            pagination: buildPaginationMeta(total, query.limit, query.offset)
          }
        }))
      .handle("getImposter", ({ params }) =>
        Effect.gen(function*() {
          const record = yield* repo.get(params.id).pipe(
            Effect.catchTag("ImposterNotFoundError", (e) =>
              Effect.fail(
                new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
              ))
          )
          return yield* toImposterResponse(record)
        }))
      .handle("updateImposter", ({ params, payload }) =>
        Effect.gen(function*() {
          const existing = yield* repo.get(params.id).pipe(
            Effect.catchTag("ImposterNotFoundError", (e) =>
              Effect.fail(
                new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
              ))
          )

          if (payload.proxy !== undefined && payload.proxy !== null && existing.config.protocol !== HttpProtocol) {
            return yield* Effect.fail(proxyOnExtensionError(existing.config.protocol))
          }

          const wasRunning = yield* imposterServer.isRunning(params.id)
          const wantsRunning = payload.status === "running"
          const wantsStopped = payload.status === "stopped"
          const portChanging = payload.port !== undefined && payload.port !== existing.config.port

          // If port is changing while running, stop first
          if (portChanging && wasRunning) {
            yield* imposterServer.stop(params.id)
          }

          let newPort: number | undefined
          if (portChanging) {
            newPort = yield* allocator.allocate(payload.port).pipe(
              Effect.catchTags({
                PortAllocatorError: (e) => Effect.fail(new ApiConflictError({ message: e.reason })),
                PortExhaustedError: (e) =>
                  Effect.fail(
                    new ApiServiceError({ message: `No available ports in range ${e.rangeMin}-${e.rangeMax}` })
                  )
              })
            )
          }

          // Compute proxy update: undefined = no change, null = remove, object = set
          const proxyUpdate: { proxy?: ProxyConfigDomain | undefined } = payload.proxy === undefined
            ? {}
            : payload.proxy === null
            ? { proxy: undefined }
            : { proxy: payload.proxy }

          yield* repo.update(params.id, (r) => ({
            ...r,
            config: ImposterConfig({
              ...r.config,
              ...(payload.name !== undefined ? { name: payload.name as string } : {}),
              ...(payload.status !== undefined ? { status: payload.status } : {}),
              ...(newPort !== undefined ? { port: newPort } : {}),
              ...proxyUpdate
            })
          })).pipe(
            Effect.catchTag("ImposterNotFoundError", (e) =>
              Effect.fail(
                new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
              )),
            Effect.tapError(() => newPort !== undefined ? allocator.release(newPort) : Effect.void)
          )

          if (newPort !== undefined) {
            yield* allocator.release(existing.config.port)
          }

          // Hot-reload proxy config if it changed
          if (payload.proxy !== undefined) {
            yield* imposterServer.updateProxyConfig(params.id)
          }

          // Handle start/stop transitions
          if (wantsRunning && !wasRunning) {
            yield* imposterServer.start(params.id).pipe(
              // A bind failure (e.g. port already in use) is a conflict with the environment
              Effect.catchTag("ImposterServerError", (e) => Effect.fail(new ApiConflictError({ message: e.reason }))),
              Effect.catchTag("ImposterNotFoundError", (e) =>
                Effect.fail(
                  new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
                ))
            )
          } else if (wantsStopped && wasRunning && !portChanging) {
            yield* imposterServer.stop(params.id)
          } else if (portChanging && wasRunning) {
            // Port changed while running — restart
            yield* imposterServer.start(params.id).pipe(
              // A bind failure (e.g. port already in use) is a conflict with the environment
              Effect.catchTag("ImposterServerError", (e) => Effect.fail(new ApiConflictError({ message: e.reason }))),
              Effect.catchTag("ImposterNotFoundError", (e) =>
                Effect.fail(
                  new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
                ))
            )
          }

          // Re-read to get final status
          const final = yield* repo.get(params.id).pipe(
            Effect.catchTag("ImposterNotFoundError", (e) =>
              Effect.fail(
                new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
              ))
          )
          return yield* toImposterResponse(final)
        }))
      .handle("deleteImposter", ({ params, query }) =>
        Effect.gen(function*() {
          const existing = yield* repo.get(params.id).pipe(
            Effect.catchTag("ImposterNotFoundError", (e) =>
              Effect.fail(
                new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
              ))
          )

          if (!query.force && existing.config.status !== "stopped") {
            return yield* Effect.fail(
              new ApiConflictError({
                message: `Imposter is ${existing.config.status}, use force=true to delete`
              })
            )
          }

          // Stop if running
          const running = yield* imposterServer.isRunning(params.id)
          if (running) {
            yield* imposterServer.stop(params.id)
          }

          yield* repo.remove(params.id).pipe(
            Effect.catchTag("ImposterNotFoundError", (e) =>
              Effect.fail(
                new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
              ))
          )
          yield* allocator.release(existing.config.port)
          yield* metricsService.resetStats(params.id)

          const now = yield* Effect.map(Clock.currentTimeMillis, (ms) => DateTime.makeUnsafe(ms))

          return {
            message: NonEmptyString.make(`Imposter ${params.id} deleted`),
            id: NonEmptyString.make(params.id),
            deletedAt: now
          }
        }))
      .handle("addStub", ({ params, payload }) =>
        Effect.gen(function*() {
          const id = yield* uuid.generateShort
          // `index` places the stub; it is not part of it
          const stub = {
            id: NonEmptyString.make(id),
            predicates: payload.predicates,
            responses: payload.responses,
            responseMode: payload.responseMode
          }

          // Hot-reloads a running imposter; the other stubs keep their counters wherever it lands
          const change = StubChange.Add({ stub, index: payload.index })
          return yield* imposterServer.applyStubChange(params.imposterId, change).pipe(
            Effect.catchTags({
              ImposterNotFoundError: (e) => Effect.fail(imposterNotFound(e)),
              StubNotFoundError: (e) => Effect.fail(stubNotFound(e)),
              StubIndexOutOfRangeError: (e) =>
                Effect.fail(
                  new ApiBadRequestError({
                    message: `Stub index ${e.index} is out of range: use 0 (first) to ${e.size} (last)`
                  })
                )
            })
          )
        }))
      .handle("previewStub", ({ params, payload }) =>
        Effect.gen(function*() {
          const stubs = yield* repo.getStubs(params.imposterId).pipe(
            Effect.catchTag("ImposterNotFoundError", (e) => Effect.fail(imposterNotFound(e)))
          )
          // A group a stub added since now answers is no longer unmatched traffic
          const groups = (yield* metricsService.getUnmatched(params.imposterId)).filter((group) =>
            explainStubs(contextFromCaptured(group.sample.request), stubs).match === undefined
          )
          return yield* previewStub(payload, groups)
        }))
      .handle("listStubs", ({ params }) =>
        Effect.gen(function*() {
          return yield* repo.getStubs(params.imposterId).pipe(
            Effect.catchTag("ImposterNotFoundError", (e) =>
              Effect.fail(
                new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
              ))
          )
        }))
      .handle("updateStub", ({ params, payload }) =>
        Effect.gen(function*() {
          // Hot-reloads a running imposter; new responses or responseMode restart the stub's counters and cycle
          const change = StubChange.Update({ stubId: params.stubId, patch: payload })
          return yield* imposterServer.applyStubChange(params.imposterId, change).pipe(
            Effect.catchTags({
              ImposterNotFoundError: (e) => Effect.fail(imposterNotFound(e)),
              StubNotFoundError: (e) => Effect.fail(stubNotFound(e)),
              StubIndexOutOfRangeError: insertOnly
            })
          )
        }))
      .handle("deleteStub", ({ params }) =>
        Effect.gen(function*() {
          // Hot-reloads a running imposter and drops the stub's counters
          const change = StubChange.Remove({ stubId: params.stubId })
          return yield* imposterServer.applyStubChange(params.imposterId, change).pipe(
            Effect.catchTags({
              ImposterNotFoundError: (e) => Effect.fail(imposterNotFound(e)),
              StubNotFoundError: (e) => Effect.fail(stubNotFound(e)),
              StubIndexOutOfRangeError: insertOnly
            })
          )
        }))
      .handle("listRequests", ({ params, query }) =>
        Effect.gen(function*() {
          yield* repo.get(params.id).pipe(
            Effect.catchTag(
              "ImposterNotFoundError",
              (e) =>
                Effect.fail(
                  new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
                )
            )
          )
          return yield* requestLogger.getEntries(params.id, {
            limit: query.limit,
            ...(query.method !== undefined ? { method: query.method } : {}),
            ...(query.path !== undefined ? { path: query.path } : {}),
            ...(query.status !== undefined ? { status: query.status } : {})
          })
        }))
      .handle("explainRequest", ({ params }) =>
        Effect.gen(function*() {
          const record = yield* repo.get(params.id).pipe(
            Effect.catchTag("ImposterNotFoundError", (e) => Effect.fail(imposterNotFound(e)))
          )
          const entry = yield* requestLogger.getEntryById(params.id, params.requestId)
          if (entry === null) {
            return yield* Effect.fail(
              new ApiNotFoundError({
                message: "Request not found",
                resourceType: "request",
                resourceId: params.requestId
              })
            )
          }
          const result = explainStubs(contextFromCaptured(entry.request), record.stubs)
          const logged = entry.response.matchedStubId
          const response: ExplainResponse = {
            requestId: entry.id,
            stubs: result.stubs,
            ...(result.match !== undefined ? { matchedStubId: result.match.id } : {}),
            ...(logged !== undefined ? { loggedMatchedStubId: logged } : {}),
            // A request that would now fail to match was answered when it arrived, so that disagrees too
            agreesWithLog: result.error === undefined && result.match?.id === logged,
            ...(result.error !== undefined ? { error: result.error } : {})
          }
          return response
        }))
      .handle("clearRequests", ({ params }) =>
        Effect.gen(function*() {
          yield* repo.get(params.id).pipe(
            Effect.catchTag(
              "ImposterNotFoundError",
              (e) =>
                Effect.fail(
                  new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
                )
            )
          )
          yield* requestLogger.clear(params.id)
          return { message: `Request log cleared for imposter ${params.id}` }
        }))
      .handle("getImposterStats", ({ params }) =>
        Effect.gen(function*() {
          const record = yield* repo.get(params.id).pipe(
            Effect.catchTag("ImposterNotFoundError", (e) => Effect.fail(imposterNotFound(e)))
          )
          return yield* statisticsFor(params.id, record.stubs)
        }))
      .handle("resetImposterStats", ({ params }) =>
        Effect.gen(function*() {
          yield* repo.get(params.id).pipe(
            Effect.catchTag("ImposterNotFoundError", (e) =>
              Effect.fail(
                new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
              ))
          )
          yield* metricsService.resetStats(params.id)
          return { message: `Statistics reset for imposter ${params.id}` }
        }))
  }))
