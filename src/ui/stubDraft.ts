import type { CreateStubRequest, Stub } from "../schemas/StubSchema.js"

/**
 * Stub drafts: what the stubs page's editor starts from. "Stub it" drafts a stub for a request no
 * stub matched; a new stub starts from a starter; an edit starts from the stub. Pure, and in the
 * encoded (JSON) shape, since that is what the editor shows and posts.
 */

export type StubDraft = typeof CreateStubRequest.Encoded

// A method is an HTTP token; the UI only offers letters (GET, POST, PROPFIND...)
const METHOD = /^[A-Za-z]{1,20}$/
const MAX_PATH = 2048

/** A stub answering `method path` with an empty JSON 200, for the user to fill in */
export const draftStubFrom = (method: string, path: string): StubDraft => ({
  predicates: [
    { field: "method", operator: "equals", value: method.toUpperCase() },
    { field: "path", operator: "equals", value: path }
  ],
  responses: [{ status: 200, headers: { "content-type": "application/json" }, body: {} }],
  responseMode: "sequential"
})

/** What "new stub" starts from: a GET of / answered with an empty JSON 200 */
export const starterDraft = (): StubDraft => draftStubFrom("GET", "/")

/**
 * A stub as the editor shows it: its predicates, responses and mode, with each predicate's
 * `caseSensitive` left out where it is the default (true), so it reads as it was likely written
 */
export const draftFromStub = (stub: Stub): StubDraft => ({
  predicates: stub.predicates.map(({ caseSensitive, ...rest }) => caseSensitive ? rest : { ...rest, caseSensitive }),
  responses: stub.responses,
  responseMode: stub.responseMode
})

/** The stubs page with the editor prefilled for `method path` */
export const draftStubUrl = (method: string, path: string): string =>
  `/_admin/stubs?${new URLSearchParams({ draft: method.toUpperCase(), path }).toString()}`

/** A draft with the request it was made for */
export interface DraftRequest {
  readonly method: string
  readonly path: string
  readonly stub: StubDraft
}

/**
 * The draft a stubs page URL asks for (`?draft=<method>&path=<path>`), or null when there is
 * none or it is not a method and an absolute path
 */
export const draftFromQuery = (params: URLSearchParams): DraftRequest | null => {
  const method = params.get("draft")
  const path = params.get("path")
  if (method === null || path === null || !METHOD.test(method)) return null
  if (!path.startsWith("/") || path.length > MAX_PATH) return null
  return { method: method.toUpperCase(), path, stub: draftStubFrom(method, path) }
}
