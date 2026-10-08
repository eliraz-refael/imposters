/**
 * The playground's engine: the product's own matcher, templating and response cycling,
 * imported from the library source, so the playground answers exactly as an imposter does.
 *
 * It mirrors ImposterServer's stub path: decode the stubs with the API's schema, find the
 * first stub whose predicates match, pick the response by responseMode, then wait out its delay and
 * build it with the server's own serveResponse. Only the 404 body is restated here, because the
 * server builds it inline.
 */
import { Effect, Schema } from "effect"
import { extractRequestContext, findMatchingStub } from "../../../src/matching/RequestMatcher"
import { makeResponseState, serveResponse } from "../../../src/matching/ResponseGenerator"
import { requestOnly } from "../../../src/matching/TemplateEngine"
import { CreateStubRequest, Stub } from "../../../src/schemas/StubSchema"

export interface PlaygroundRequest {
  readonly method: string
  readonly path: string
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string
}

export interface PlaygroundResponse {
  readonly status: number
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string
  readonly matchedStub: number | undefined
  readonly elapsedMs: number
}

export type Loaded =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly error: string }

const decodeStubRequests = Schema.decodeUnknownSync(Schema.Array(CreateStubRequest))
const decodeStub = Schema.decodeUnknownSync(Stub)

const IMPOSTER_ID = "playground"

export const makePlayground = () => {
  let stubs: ReadonlyArray<Stub> = []
  let state = Effect.runSync(makeResponseState())

  /** Accepts the `stubs` array of a config file, or a single stub */
  const load = (source: string): Loaded => {
    let json: unknown
    try {
      json = JSON.parse(source)
    } catch (error) {
      return { ok: false, error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` }
    }
    try {
      const requests = decodeStubRequests(Array.isArray(json) ? json : [json])
      stubs = requests.map((request, i) => decodeStub({ id: String(i + 1), ...request }))
      // A new set of stubs starts every stub from its first response, as an imposter restart does
      state = Effect.runSync(makeResponseState())
      return { ok: true, count: stubs.length }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const send = async (input: PlaygroundRequest): Promise<PlaygroundResponse> => {
    const started = performance.now()
    const method = input.method.toUpperCase()
    const hasBody = method !== "GET" && method !== "HEAD" && input.body.length > 0
    const request = new Request(new URL(input.path || "/", "http://localhost:4000"), {
      method,
      headers: input.headers.filter(([name]) => name.trim().length > 0).map(([n, v]) => [n.trim(), v]),
      ...(hasBody ? { body: input.body } : {})
    })

    const ctx = await extractRequestContext(request)
    const stub = findMatchingStub(ctx, stubs)

    let response: Response
    if (stub === undefined) {
      response = new Response(
        JSON.stringify({ error: "No matching stub found", method: ctx.method, path: ctx.path }),
        { status: 404, headers: { "content-type": "application/json" } }
      )
    } else {
      const index = await Effect.runPromise(
        state.getNextIndex(IMPOSTER_ID, stub.id, stub.responses.length, stub.responseMode)
      )
      const config = stub.responses[index] ?? stub.responses[0]
      // The server's own delay (fixed or a range) and build. Callbacks never run here: the
      // templates see the request only, as in preview
      response = await Effect.runPromise(serveResponse(config, requestOnly(ctx)))
    }

    const headers: Array<readonly [string, string]> = []
    response.headers.forEach((value, name) => headers.push([name, value]))
    return {
      status: response.status,
      headers,
      body: await response.text(),
      matchedStub: stub === undefined ? undefined : stubs.indexOf(stub) + 1,
      elapsedMs: Math.round(performance.now() - started)
    }
  }

  return { load, send }
}
