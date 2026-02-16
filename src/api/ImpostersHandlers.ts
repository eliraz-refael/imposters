import { HttpApiBuilder } from "@effect/platform"
import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { ImposterConfig, type ProxyConfigDomain } from "../domain/imposter.js"
import { ImposterRepository } from "../repositories/ImposterRepository.js"
import { NonEmptyString } from "../schemas/common.js"
import { ImposterServer } from "../server/ImposterServer.js"
import { AppConfig } from "../services/AppConfig.js"
import { MetricsService } from "../services/MetricsService.js"
import { PortAllocator } from "../services/PortAllocator.js"
import { RequestLogger } from "../services/RequestLogger.js"
import { Uuid } from "../services/Uuid.js"
import { AdminApi } from "./AdminApi.js"
import { ApiConflictError, ApiNotFoundError, ApiServiceError } from "./ApiErrors.js"
import { buildPaginationMeta, toImposterResponse } from "./Conversions.js"

export const ImpostersHandlersLive = HttpApiBuilder.group(AdminApi, "imposters", (handlers) =>
  handlers
    .handle("createImposter", ({ payload }) =>
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const uuid = yield* Uuid
        const allocator = yield* PortAllocator
        const config = yield* AppConfig

        const all = yield* repo.getAll
        if (all.length >= config.maxImposters) {
          return yield* Effect.fail(
            new ApiServiceError({ message: `Maximum number of imposters (${config.maxImposters}) reached` })
          )
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
          status: "stopped",
          createdAt: DateTime.unsafeNow(),
          ...(payload.proxy !== undefined ? { proxy: payload.proxy } : {})
        })

        const record = yield* repo.create(imposterConfig)
        return yield* toImposterResponse(record)
      }))
    .handle("listImposters", ({ urlParams }) =>
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const all = yield* repo.getAll

        // All imposters are HTTP in Phase 2; protocol filter is for forward compatibility
        const filtered = all
          .filter((r) => urlParams.status === undefined || r.config.status === urlParams.status)
          .filter(() => urlParams.protocol === undefined || urlParams.protocol === "HTTP")

        filtered.sort((a, b) => DateTime.toEpochMillis(a.config.createdAt) - DateTime.toEpochMillis(b.config.createdAt))

        const total = filtered.length
        const paged = filtered.slice(urlParams.offset, urlParams.offset + urlParams.limit)
        const imposters = yield* Effect.all(paged.map(toImposterResponse))

        return {
          imposters,
          pagination: buildPaginationMeta(total, urlParams.limit, urlParams.offset)
        }
      }))
    .handle("getImposter", ({ path }) =>
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const record = yield* repo.get(path.id).pipe(
          Effect.catchTag("ImposterNotFoundError", (e) =>
            Effect.fail(
              new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
            ))
        )
        return yield* toImposterResponse(record)
      }))
    .handle("updateImposter", ({ path, payload }) =>
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const allocator = yield* PortAllocator
        const imposterServer = yield* ImposterServer

        const existing = yield* repo.get(path.id).pipe(
          Effect.catchTag("ImposterNotFoundError", (e) =>
            Effect.fail(
              new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
            ))
        )

        const wasRunning = yield* imposterServer.isRunning(path.id)
        const wantsRunning = payload.status === "running"
        const wantsStopped = payload.status === "stopped"
        const portChanging = payload.port !== undefined && payload.port !== existing.config.port

        // If port is changing while running, stop first
        if (portChanging && wasRunning) {
          yield* imposterServer.stop(path.id)
        }

        let newPort: number | undefined
        if (portChanging) {
          newPort = yield* allocator.allocate(payload.port).pipe(
            Effect.catchTags({
              PortAllocatorError: (e) => Effect.fail(new ApiConflictError({ message: e.reason })),
              PortExhaustedError: (e) =>
                Effect.fail(new ApiServiceError({ message: `No available ports in range ${e.rangeMin}-${e.rangeMax}` }))
            })
          )
        }

        // Compute proxy update: undefined = no change, null = remove, object = set
        const proxyUpdate: { proxy?: ProxyConfigDomain | undefined } = payload.proxy === undefined
          ? {}
          : payload.proxy === null
          ? { proxy: undefined }
          : { proxy: payload.proxy }

        yield* repo.update(path.id, (r) => ({
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
          yield* imposterServer.updateProxyConfig(path.id)
        }

        // Handle start/stop transitions
        if (wantsRunning && !wasRunning) {
          yield* imposterServer.start(path.id).pipe(
            Effect.catchTag("ImposterServerError", (e) => Effect.fail(new ApiServiceError({ message: e.reason }))),
            Effect.catchTag("ImposterNotFoundError", (e) =>
              Effect.fail(
                new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
              ))
          )
        } else if (wantsStopped && wasRunning && !portChanging) {
          yield* imposterServer.stop(path.id)
        } else if (portChanging && wasRunning) {
          // Port changed while running — restart
          yield* imposterServer.start(path.id).pipe(
            Effect.catchTag("ImposterServerError", (e) => Effect.fail(new ApiServiceError({ message: e.reason }))),
            Effect.catchTag("ImposterNotFoundError", (e) =>
              Effect.fail(
                new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
              ))
          )
        }

        // Re-read to get final status
        const final = yield* repo.get(path.id).pipe(
          Effect.catchTag("ImposterNotFoundError", (e) =>
            Effect.fail(
              new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
            ))
        )
        return yield* toImposterResponse(final)
      }))
    .handle("deleteImposter", ({ path, urlParams }) =>
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const allocator = yield* PortAllocator
        const imposterServer = yield* ImposterServer
        const metricsService = yield* MetricsService

        const existing = yield* repo.get(path.id).pipe(
          Effect.catchTag("ImposterNotFoundError", (e) =>
            Effect.fail(
              new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
            ))
        )

        if (!urlParams.force && existing.config.status !== "stopped") {
          return yield* Effect.fail(
            new ApiConflictError({
              message: `Imposter is ${existing.config.status}, use force=true to delete`
            })
          )
        }

        // Stop if running
        const running = yield* imposterServer.isRunning(path.id)
        if (running) {
          yield* imposterServer.stop(path.id)
        }

        yield* repo.remove(path.id).pipe(
          Effect.catchTag("ImposterNotFoundError", (e) =>
            Effect.fail(
              new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
            ))
        )
        yield* allocator.release(existing.config.port)
        yield* metricsService.resetStats(path.id)

        const now = yield* Effect.map(Clock.currentTimeMillis, (ms) => DateTime.unsafeMake(ms))

        return {
          message: NonEmptyString.make(`Imposter ${path.id} deleted`),
          id: NonEmptyString.make(path.id),
          deletedAt: now
        }
      }))
    .handle("addStub", ({ path, payload }) =>
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const uuid = yield* Uuid
        const imposterServer = yield* ImposterServer

        const id = yield* uuid.generateShort
        const stub = {
          id: NonEmptyString.make(id),
          predicates: payload.predicates,
          responses: payload.responses,
          responseMode: payload.responseMode
        }

        const result = yield* repo.addStub(path.imposterId, stub).pipe(
          Effect.catchTag("ImposterNotFoundError", (e) =>
            Effect.fail(
              new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
            ))
        )

        // Hot-reload if running
        const running = yield* imposterServer.isRunning(path.imposterId)
        if (running) {
          yield* imposterServer.updateStubs(path.imposterId)
        }

        return result
      }))
    .handle("listStubs", ({ path }) =>
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        return yield* repo.getStubs(path.imposterId).pipe(
          Effect.catchTag("ImposterNotFoundError", (e) =>
            Effect.fail(
              new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
            ))
        )
      }))
    .handle("updateStub", ({ path, payload }) =>
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const imposterServer = yield* ImposterServer

        const result = yield* repo.updateStub(path.imposterId, path.stubId, (s) => ({
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
        const running = yield* imposterServer.isRunning(path.imposterId)
        if (running) {
          yield* imposterServer.updateStubs(path.imposterId)
        }

        return result
      }))
    .handle("deleteStub", ({ path }) =>
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const imposterServer = yield* ImposterServer

        const result = yield* repo.removeStub(path.imposterId, path.stubId).pipe(
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
        const running = yield* imposterServer.isRunning(path.imposterId)
        if (running) {
          yield* imposterServer.updateStubs(path.imposterId)
        }

        return result
      }))
    .handle("listRequests", ({ path, urlParams }) =>
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const requestLogger = yield* RequestLogger
        yield* repo.get(path.id).pipe(
          Effect.catchTag(
            "ImposterNotFoundError",
            (e) =>
              Effect.fail(
                new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
              )
          )
        )
        return yield* requestLogger.getEntries(path.id, {
          limit: urlParams.limit,
          ...(urlParams.method !== undefined ? { method: urlParams.method } : {}),
          ...(urlParams.path !== undefined ? { path: urlParams.path } : {}),
          ...(urlParams.status !== undefined ? { status: urlParams.status } : {})
        })
      }))
    .handle("clearRequests", ({ path }) =>
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const requestLogger = yield* RequestLogger
        yield* repo.get(path.id).pipe(
          Effect.catchTag(
            "ImposterNotFoundError",
            (e) =>
              Effect.fail(
                new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
              )
          )
        )
        yield* requestLogger.clear(path.id)
        return { message: `Request log cleared for imposter ${path.id}` }
      }))
    .handle("getImposterStats", ({ path }) =>
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const metricsService = yield* MetricsService
        yield* repo.get(path.id).pipe(
          Effect.catchTag("ImposterNotFoundError", (e) =>
            Effect.fail(
              new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
            ))
        )
        return yield* metricsService.getStats(path.id)
      }))
    .handle("resetImposterStats", ({ path }) =>
      Effect.gen(function*() {
        const repo = yield* ImposterRepository
        const metricsService = yield* MetricsService
        yield* repo.get(path.id).pipe(
          Effect.catchTag("ImposterNotFoundError", (e) =>
            Effect.fail(
              new ApiNotFoundError({ message: "Imposter not found", resourceType: "imposter", resourceId: e.id })
            ))
        )
        yield* metricsService.resetStats(path.id)
        return { message: `Statistics reset for imposter ${path.id}` }
      })))
