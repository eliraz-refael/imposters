import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ImposterConfig, type ProxyConfigDomain } from "../domain/imposter.js"
import { Extensions, findExtension, supportedProtocols } from "../extensions/Extension.js"
import { ImposterRepository } from "../repositories/ImposterRepository.js"
import { HttpProtocol, NonEmptyString } from "../schemas/common.js"
import { ImposterServer } from "../server/ImposterServer.js"
import { AppConfig } from "../services/AppConfig.js"
import { MetricsService } from "../services/MetricsService.js"
import { PortAllocator } from "../services/PortAllocator.js"
import { RequestLogger } from "../services/RequestLogger.js"
import { Uuid } from "../services/Uuid.js"
import { AdminApi } from "./AdminApi.js"
import { ApiBadRequestError, ApiConflictError, ApiNotFoundError, ApiServiceError } from "./ApiErrors.js"
import { buildPaginationMeta, toImposterResponse } from "./Conversions.js"

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
          const imposters = yield* Effect.all(paged.map(toImposterResponse))

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
          const stub = {
            id: NonEmptyString.make(id),
            predicates: payload.predicates,
            responses: payload.responses,
            responseMode: payload.responseMode
          }

          const result = yield* repo.addStub(params.imposterId, stub).pipe(
            Effect.catchTag("ImposterNotFoundError", (e) =>
              Effect.fail(
                new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
              ))
          )

          // Hot-reload if running
          const running = yield* imposterServer.isRunning(params.imposterId)
          if (running) {
            yield* imposterServer.updateStubs(params.imposterId)
          }

          return result
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
          const result = yield* repo.updateStub(params.imposterId, params.stubId, (s) => ({
            ...s,
            ...(payload.predicates !== undefined ? { predicates: payload.predicates } : {}),
            ...(payload.responses !== undefined ? { responses: payload.responses } : {}),
            ...(payload.responseMode !== undefined ? { responseMode: payload.responseMode } : {})
          })).pipe(
            Effect.catchTag("ImposterNotFoundError", (e) =>
              Effect.fail(
                new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
              )),
            Effect.catchTag("StubNotFoundError", (e) =>
              Effect.fail(
                new ApiNotFoundError({ message: "Stub not found", resourceType: "stub", resourceId: e.stubId })
              ))
          )

          // Hot-reload if running
          const running = yield* imposterServer.isRunning(params.imposterId)
          if (running) {
            yield* imposterServer.updateStubs(params.imposterId)
          }

          return result
        }))
      .handle("deleteStub", ({ params }) =>
        Effect.gen(function*() {
          const result = yield* repo.removeStub(params.imposterId, params.stubId).pipe(
            Effect.catchTag("ImposterNotFoundError", (e) =>
              Effect.fail(
                new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
              )),
            Effect.catchTag(
              "StubNotFoundError",
              (e) =>
                Effect.fail(
                  new ApiNotFoundError({ message: "Stub not found", resourceType: "stub", resourceId: e.stubId })
                )
            )
          )

          // Hot-reload if running
          const running = yield* imposterServer.isRunning(params.imposterId)
          if (running) {
            yield* imposterServer.updateStubs(params.imposterId)
          }

          return result
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
          yield* repo.get(params.id).pipe(
            Effect.catchTag("ImposterNotFoundError", (e) =>
              Effect.fail(
                new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
              ))
          )
          return yield* metricsService.getStats(params.id)
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
