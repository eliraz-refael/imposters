import type * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import { PredicateField, PredicateOperator, ResponseMode } from "./StubSchema.js"

/**
 * Schema errors in plain English. The schema's own wording (`Expected number | undefined at
 * ["responses"][0]["status"]`) is accurate but reads as a puzzle; these say what the field is
 * and give an example. Pure. The stub editor uses `stubIssueMessages`; the admin API's 400
 * bodies could use it too.
 */

/** A path into the input: ["responses", 0, "status"] */
export type IssuePath = ReadonlyArray<string | number>

/** One problem with the input: where, and what to do about it */
export interface IssueMessage {
  readonly path: IssuePath
  readonly message: string
}

/** What a describer gets for each issue the schema reported */
export interface ReportedIssue {
  readonly path: IssuePath
  // Whether the input has a value at the path (a missing key has none)
  readonly present: boolean
  readonly value: unknown
  // The schema's own message, for anything a describer does not recognise
  readonly schemaMessage: string
}

export type Describe = (issue: ReportedIssue) => string

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** A path as a reader writes it: responses[0].status, headers["content-type"]; the root is "" */
export const formatPath = (path: IssuePath): string =>
  path.reduce<string>((key, segment) => {
    if (typeof segment === "number") return `${key}[${String(segment)}]`
    if (IDENTIFIER.test(segment)) return key === "" ? segment : `${key}.${segment}`
    return `${key}[${JSON.stringify(segment)}]`
  }, "")

const segmentOf = (segment: PropertyKey | { readonly key: PropertyKey }): string | number => {
  const key = typeof segment === "object" ? segment.key : segment
  return typeof key === "symbol" ? String(key) : key
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const valueAt = (input: unknown, path: IssuePath): { readonly present: boolean; readonly value: unknown } => {
  let value = input
  for (const segment of path) {
    if (Array.isArray(value) && typeof segment === "number" && segment < value.length) {
      value = value[segment]
    } else if (isRecord(value) && typeof segment === "string" && Object.hasOwn(value, segment)) {
      value = value[segment]
    } else {
      return { present: false, value: undefined }
    }
  }
  return { present: true, value }
}

const formatter = SchemaIssue.makeFormatterStandardSchemaV1()

/**
 * Every issue in a schema error, described by `describe`, one message per path (a union reports
 * a path once per member it tried), in the order the schema reported them
 */
export const issueMessages = (
  error: Schema.SchemaError,
  input: unknown,
  describe: Describe
): ReadonlyArray<IssueMessage> => {
  const seen = new Set<string>()
  const messages: Array<IssueMessage> = []
  for (const issue of formatter(error.issue).issues) {
    const path = (issue.path ?? []).map(segmentOf)
    const message = describe({ path, ...valueAt(input, path), schemaMessage: issue.message })
    const key = `${formatPath(path)}\u0000${message}`
    if (seen.has(key)) continue
    seen.add(key)
    messages.push({ path, message })
  }
  return messages
}

// ---------------------------------------------------------------- stubs

const MAX_SHOWN = 40

// A value as the user typed it, shortened: "ok", 99, { ... }
const shown = (value: unknown): string => {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN - 1)}…` : text
}

// "method, path, headers, query or body"
const oneOf = (options: ReadonlyArray<string>): string =>
  options.length < 2 ? options.join("") : `${options.slice(0, -1).join(", ")} or ${options.at(-1) ?? ""}`

const got = (issue: ReportedIssue): string => issue.present ? `, not ${shown(issue.value)}` : ""

const FIELDS = PredicateField.literals
const OPERATORS = PredicateOperator.literals
const MODES = ResponseMode.literals

const RESPONSE_EXAMPLE = `{ "status": 200, "body": "ok" }`
const PREDICATE_EXAMPLE = `{ "field": "path", "operator": "equals", "value": "/orders" }`

const describeRoot = (issue: ReportedIssue): string =>
  Array.isArray(issue.value)
    ? `a stub is one JSON object, not a list: add stubs one at a time, like { "responses": [${RESPONSE_EXAMPLE}] }`
    : `a stub is a JSON object with predicates and responses, like { "responses": [${RESPONSE_EXAMPLE}] }`

const describeResponses = (issue: ReportedIssue, input: unknown): string => {
  if (!issue.present) {
    const typo = isRecord(input) && Object.hasOwn(input, "response") ? ` (there is a "response": rename it)` : ""
    return `responses is missing: a stub needs a list of at least one response, like "responses": [${RESPONSE_EXAMPLE}]${typo}`
  }
  return `responses must be a list of responses, like [${RESPONSE_EXAMPLE}]${got(issue)}`
}

const describeDelay = (issue: ReportedIssue, at: string, response: unknown): string => {
  const delay = isRecord(response) ? response.delay : undefined
  if (isRecord(delay) && typeof delay.min === "number" && typeof delay.max === "number" && delay.min > delay.max) {
    return `${at}: max (${String(delay.max)}) must be at least min (${String(delay.min)})`
  }
  if (isRecord(delay)) {
    return `${at} must be a range of whole milliseconds from 0 to 60000, like { "min": 100, "max": 500 }${
      got({ ...issue, value: delay })
    }`
  }
  return `${at} must be a whole number of milliseconds from 0 to 60000 (a minute), like 2000, or a range like { "min": 100, "max": 500 }${
    got(issue)
  }`
}

const describeResponse = (issue: ReportedIssue, input: unknown, index: number, rest: IssuePath): string => {
  const at = formatPath(["responses", index, ...rest])
  const response = valueAt(input, ["responses", index]).value
  const [field] = rest
  if (field === undefined) {
    // The schema reports an empty list as a missing first item
    if (!issue.present && index === 0) return `responses is empty: add at least one response, like ${RESPONSE_EXAMPLE}`
    return `${at} must be an object, like ${RESPONSE_EXAMPLE}${got(issue)}`
  }
  switch (field) {
    case "status":
      return `${at} must be an HTTP status code (100–599), like 200${got(issue)}`
    case "headers":
      return rest.length === 1
        ? `${at} must be an object of header names and values, like { "content-type": "application/json" }${got(issue)}`
        : `${at} must be text, like "application/json"${got(issue)}`
    case "delay":
      return describeDelay(issue, formatPath(["responses", index, "delay"]), response)
    default:
      return `${at}: ${issue.schemaMessage.toLowerCase()}`
  }
}

const describePredicate = (issue: ReportedIssue, index: number, rest: IssuePath): string => {
  const at = formatPath(["predicates", index, ...rest])
  const [field] = rest
  switch (field) {
    case undefined:
      return `${at} must be an object, like ${PREDICATE_EXAMPLE}${got(issue)}`
    case "field":
      return issue.present
        ? `${at} must be one of ${oneOf(FIELDS)}${got(issue)}`
        : `${formatPath(["predicates", index])} needs a "field": one of ${oneOf(FIELDS)}`
    case "operator":
      return issue.present
        ? `${at} must be one of ${oneOf(OPERATORS)}${got(issue)}`
        : `${formatPath(["predicates", index])} needs an "operator": one of ${oneOf(OPERATORS)}`
    case "value":
      return `${formatPath(["predicates", index])} needs a "value" to compare with, like "/orders"`
    case "caseSensitive":
      return `${at} must be true or false${got(issue)}`
    default:
      return `${at}: ${issue.schemaMessage.toLowerCase()}`
  }
}

/** The plain-English message for one issue of a stub (CreateStubRequest, the editor's JSON) */
export const describeStubIssue = (input: unknown): Describe => (issue) => {
  const [head, index, ...rest] = issue.path
  if (head === undefined) return describeRoot(issue)
  if (head === "responses") {
    return typeof index === "number" ? describeResponse(issue, input, index, rest) : describeResponses(issue, input)
  }
  if (head === "predicates") {
    if (typeof index === "number") return describePredicate(issue, index, rest)
    return `predicates must be a list of conditions, like [${PREDICATE_EXAMPLE}] (or [] to match every request)${
      got(issue)
    }`
  }
  if (head === "responseMode") return `responseMode must be one of ${oneOf(MODES)}${got(issue)}`
  return `${formatPath(issue.path)}: ${issue.schemaMessage.toLowerCase()}`
}

/** Every problem with a stub the schema refused, in plain English */
export const stubIssueMessages = (error: Schema.SchemaError, input: unknown): ReadonlyArray<IssueMessage> =>
  issueMessages(error, input, describeStubIssue(input))
