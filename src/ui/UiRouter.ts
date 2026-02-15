import { Effect, Ref } from "effect"
import type { ImposterConfig } from "../domain/imposter.js"
import type { ImposterRepositoryShape } from "../repositories/ImposterRepository.js"
import type { Stub } from "../schemas/StubSchema.js"
import { NonEmptyString } from "../schemas/common.js"
import type { RequestLoggerShape } from "../services/RequestLogger.js"
import { dashboardPage } from "./pages/dashboard.js"
import { requestDetailPage } from "./pages/request-detail.js"
import { requestsPage, testResultPartial } from "./pages/requests.js"
import { stubsPage } from "./pages/stubs.js"
import { errorPartial, requestTablePartial, stubListPartial } from "./partials.js"

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

    // GET /requests — full page
    if (method === "GET" && path === "/requests") {
      return deps.runPromise(
        Effect.gen(function*() {
          const entries = yield* deps.requestLogger.getEntries(deps.id, { limit: 100 })
          return htmlResponse(requestsPage({ config: deps.config, entries }).value)
        })
      )
    }

    // GET /requests/list — HTMX partial (filtered table body)
    if (method === "GET" && path === "/requests/list") {
      const params = url.searchParams
      return deps.runPromise(
        Effect.gen(function*() {
          const opts: { limit?: number; method?: string; path?: string; status?: number } = { limit: 100 }
          const methodFilter = params.get("method")
          if (methodFilter) opts.method = methodFilter
          const pathFilter = params.get("path")
          if (pathFilter) opts.path = pathFilter
          const statusFilter = params.get("status")
          if (statusFilter) opts.status = Number(statusFilter)
          const entries = yield* deps.requestLogger.getEntries(deps.id, opts)
          return htmlResponse(requestTablePartial(entries.slice().reverse()).value)
        })
      )
    }

    // POST /requests/test — send test request to own port
    if (method === "POST" && path === "/requests/test") {
      try {
        const formData = await request.formData()
        const testMethod = (formData.get("method") as string) || "GET"
        const testPath = (formData.get("path") as string) || "/"
        const testBody = formData.get("body") as string | null
        const testContentType = (formData.get("contentType") as string) || "application/json"
        const testHeadersRaw = (formData.get("headers") as string) || ""

        const headers: Record<string, string> = {}
        if (testContentType && testBody) {
          headers["content-type"] = testContentType
        }
        for (const line of testHeadersRaw.split("\n")) {
          const colonIdx = line.indexOf(":")
          if (colonIdx > 0) {
            headers[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim()
          }
        }

        const startTime = Date.now()
        const testResp = await fetch(`http://localhost:${deps.config.port}${testPath}`, {
          method: testMethod,
          headers,
          ...(testBody && testMethod !== "GET" && testMethod !== "HEAD" ? { body: testBody } : {})
        })
        const duration = Date.now() - startTime

        const respBody = await testResp.text()
        const respHeaders: Record<string, string> = {}
        testResp.headers.forEach((val, key) => { respHeaders[key] = val })

        return htmlResponse(testResultPartial({ status: testResp.status, headers: respHeaders, body: respBody, duration }).value)
      } catch (err) {
        return htmlResponse(
          `<div class="bg-red-50 border border-red-200 text-red-700 rounded p-3">Request failed: ${String(err)}</div>`
        )
      }
    }

    // DELETE /requests — clear log
    if (method === "DELETE" && path === "/requests") {
      return deps.runPromise(
        Effect.gen(function*() {
          yield* deps.requestLogger.clear(deps.id)
          return htmlResponse(requestTablePartial([]).value)
        })
      )
    }

    // GET /requests/:id — detail page
    if (method === "GET" && path.startsWith("/requests/")) {
      const entryId = path.slice("/requests/".length)
      if (entryId && !entryId.includes("/")) {
        return deps.runPromise(
          Effect.gen(function*() {
            const entry = yield* deps.requestLogger.getEntryById(deps.id, entryId)
            if (entry === null) {
              return htmlResponse("<h1>Request not found</h1>", 404)
            }
            // Try to find matched stub
            let matchedStub: Stub | null = null
            if (entry.response.matchedStubId) {
              try {
                const stubs = yield* deps.repo.getStubs(deps.id).pipe(
                  Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<Stub>))
                )
                matchedStub = stubs.find((s) => s.id === entry.response.matchedStubId) ?? null
              } catch {
                // ignore
              }
            }
            return htmlResponse(requestDetailPage({ config: deps.config, entry, matchedStub }).value)
          })
        )
      }
    }

    // Fallback: 404 within /_admin
    return htmlResponse("<h1>Not Found</h1>", 404)
  }
