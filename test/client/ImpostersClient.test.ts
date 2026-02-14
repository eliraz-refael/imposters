import { HttpApiBuilder } from "@effect/platform"
import { Effect, Layer, ManagedRuntime } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ApiLayer } from "imposters/layers/ApiLayer.js"
import { FiberManagerLive } from "imposters/server/FiberManager.js"
import { ImposterServerLive } from "imposters/server/ImposterServer.js"
import { ImposterRepositoryLive } from "imposters/repositories/ImposterRepository.js"
import { AppConfigLive } from "imposters/services/AppConfig.js"
import { PortAllocatorLive } from "imposters/services/PortAllocator.js"
import { RequestLoggerLive } from "imposters/services/RequestLogger.js"
import { UuidLive } from "imposters/services/UuidLive.js"
import { NodeServerFactoryLive } from "imposters/test/helpers/NodeServerFactory.js"
import { HandlerHttpClientLive } from "imposters/client/HandlerHttpClient.js"
import { ImpostersClient, ImpostersClientLive } from "imposters/client/ImpostersClient.js"
import type { PortNumber, NonEmptyString, PositiveInteger } from "imposters/schemas/common.js"

const PortAllocatorWithDeps = PortAllocatorLive.pipe(Layer.provide(AppConfigLive))
const ImposterServerWithDeps = ImposterServerLive.pipe(
  Layer.provide(Layer.mergeAll(FiberManagerLive, ImposterRepositoryLive, NodeServerFactoryLive, RequestLoggerLive))
)
const MainLayer = Layer.mergeAll(
  UuidLive,
  AppConfigLive,
  PortAllocatorWithDeps,
  ImposterRepositoryLive,
  FiberManagerLive,
  RequestLoggerLive,
  ImposterServerWithDeps
)
const FullLayer = ApiLayer.pipe(Layer.provide(MainLayer))

const port = (n: number) => n as PortNumber
const nes = (s: string) => s as NonEmptyString
const posInt = (n: number) => n as PositiveInteger
const impPayload = (p: number) => ({ port: port(p), protocol: "HTTP" as const, adminPath: "/_admin" })

let handler: (request: Request) => Promise<Response>
let dispose: () => void
let runtime: ManagedRuntime.ManagedRuntime<ImpostersClient, never>

beforeAll(() => {
  const result = HttpApiBuilder.toWebHandler(FullLayer)
  handler = result.handler
  dispose = result.dispose

  const clientLayer = ImpostersClientLive().pipe(
    Layer.provide(HandlerHttpClientLive(handler))
  )
  runtime = ManagedRuntime.make(clientLayer)
})

afterAll(async () => {
  await runtime.dispose()
  dispose()
})

const run = <A, E>(effect: Effect.Effect<A, E, ImpostersClient>) =>
  runtime.runPromise(effect)

describe("ImpostersClient", () => {
  describe("system endpoints (top-level)", () => {
    it("healthCheck returns healthy status", async () => {
      const result = await run(
        Effect.gen(function* () {
          const client = yield* ImpostersClient
          return yield* client.healthCheck()
        })
      )
      expect(result.status).toBe("healthy")
    })

    it("serverInfo returns server info", async () => {
      const result = await run(
        Effect.gen(function* () {
          const client = yield* ImpostersClient
          return yield* client.serverInfo()
        })
      )
      expect(result.server.name).toBeDefined()
      expect(result.configuration).toBeDefined()
    })
  })

  describe("imposters CRUD", () => {
    it("create, get, list, update, delete imposter", async () => {
      // Create
      const created = await run(
        Effect.gen(function* () {
          const client = yield* ImpostersClient
          return yield* client.imposters.createImposter({ payload: impPayload(9401) })
        })
      )
      expect(created.port).toBe(9401)
      expect(created.status).toBe("stopped")
      const id = created.id

      // Get
      const fetched = await run(
        Effect.gen(function* () {
          const client = yield* ImpostersClient
          return yield* client.imposters.getImposter({ path: { id } })
        })
      )
      expect(fetched.id).toBe(id)
      expect(fetched.port).toBe(9401)

      // List
      const listed = await run(
        Effect.gen(function* () {
          const client = yield* ImpostersClient
          return yield* client.imposters.listImposters({ urlParams: { limit: posInt(50), offset: 0 } })
        })
      )
      expect(listed.imposters.length).toBeGreaterThanOrEqual(1)
      expect(listed.imposters.some((i) => i.id === id)).toBe(true)

      // Update
      const updated = await run(
        Effect.gen(function* () {
          const client = yield* ImpostersClient
          return yield* client.imposters.updateImposter({
            path: { id },
            payload: { name: nes("Updated Name") }
          })
        })
      )
      expect(updated.name).toBe("Updated Name")

      // Delete
      const deleted = await run(
        Effect.gen(function* () {
          const client = yield* ImpostersClient
          return yield* client.imposters.deleteImposter({
            path: { id },
            urlParams: { force: false }
          })
        })
      )
      expect(deleted.id).toBe(id)
    })

    it("stubs: add, list, update, delete", async () => {
      const imp = await run(
        Effect.gen(function* () {
          const client = yield* ImpostersClient
          return yield* client.imposters.createImposter({ payload: impPayload(9402) })
        })
      )

      try {
        // Add stub
        const stub = await run(
          Effect.gen(function* () {
            const client = yield* ImpostersClient
            return yield* client.imposters.addStub({
              path: { imposterId: imp.id },
              payload: {
                predicates: [],
                responses: [{ status: 200, body: { ok: true } }],
                responseMode: "sequential"
              }
            })
          })
        )
        expect(stub.id).toBeDefined()
        expect(stub.responses.length).toBe(1)

        // List stubs
        const stubs = await run(
          Effect.gen(function* () {
            const client = yield* ImpostersClient
            return yield* client.imposters.listStubs({ path: { imposterId: imp.id } })
          })
        )
        expect(stubs.length).toBe(1)

        // Update stub
        const updatedStub = await run(
          Effect.gen(function* () {
            const client = yield* ImpostersClient
            return yield* client.imposters.updateStub({
              path: { imposterId: imp.id, stubId: stub.id },
              payload: { responses: [{ status: 201, body: { updated: true } }] }
            })
          })
        )
        expect(updatedStub.responses[0].status).toBe(201)

        // Delete stub
        const deletedStub = await run(
          Effect.gen(function* () {
            const client = yield* ImpostersClient
            return yield* client.imposters.deleteStub({
              path: { imposterId: imp.id, stubId: stub.id }
            })
          })
        )
        expect(deletedStub.id).toBe(stub.id)
      } finally {
        await run(
          Effect.gen(function* () {
            const client = yield* ImpostersClient
            return yield* client.imposters.deleteImposter({
              path: { id: imp.id },
              urlParams: { force: false }
            })
          })
        )
      }
    })

    it("returns error for missing imposter", async () => {
      const result = await run(
        Effect.gen(function* () {
          const client = yield* ImpostersClient
          return yield* client.imposters.getImposter({ path: { id: "nonexistent" } }).pipe(
            Effect.map(() => "should-not-reach" as const),
            Effect.catchAll(() => Effect.succeed("error" as const))
          )
        })
      )
      expect(result).toBe("error")
    })

    it("returns error for duplicate port", async () => {
      const imp = await run(
        Effect.gen(function* () {
          const client = yield* ImpostersClient
          return yield* client.imposters.createImposter({ payload: impPayload(9403) })
        })
      )

      try {
        const result = await run(
          Effect.gen(function* () {
            const client = yield* ImpostersClient
            return yield* client.imposters.createImposter({ payload: impPayload(9403) }).pipe(
              Effect.map(() => "should-not-reach" as const),
              Effect.catchAll(() => Effect.succeed("conflict" as const))
            )
          })
        )
        expect(result).toBe("conflict")
      } finally {
        await run(
          Effect.gen(function* () {
            const client = yield* ImpostersClient
            return yield* client.imposters.deleteImposter({
              path: { id: imp.id },
              urlParams: { force: false }
            })
          })
        )
      }
    })
  })
})
