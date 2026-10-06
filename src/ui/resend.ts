import type { RequestLogEntry } from "../schemas/RequestLogSchema.js"

/**
 * A logged request sent again: as a curl command to copy, or replayed to the imposter itself.
 * Pure. The log keeps one value per header name (repeats arrive joined with ", ", as fetch joins
 * them) and one per query key, and a JSON body as parsed, so what is sent again is the same
 * request as far as matching can tell, not always the same bytes.
 */

type LoggedRequest = RequestLogEntry["request"]

/** The request's body as text: a string as it came, JSON as JSON; undefined when it had none or the log kept none */
export const bodyText = (body: unknown): string | undefined => {
  if (body === undefined) return undefined
  // A JSON body that was not valid JSON is kept as its text, and so is sent back verbatim
  return typeof body === "string" ? body : JSON.stringify(body)
}

const declaredLength = (headers: Readonly<Record<string, string>>): number | undefined => {
  const value = headers["content-length"]
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined
  return Number(value.trim())
}

/**
 * Whether the request had a body the log could not keep: the matcher keeps a body only when it
 * is UTF-8 text, so bytes that are not text leave it empty while the request declared a length
 * (or was chunked). The server never reads a GET or HEAD body, so one of those has none to keep.
 */
export const hasUnloggedBody = (request: LoggedRequest): boolean => {
  if (request.body !== undefined) return false
  const method = request.method.toUpperCase()
  if (method === "GET" || method === "HEAD") return false
  const length = declaredLength(request.headers)
  return (length !== undefined && length > 0) || request.headers["transfer-encoding"] !== undefined
}

/** The request's target: its path and its query string */
export const requestTarget = (request: LoggedRequest): string => {
  const query = new URLSearchParams(request.query).toString()
  return query === "" ? request.path : `${request.path}?${query}`
}

// ---------------------------------------------------------------- curl

// A word the shell reads as itself: no quoting needed
const SHELL_SAFE = /^[A-Za-z0-9@%+=:,./_-]+$/

/** One shell word: as it is when nothing in it is special, else in single quotes ('\'' for a quote) */
export const shellQuote = (value: string): string =>
  SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`

// curl sets these itself from the URL and the data, and a copied value would be wrong for it:
// the host of the address the copy is made for, the length of the body as curl sends it, the
// connection it opens. Accept-Encoding would have the server compress what curl then prints raw.
const CURL_SETS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "accept-encoding",
  "expect",
  "te",
  "upgrade",
  "proxy-connection",
  "trailer"
])

// curl reads [] and {} in a URL as ranges and sets unless told not to
const GLOB = /[[\]{}]/

const BINARY_FILE = "body.bin"

/**
 * The logged request as a curl command for `origin` (the imposter's address as the browser
 * reached it, e.g. "http://127.0.0.1:3001"), one option per line. Every word the shell would
 * read specially is single-quoted. A body that was not text is not in the log, so the command
 * reads it from a file and a comment above it says so.
 */
export const toCurl = (entry: RequestLogEntry, origin: string): string => {
  const { request } = entry
  const method = request.method.toUpperCase()
  const url = `${origin}${requestTarget(request)}`
  const text = bodyText(request.body)
  // A shell word cannot hold a NUL, so such a body goes the way of a binary one
  const binary = hasUnloggedBody(request) || (text !== undefined && text.includes("\u0000"))
  const data = binary
    ? `--data-binary @${BINARY_FILE}`
    : text === undefined
    ? undefined
    : `--data-raw ${shellQuote(text)}`

  // GET is curl's default and data makes it POST; HEAD needs --head, or curl waits for a body
  const methodFlag = method === "HEAD"
    ? "--head"
    : method === "GET"
    ? data === undefined ? undefined : "-X GET"
    : method === "POST" && data !== undefined
    ? undefined
    : `-X ${shellQuote(method)}`

  const first = [
    "curl",
    ...(GLOB.test(url) ? ["--globoff"] : []),
    ...(methodFlag === undefined ? [] : [methodFlag]),
    shellQuote(url)
  ]
    .join(" ")
  const headers = Object.entries(request.headers)
    .filter(([name]) => !CURL_SETS.has(name.toLowerCase()))
    .map(([name, value]) => `-H ${shellQuote(`${name}: ${value}`)}`)
  // With data and no content type, curl would send its own (a form's): an empty one removes it
  const sentType = Object.keys(request.headers).some((name) => name.toLowerCase() === "content-type")
  const noType = data !== undefined && !sentType ? ["-H 'content-type:'"] : []
  const command = [first, ...headers, ...noType, ...(data === undefined ? [] : [data])].join(" \\\n  ")
  return binary
    ? `# The body was not text, so the request log has no copy of it: save it as ${BINARY_FILE} first\n${command}`
    : command
}

// ---------------------------------------------------------------- replay

export type Replay =
  | { readonly _tag: "Ready"; readonly request: Request }
  | { readonly _tag: "Refused"; readonly reason: string }

const encoder = new TextEncoder()

/**
 * The logged request, ready to send again to the imposter at `origin`: the same method, path,
 * query and headers, and its body. A body the log could not keep cannot be replayed. The body
 * goes as bytes, so nothing adds a content type the request did not have; its length is the one
 * sent now (a JSON body is sent as parsed, which can change it), and the request is no longer
 * chunked.
 */
export const replayRequest = (entry: RequestLogEntry, origin: string): Replay => {
  const { request } = entry
  if (hasUnloggedBody(request)) {
    return {
      _tag: "Refused",
      reason: "This request's body was not text, so the request log has no copy of it to send again."
    }
  }
  const method = request.method.toUpperCase()
  const text = bodyText(request.body)
  const body = text === undefined || method === "GET" || method === "HEAD" ? undefined : encoder.encode(text)
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase()
    if (lower === "transfer-encoding" || lower === "content-length") continue
    headers.set(name, value)
  }
  if (body !== undefined) headers.set("content-length", String(body.byteLength))
  else if (request.headers["content-length"] !== undefined) headers.set("content-length", "0")
  try {
    return {
      _tag: "Ready",
      request: new Request(`${origin}${requestTarget(request)}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body })
      })
    }
  } catch (e) {
    return {
      _tag: "Refused",
      reason: `This request cannot be sent again: ${e instanceof Error ? e.message : String(e)}`
    }
  }
}
