import { Effect, Layer, ManagedRuntime } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HandlerHttpClientLive } from "imposters/client/HandlerHttpClient"
import { ImpostersClient, ImpostersClientLive } from "imposters/client/ImpostersClient"
import { makeTestServer, withImposter } from "imposters/client/testing"
import { ApiLayer } from "imposters/layers/ApiLayer"
import { MainLayer } from "imposters/layers/MainLayer"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const FullLayer = ApiLayer.pipe(Layer.provide(MainLayer))

let handler: (request: Request) => Promise<Response>
let dispose: () => void
let runtime: ManagedRuntime.ManagedRuntime<ImpostersClient, never>

beforeAll(() => {
  const result = HttpRouter.toWebHandler(FullLayer)
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

const run = <A, E>(effect: Effect.Effect<A, E, ImpostersClient>) => runtime.runPromise(effect)

describe("withImposter", () => {
  it("creates imposter, runs test, cleans up", async () => {
    await run(
      withImposter(
        {
          port: 9531,
          name: "test-helper-imposter",
          stubs: [{
            predicates: [{ field: "path", operator: "equals", value: "/hello" }],
            responses: [{ status: 200, body: { message: "hello from helper" } }]
          }]
        },
        (ctx) =>
          Effect.gen(function*() {
            expect(ctx.port).toBe(9531)
            expect(ctx.id).toBeDefined()

            // Hit the imposter directly
            const resp = yield* Effect.promise(() => fetch(`http://localhost:${ctx.port}/hello`))
            expect(resp.status).toBe(200)
            const body = yield* Effect.promise(() => resp.json())
            expect(body).toEqual({ message: "hello from helper" })
          })
      )
    )

    // Verify imposter was cleaned up
    const result = await run(
      Effect.gen(function*() {
        const client = yield* ImpostersClient
        const list = yield* client.imposters.listImposters({ query: { limit: 50 as any, offset: 0 } })
        return list.imposters.filter((i) => i.port === 9531 as any)
      })
    )
    expect(result.length).toBe(0)
  }, 15000)

  it("cleans up on test failure", async () => {
    const testError = new Error("intentional test failure")

    try {
      await run(
        withImposter(
          { port: 9532, stubs: [{ responses: [{ status: 200 }] }] },
          () => Effect.fail(testError)
        )
      )
      expect.fail("should have thrown")
    } catch (err: any) {
      // Effect wraps errors in FiberFailure
      expect(String(err)).toContain("intentional test failure")
    }

    // Verify cleanup happened
    const result = await run(
      Effect.gen(function*() {
        const client = yield* ImpostersClient
        const list = yield* client.imposters.listImposters({ query: { limit: 50 as any, offset: 0 } })
        return list.imposters.filter((i) => i.port === 9532 as any)
      })
    )
    expect(result.length).toBe(0)
  }, 15000)
})

describe("makeTestServer", () => {
  it("creates server with handler and client layer", async () => {
    const { clientLayer, dispose: d, handler: h } = makeTestServer()
    expect(h).toBeDefined()
    expect(d).toBeDefined()

    const rt = ManagedRuntime.make(clientLayer)
    try {
      const result = await rt.runPromise(
        Effect.gen(function*() {
          const client = yield* ImpostersClient
          return yield* client.healthCheck()
        })
      )
      expect(result.status).toBe("healthy")
    } finally {
      await rt.dispose()
      d()
    }
  })
})
