import { Effect, Ref } from "effect"
import type { ImposterConfig } from "../domain/imposter.js"
import type { ImposterRepositoryShape } from "../repositories/ImposterRepository.js"
import type { Stub } from "../schemas/StubSchema.js"
import { NonEmptyString } from "../schemas/common.js"
import type { RequestLoggerShape } from "../services/RequestLogger.js"
import { dashboardPage } from "./pages/dashboard.js"
import { stubsPage } from "./pages/stubs.js"
import { errorPartial, stubListPartial } from "./partials.js"

export interface UiDeps {
  readonly id: string
  readonly config: ImposterConfig
  readonly stubsRef: Ref.Ref<ReadonlyArray<Stub>>
  readonly repo: ImposterRepositoryShape
  readonly requestLogger: RequestLoggerShape
  readonly runPromise: <A>(effect: Effect.Effect<A>) => Promise<A>
}

const htmlResponse = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" }
  })

const parseStubIdFromPath = (path: string): string | null => {
  const match = path.match(/^\/stubs\/(.+)$/)
  return match ? match[1]! : null
}

export const makeUiRouter = (deps: UiDeps) =>
  async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith("/_admin")) return null

    const path = url.pathname.slice("/_admin".length) || "/"
    const method = request.method.toUpperCase()

    // GET / — dashboard
    if (method === "GET" && (path === "/" || path === "")) {
      return deps.runPromise(
        Effect.gen(function*() {
          const stubs = yield* Ref.get(deps.stubsRef)
          const requestCount = yield* deps.requestLogger.getCount(deps.id)
          const recentRequests = yield* deps.requestLogger.getEntries(deps.id, { limit: 10 })
          return htmlResponse(
            dashboardPage({ config: deps.config, stubCount: stubs.length, requestCount, recentRequests: recentRequests.slice().reverse() }).value
          )
        })
      )
    }

    // GET /stubs — stubs page
    if (method === "GET" && path === "/stubs") {
      return deps.runPromise(
        Effect.gen(function*() {
          const stubs = yield* Ref.get(deps.stubsRef)
          return htmlResponse(stubsPage({ config: deps.config, stubs }).value)
        })
      )
    }

    // POST /stubs — add stub
    if (method === "POST" && path === "/stubs") {
      try {
        const formData = await request.formData()
        const predicatesRaw = formData.get("predicates") as string | null
        const responsesRaw = formData.get("responses") as string | null
        const responseMode = (formData.get("responseMode") as string | null) || "sequential"

        if (!responsesRaw) {
          return htmlResponse(errorPartial("Responses field is required.").value, 200)
        }

        let predicates: unknown
        let responses: unknown
        try {
          predicates = JSON.parse(predicatesRaw || "[]")
          responses = JSON.parse(responsesRaw)
        } catch {
          return htmlResponse(errorPartial("Invalid JSON in predicates or responses.").value, 200)
        }

        if (!Array.isArray(responses) || responses.length === 0) {
          return htmlResponse(errorPartial("Responses must be a non-empty array.").value, 200)
        }

        const stubId = NonEmptyString.make(crypto.randomUUID().slice(0, 8))
        const stub: Stub = {
          id: stubId,
          predicates: predicates as Stub["predicates"],
          responses: responses as unknown as Stub["responses"],
          responseMode: responseMode as Stub["responseMode"]
        }

        return await deps.runPromise(
          Effect.gen(function*() {
            yield* deps.repo.addStub(deps.id, stub).pipe(
              Effect.catchAll(() => Effect.void)
            )
            const updated = yield* deps.repo.getStubs(deps.id).pipe(
              Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<Stub>))
            )
            yield* Ref.set(deps.stubsRef, updated)
            return htmlResponse(stubListPartial(updated).value)
          })
        )
      } catch {
        return htmlResponse(errorPartial("Failed to parse form data.").value, 200)
      }
    }

    // DELETE /stubs/:id — delete stub
    const deleteStubId = method === "DELETE" ? parseStubIdFromPath(path) : null
    if (deleteStubId !== null) {
      return deps.runPromise(
        Effect.gen(function*() {
          yield* deps.repo.removeStub(deps.id, deleteStubId).pipe(
            Effect.catchAll(() => Effect.void)
          )
          const updated = yield* deps.repo.getStubs(deps.id).pipe(
            Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<Stub>))
          )
          yield* Ref.set(deps.stubsRef, updated)
          return htmlResponse(stubListPartial(updated).value)
        })
      )
    }

    // PUT /stubs/:id — update stub
    const putStubId = method === "PUT" ? parseStubIdFromPath(path) : null
    if (putStubId !== null) {
      try {
        const formData = await request.formData()
        const predicatesRaw = formData.get("predicates") as string | null
        const responsesRaw = formData.get("responses") as string | null
        const responseMode = formData.get("responseMode") as string | null

        return await deps.runPromise(
          Effect.gen(function*() {
            yield* deps.repo.updateStub(deps.id, putStubId, (existing) => ({
              ...existing,
              ...(predicatesRaw ? { predicates: JSON.parse(predicatesRaw) } : {}),
              ...(responsesRaw ? { responses: JSON.parse(responsesRaw) } : {}),
              ...(responseMode ? { responseMode: responseMode as Stub["responseMode"] } : {})
            })).pipe(Effect.catchAll(() => Effect.void))
            const updated = yield* deps.repo.getStubs(deps.id).pipe(
              Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<Stub>))
            )
            yield* Ref.set(deps.stubsRef, updated)
            return htmlResponse(stubListPartial(updated).value)
          })
        )
      } catch {
        return htmlResponse(errorPartial("Failed to parse form data.").value, 200)
      }
    }

    // Fallback: 404 within /_admin
    return htmlResponse("<h1>Not Found</h1>", 404)
  }
