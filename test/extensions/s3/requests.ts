import * as Schema from "effect/Schema"
import type { RequestContext } from "imposters/matching/RequestMatcher"

// Request contexts as the imposter runtime would build them for an S3 extension

export interface RequestOptions {
  readonly query?: Record<string, string>
  readonly headers?: Record<string, string>
  readonly body?: Uint8Array | string
}

const bytesOf = (body: Uint8Array | string | undefined): Uint8Array<ArrayBuffer> =>
  body === undefined
    ? new Uint8Array(0)
    : typeof body === "string"
    ? new TextEncoder().encode(body)
    : new Uint8Array(body)

export const request = (method: string, path: string, options: RequestOptions = {}): RequestContext => ({
  method,
  path,
  query: options.query ?? {},
  headers: options.headers ?? {},
  body: undefined,
  rawBody: bytesOf(options.body)
})

/** A path segment as the SDK encodes it: everything but unreserved characters and `/` */
export const encodeKey = (key: string): string => key.split("/").map(encodeURIComponent).join("/")

const roundTripsUtf8 = (s: string): boolean => new TextDecoder().decode(new TextEncoder().encode(s)) === s

/** Strings a URL path or an XML document can carry: well-formed UTF-16, no lone surrogates */
export const WellFormedString = Schema.String.check(Schema.makeFilter(roundTripsUtf8))

/** A non-empty object key of at most 1024 UTF-8 bytes */
export const ObjectKey = WellFormedString.check(
  Schema.isMinLength(1),
  Schema.makeFilter((s: string) => new TextEncoder().encode(s).length <= 1024)
)

export const xmlDeleteBody = (keys: ReadonlyArray<string>, quiet?: boolean, escape = (s: string) => s): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
  keys.map((k) => `<Object><Key>${escape(k)}</Key></Object>`).join("") +
  (quiet === undefined ? "" : `<Quiet>${quiet}</Quiet>`) +
  `</Delete>`
