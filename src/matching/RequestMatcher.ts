import type { Predicate, Stub } from "../schemas/StubSchema.js"

export interface RequestContext {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly query: Record<string, string>
  readonly body: unknown
}

export const extractRequestContext = async (request: Request): Promise<RequestContext> => {
  const url = new URL(request.url)
  const method = request.method.toUpperCase()
  const path = url.pathname

  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  const query: Record<string, string> = {}
  url.searchParams.forEach((value, key) => {
    query[key] = value
  })

  let body: unknown
  if (request.body) {
    const contentType = request.headers.get("content-type") ?? ""
    const text = await request.text()
    if (contentType.includes("application/json")) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    } else {
      body = text === "" ? undefined : text
    }
  }

  return { method, path, headers, query, body }
}

const normalize = (s: string, caseSensitive: boolean): string => caseSensitive ? s : s.toLowerCase()

const matchString = (
  actual: string,
  expected: unknown,
  operator: Predicate["operator"],
  caseSensitive: boolean
): boolean => {
  if (operator === "exists") return true
  if (typeof expected !== "string") return false
  const a = normalize(actual, caseSensitive)
  const e = normalize(expected, caseSensitive)
  switch (operator) {
    case "equals":
      return a === e
    case "contains":
      return a.includes(e)
    case "startsWith":
      return a.startsWith(e)
    case "matches": {
      const flags = caseSensitive ? "" : "i"
      return new RegExp(expected, flags).test(actual)
    }
  }
}

const matchObject = (
  actual: Record<string, string>,
  expected: unknown,
  operator: Predicate["operator"],
  caseSensitive: boolean
): boolean => {
  if (operator === "exists") {
    if (typeof expected !== "object" || expected === null) return true
    return Object.keys(expected as Record<string, unknown>).every((key) => key.toLowerCase() in actual || key in actual)
  }
  if (typeof expected !== "object" || expected === null) return false
  const entries = Object.entries(expected as Record<string, unknown>)
  return entries.every(([key, val]) => {
    const actualKey = Object.keys(actual).find(
      (k) => normalize(k, caseSensitive) === normalize(key, caseSensitive)
    )
    if (actualKey === undefined) return false
    const actualVal = actual[actualKey]!
    if (typeof val !== "string") return false
    return matchString(actualVal, val, operator, caseSensitive)
  })
}

const deepSubsetMatch = (actual: unknown, expected: unknown, caseSensitive: boolean): boolean => {
  if (expected === null || expected === undefined) return actual === expected
  if (typeof expected === "string" && typeof actual === "string") {
    return caseSensitive ? actual === expected : actual.toLowerCase() === expected.toLowerCase()
  }
  if (typeof expected === "number" || typeof expected === "boolean") return actual === expected
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false
    return expected.every((e, i) => i < actual.length && deepSubsetMatch(actual[i], e, caseSensitive))
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null) return false
    return Object.entries(expected as Record<string, unknown>).every(([key, val]) =>
      deepSubsetMatch((actual as Record<string, unknown>)[key], val, caseSensitive)
    )
  }
  return false
}

const matchBody = (
  actual: unknown,
  expected: unknown,
  operator: Predicate["operator"],
  caseSensitive: boolean
): boolean => {
  switch (operator) {
    case "exists":
      return actual !== null && actual !== undefined
    case "equals":
      return deepSubsetMatch(actual, expected, caseSensitive)
    case "contains": {
      const a = normalize(typeof actual === "string" ? actual : JSON.stringify(actual), caseSensitive)
      const e = normalize(typeof expected === "string" ? expected : JSON.stringify(expected), caseSensitive)
      return a.includes(e)
    }
    case "startsWith": {
      const a = normalize(typeof actual === "string" ? actual : JSON.stringify(actual), caseSensitive)
      const e = normalize(typeof expected === "string" ? expected : JSON.stringify(expected), caseSensitive)
      return a.startsWith(e)
    }
    case "matches": {
      const a = typeof actual === "string" ? actual : JSON.stringify(actual)
      const pattern = typeof expected === "string" ? expected : JSON.stringify(expected)
      const flags = caseSensitive ? "" : "i"
      return new RegExp(pattern, flags).test(a)
    }
  }
}

export const evaluatePredicate = (ctx: RequestContext, predicate: Predicate): boolean => {
  const { caseSensitive, field, operator, value } = predicate
  switch (field) {
    case "method":
      return matchString(ctx.method, value, operator, caseSensitive)
    case "path":
      return matchString(ctx.path, value, operator, caseSensitive)
    case "headers":
      return matchObject(ctx.headers, value, operator, caseSensitive)
    case "query":
      return matchObject(ctx.query, value, operator, caseSensitive)
    case "body":
      return matchBody(ctx.body, value, operator, caseSensitive)
  }
}

export const evaluatePredicates = (ctx: RequestContext, predicates: ReadonlyArray<Predicate>): boolean =>
  predicates.length === 0 || predicates.every((p) => evaluatePredicate(ctx, p))

export const findMatchingStub = (ctx: RequestContext, stubs: ReadonlyArray<Stub>): Stub | undefined =>
  stubs.find((stub) => evaluatePredicates(ctx, stub.predicates))
