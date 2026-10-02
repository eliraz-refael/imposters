import { it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { previewStub, type RequestSample } from "imposters/matching/Preview"
import { NonEmptyString } from "imposters/schemas/common"
import { CreateStubRequest } from "imposters/schemas/StubSchema"
import { describe, expect } from "vitest"

const decodeCandidate = Schema.decodeUnknownSync(CreateStubRequest)

// An unmatched group of `count` requests whose latest is `METHOD path`
const group = (
  count: number,
  method: string,
  path: string,
  request: { headers?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}
): RequestSample => ({
  count,
  sample: {
    id: NonEmptyString.make(`req-${method}-${path}`),
    imposterId: NonEmptyString.make("imp"),
    timestamp: DateTime.makeUnsafe(0),
    request: { method, path, headers: request.headers ?? {}, query: request.query ?? {}, body: request.body },
    response: { status: 404, headers: {}, proxied: false, outcome: "unmatched" },
    duration: 1
  }
})

const groups: ReadonlyArray<RequestSample> = [
  group(3, "GET", "/orders/7", { query: { verbose: "yes" } }),
  group(2, "POST", "/orders", { headers: { "content-type": "application/json" }, body: { sku: "A-1" } }),
  group(1, "GET", "/health")
]

describe("previewStub", () => {
  it.effect("sums the matched groups' counts against all of them, with the first match's answer", () =>
    Effect.gen(function*() {
      const preview = yield* previewStub(
        decodeCandidate({
          predicates: [{ field: "path", operator: "startsWith", value: "/orders" }],
          responses: [{ status: 201, body: { path: "{{request.path}}" } }, { status: 500 }]
        }),
        groups
      )
      expect(preview).toEqual({
        matched: 5,
        total: 6,
        sample: {
          request: { method: "GET", path: "/orders/7" },
          // The first response, templated against the sample request
          response: { status: 201, headers: { "content-type": "application/json" }, body: "{\"path\":\"/orders/7\"}" }
        }
      })
    }))

  it.effect("templates the sample with the logged body, query and headers", () =>
    Effect.gen(function*() {
      const preview = yield* previewStub(
        decodeCandidate({
          predicates: [{ field: "body", operator: "equals", value: { sku: "A-1" } }],
          responses: [{ headers: { "x-sku": "${request.body.sku}" }, body: "{{request.headers.content-type}}" }]
        }),
        groups
      )
      expect(preview.matched).toBe(2)
      expect(preview.sample?.request).toEqual({ method: "POST", path: "/orders" })
      expect(preview.sample?.response).toEqual({
        status: 200,
        headers: { "content-type": "text/plain", "x-sku": "A-1" },
        body: "application/json"
      })
    }))

  it.effect("does not wait out the response's delay", () =>
    // it.effect runs on a TestClock: a sleep here would never end
    Effect.gen(function*() {
      const preview = yield* previewStub(decodeCandidate({ responses: [{ status: 200, delay: 60000 }] }), groups)
      expect(preview).toMatchObject({ matched: 6, total: 6, sample: { response: { status: 200 } } })
    }))

  it.effect("gives no body for a status that cannot have one", () =>
    Effect.gen(function*() {
      const preview = yield* previewStub(decodeCandidate({ responses: [{ status: 204, body: "ignored" }] }), groups)
      expect(preview.sample?.response.status).toBe(204)
      expect(preview.sample?.response).not.toHaveProperty("body")
    }))

  it.effect("has no sample when nothing matches, or there is nothing to match", () =>
    Effect.gen(function*() {
      const candidate = decodeCandidate({
        predicates: [{ field: "method", operator: "equals", value: "DELETE" }],
        responses: [{ status: 200 }]
      })
      expect(yield* previewStub(candidate, groups)).toEqual({ matched: 0, total: 6 })
      expect(yield* previewStub(candidate, [])).toEqual({ matched: 0, total: 0 })
    }))

  it.effect("counts an invalid regex as no match and reports it", () =>
    Effect.gen(function*() {
      const preview = yield* previewStub(
        decodeCandidate({
          predicates: [{ field: "path", operator: "matches", value: "(" }],
          responses: [{ status: 200 }]
        }),
        groups
      )
      expect(preview.matched).toBe(0)
      expect(preview.total).toBe(6)
      expect(preview.sample).toBeUndefined()
      expect(preview.error).toMatch(/regular expression/i)
    }))

  it.effect("reports a response that cannot be built, with the counts still given", () =>
    Effect.gen(function*() {
      const preview = yield* previewStub(
        decodeCandidate({ responses: [{ status: 200, headers: { "bad header": "x" } }] }),
        groups
      )
      expect(preview).toMatchObject({ matched: 6, total: 6 })
      expect(preview.sample).toBeUndefined()
      expect(preview.error).toMatch(/^Response could not be built/)
    }))
})
