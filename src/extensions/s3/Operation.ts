/**
 * Request → S3 operation. A path-style request (`/<bucket>/<key>`) is routed through a table
 * keyed by method × target (service, bucket, object) × subresource (`?delete`, `?versioning`, ...).
 * Anything the table does not name, and any query parameter a route does not accept, is a
 * 501 NotImplemented: the emulator never guesses at an operation it does not serve.
 */
import * as Data from "effect/Data"
import * as Result from "effect/Result"
import type { RequestContext } from "../../matching/RequestMatcher.js"
import { bucketResource, notImplemented, objectResource, S3Error } from "./S3Error.js"
import { parseDeleteRequest } from "./Xml.js"

export type Operation = Data.TaggedEnum<{
  ListBuckets: Record<never, never>
  CreateBucket: { readonly bucket: string }
  HeadBucket: { readonly bucket: string }
  DeleteBucket: { readonly bucket: string }
  GetBucketVersioning: { readonly bucket: string }
  /** Accepted and discarded: nothing is stored or enforced */
  PutBucketOwnershipControls: { readonly bucket: string }
  /** Accepted and discarded: nothing is stored or enforced */
  PutBucketPolicy: { readonly bucket: string }
  ListObjectsV2: {
    readonly bucket: string
    readonly prefix: string
    readonly maxKeys: number
    /** `encoding-type=url`: keys and prefix are URL-encoded in the answer */
    readonly urlEncoded: boolean
    /** `fetch-owner=true`: each listed object carries its Owner */
    readonly fetchOwner: boolean
  }
  PutObject: {
    readonly bucket: string
    readonly key: string
    readonly body: Uint8Array<ArrayBuffer>
    readonly contentType: string
  }
  GetObject: { readonly bucket: string; readonly key: string; readonly ifNoneMatch: string | undefined }
  HeadObject: { readonly bucket: string; readonly key: string; readonly ifNoneMatch: string | undefined }
  CopyObject: {
    readonly bucket: string
    readonly key: string
    readonly sourceBucket: string
    readonly sourceKey: string
  }
  DeleteObject: { readonly bucket: string; readonly key: string }
  DeleteObjects: { readonly bucket: string; readonly keys: ReadonlyArray<string>; readonly quiet: boolean }
}>

export const Operation = Data.taggedEnum<Operation>()

/** The content type S3 gives an object stored without one */
export const DEFAULT_CONTENT_TYPE = "binary/octet-stream"
/** S3 caps a listing page at 1000 keys, whatever max-keys asks for */
export const MAX_KEYS_LIMIT = 1000
/** S3 keys are at most 1024 bytes of UTF-8 */
export const MAX_KEY_BYTES = 1024
/** DeleteObjects takes at most 1000 keys */
export const MAX_DELETE_KEYS = 1000

export const keyTooLong = (key: string): boolean => new TextEncoder().encode(key).length > MAX_KEY_BYTES

// The SDK tags most requests with `?x-id=<Operation>`; it carries no meaning
const IGNORED_PARAMS: ReadonlyArray<string> = ["x-id"]

interface ServiceTarget {
  readonly _tag: "Service"
  readonly resource: string
}
interface BucketTarget {
  readonly _tag: "Bucket"
  readonly bucket: string
  readonly resource: string
}
interface ObjectTarget {
  readonly _tag: "Object"
  readonly bucket: string
  readonly key: string
  readonly resource: string
}
type Target = ServiceTarget | BucketTarget | ObjectTarget

interface Route<T extends Target> {
  /** The S3 operation name, for error messages */
  readonly name: string
  readonly method: string
  /** A query key that selects this route, e.g. `delete` for `?delete` */
  readonly subresource?: string
  /** A header that selects this route, e.g. `x-amz-copy-source` for CopyObject */
  readonly header?: string
  /** Query parameters the route understands, besides its subresource */
  readonly params?: ReadonlyArray<string>
  /** Headers the route does not implement: their presence is a 501, not a silently wrong answer */
  readonly unsupportedHeaders?: ReadonlyArray<string>
  readonly parse: (target: T, ctx: RequestContext) => Result.Result<Operation, S3Error>
}

const ok = Result.succeed

const invalid = (code: S3Error["code"], message: string, resource: string): Result.Result<never, S3Error> =>
  Result.fail(new S3Error({ code, message, resource }))

// Bucket naming rules, minus the IP-address check: 3-63 of [a-z0-9.-], alphanumeric at both ends, no ".."
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
export const isValidBucketName = (name: string): boolean => BUCKET_NAME.test(name) && !name.includes("..")

const objectKeyChecked = (
  target: ObjectTarget,
  make: (target: ObjectTarget) => Operation
): Result.Result<Operation, S3Error> =>
  keyTooLong(target.key)
    ? invalid("KeyTooLongError", "Your key is too long", target.resource)
    : ok(make(target))

const parseMaxKeys = (raw: string | undefined, resource: string): Result.Result<number, S3Error> => {
  if (raw === undefined) return ok(MAX_KEYS_LIMIT)
  if (!/^[0-9]+$/.test(raw)) {
    return invalid("InvalidArgument", "Provided max-keys not an integer or within integer range", resource)
  }
  return ok(Math.min(Number(raw), MAX_KEYS_LIMIT))
}

const decodeUri = (raw: string): string | undefined => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

// `x-amz-copy-source` is `[/]<bucket>/<key>[?versionId=...]`, URL-encoded
const parseCopySource = (
  raw: string,
  resource: string
): Result.Result<{ readonly bucket: string; readonly key: string }, S3Error> => {
  const [path = "", query] = raw.split("?", 2)
  if (query !== undefined) return Result.fail(notImplemented("Copying from a version (?versionId)", resource))
  const decoded = decodeUri(path.startsWith("/") ? path.slice(1) : path)
  const slash = decoded?.indexOf("/") ?? -1
  if (decoded === undefined || slash <= 0 || slash === decoded.length - 1) {
    return invalid(
      "InvalidArgument",
      "Copy Source must mention the source bucket and key: sourcebucket/sourcekey",
      resource
    )
  }
  return ok({ bucket: decoded.slice(0, slash), key: decoded.slice(slash + 1) })
}

const CONDITIONAL_READ_HEADERS = ["if-match", "if-modified-since", "if-unmodified-since", "range"]

const serviceRoutes: ReadonlyArray<Route<ServiceTarget>> = [
  { name: "ListBuckets", method: "GET", parse: () => ok(Operation.ListBuckets()) }
]

const bucketRoutes: ReadonlyArray<Route<BucketTarget>> = [
  {
    name: "CreateBucket",
    method: "PUT",
    parse: ({ bucket, resource }) =>
      isValidBucketName(bucket)
        ? ok(Operation.CreateBucket({ bucket }))
        : invalid("InvalidBucketName", "The specified bucket is not valid.", resource)
  },
  { name: "HeadBucket", method: "HEAD", parse: ({ bucket }) => ok(Operation.HeadBucket({ bucket })) },
  { name: "DeleteBucket", method: "DELETE", parse: ({ bucket }) => ok(Operation.DeleteBucket({ bucket })) },
  {
    name: "GetBucketVersioning",
    method: "GET",
    subresource: "versioning",
    parse: ({ bucket }) => ok(Operation.GetBucketVersioning({ bucket }))
  },
  {
    name: "PutBucketOwnershipControls",
    method: "PUT",
    subresource: "ownershipControls",
    parse: ({ bucket }) => ok(Operation.PutBucketOwnershipControls({ bucket }))
  },
  {
    name: "PutBucketPolicy",
    method: "PUT",
    subresource: "policy",
    parse: ({ bucket }) => ok(Operation.PutBucketPolicy({ bucket }))
  },
  {
    name: "ListObjectsV2",
    method: "GET",
    subresource: "list-type",
    params: ["prefix", "max-keys", "encoding-type", "fetch-owner"],
    parse: ({ bucket, resource }, ctx) => {
      if (ctx.query["list-type"] !== "2") return Result.fail(notImplemented("ListObjects (v1)", resource))
      const encoding = ctx.query["encoding-type"]
      if (encoding !== undefined && encoding !== "url") {
        return invalid("InvalidArgument", "Invalid Encoding Method specified in Request", resource)
      }
      return Result.map(parseMaxKeys(ctx.query["max-keys"], resource), (maxKeys) =>
        Operation.ListObjectsV2({
          bucket,
          prefix: ctx.query["prefix"] ?? "",
          maxKeys,
          urlEncoded: encoding === "url",
          fetchOwner: (ctx.query["fetch-owner"] ?? "").toLowerCase() === "true"
        }))
    }
  },
  {
    name: "DeleteObjects",
    method: "POST",
    subresource: "delete",
    parse: ({ bucket, resource }, ctx) => {
      const malformed = (why: string) =>
        invalid(
          "MalformedXML",
          `The XML you provided was not well-formed or did not validate against our published schema: ${why}`,
          resource
        )
      return Result.match(parseDeleteRequest(new TextDecoder().decode(ctx.rawBody)), {
        onFailure: malformed,
        onSuccess: ({ keys, quiet }) =>
          keys.length === 0
            ? malformed("no Object to delete")
            : keys.length > MAX_DELETE_KEYS
            ? malformed(`more than ${MAX_DELETE_KEYS} objects`)
            : ok(Operation.DeleteObjects({ bucket, keys, quiet }))
      })
    }
  }
]

const objectRoutes: ReadonlyArray<Route<ObjectTarget>> = [
  {
    name: "PutObject",
    method: "PUT",
    unsupportedHeaders: ["if-match", "if-none-match"],
    parse: (target, ctx) =>
      objectKeyChecked(target, ({ bucket, key }) =>
        Operation.PutObject({
          bucket,
          key,
          // A copy, so the stored bytes never alias the request's buffer
          body: ctx.rawBody.slice(),
          contentType: ctx.headers["content-type"] ?? DEFAULT_CONTENT_TYPE
        }))
  },
  {
    name: "CopyObject",
    method: "PUT",
    header: "x-amz-copy-source",
    unsupportedHeaders: [
      "x-amz-copy-source-if-match",
      "x-amz-copy-source-if-none-match",
      "x-amz-copy-source-if-modified-since",
      "x-amz-copy-source-if-unmodified-since"
    ],
    parse: (target, ctx) => {
      const directive = (ctx.headers["x-amz-metadata-directive"] ?? "COPY").toUpperCase()
      if (directive !== "COPY") {
        return Result.fail(notImplemented(`CopyObject with metadata directive ${directive}`, target.resource))
      }
      return Result.flatMap(
        parseCopySource(ctx.headers["x-amz-copy-source"] ?? "", target.resource),
        (source) =>
          source.bucket === target.bucket && source.key === target.key
            ? invalid(
              "InvalidRequest",
              "This copy request is illegal because it is trying to copy an object to itself without changing the object's metadata, storage class, website redirect location or encryption attributes.",
              target.resource
            )
            : objectKeyChecked(target, ({ bucket, key }) =>
              Operation.CopyObject({ bucket, key, sourceBucket: source.bucket, sourceKey: source.key }))
      )
    }
  },
  {
    name: "GetObject",
    method: "GET",
    unsupportedHeaders: CONDITIONAL_READ_HEADERS,
    parse: ({ bucket, key }, ctx) => ok(Operation.GetObject({ bucket, key, ifNoneMatch: ctx.headers["if-none-match"] }))
  },
  {
    name: "HeadObject",
    method: "HEAD",
    unsupportedHeaders: CONDITIONAL_READ_HEADERS,
    parse: ({ bucket, key }, ctx) =>
      ok(Operation.HeadObject({ bucket, key, ifNoneMatch: ctx.headers["if-none-match"] }))
  },
  { name: "DeleteObject", method: "DELETE", parse: ({ bucket, key }) => ok(Operation.DeleteObject({ bucket, key })) }
]

// Splits `/<bucket>/<key>` (path-style); each part is URL-decoded
const parseTarget = (path: string): Result.Result<Target, S3Error> => {
  const rest = path.startsWith("/") ? path.slice(1) : path
  if (rest === "") return ok({ _tag: "Service", resource: "/" })
  const slash = rest.indexOf("/")
  const bucket = decodeUri(slash === -1 ? rest : rest.slice(0, slash))
  const key = decodeUri(slash === -1 ? "" : rest.slice(slash + 1))
  if (bucket === undefined || key === undefined) {
    return invalid("InvalidURI", "Couldn't parse the specified URI.", path)
  }
  return key === ""
    ? ok({ _tag: "Bucket", bucket, resource: bucketResource(bucket) })
    : ok({ _tag: "Object", bucket, key, resource: objectResource(bucket, key) })
}

const has = (record: Record<string, string>, name: string): boolean => Object.hasOwn(record, name)

// A route matches when its selectors are present; the most specific match wins
const specificity = <T extends Target>(route: Route<T>): number =>
  (route.subresource !== undefined ? 2 : 0) + (route.header !== undefined ? 1 : 0)

const dispatch = <T extends Target>(
  routes: ReadonlyArray<Route<T>>,
  target: T,
  ctx: RequestContext
): Result.Result<Operation, S3Error> => {
  const route = routes
    .filter((r) =>
      r.method === ctx.method &&
      (r.subresource === undefined || has(ctx.query, r.subresource)) &&
      (r.header === undefined || has(ctx.headers, r.header))
    )
    .reduce<Route<T> | undefined>(
      (best, r) => best === undefined || specificity(r) > specificity(best) ? r : best,
      undefined
    )
  if (route === undefined) {
    const subresources = Object.keys(ctx.query).filter((k) => !IGNORED_PARAMS.includes(k))
    const what = subresources.length > 0 ? ` ?${subresources.join("&")}` : ""
    return Result.fail(notImplemented(`${ctx.method} on a ${target._tag.toLowerCase()}${what}`, target.resource))
  }
  const accepted = [
    ...IGNORED_PARAMS,
    ...(route.subresource !== undefined ? [route.subresource] : []),
    ...(route.params ?? [])
  ]
  const unaccepted = Object.keys(ctx.query).filter((k) => !accepted.includes(k))
  if (unaccepted.length > 0) {
    return Result.fail(notImplemented(`${route.name} with ?${unaccepted.join("&")}`, target.resource))
  }
  const unsupported = (route.unsupportedHeaders ?? []).filter((h) => has(ctx.headers, h))
  if (unsupported.length > 0) {
    return Result.fail(notImplemented(`${route.name} with the ${unsupported.join(", ")} header`, target.resource))
  }
  return route.parse(target, ctx)
}

const isPresigned = (ctx: RequestContext): boolean =>
  has(ctx.query, "X-Amz-Signature") || has(ctx.query, "X-Amz-Algorithm")

// aws-chunked bodies interleave chunk signatures with the payload; storing them raw would corrupt the object
const isChunkedUpload = (ctx: RequestContext): boolean =>
  (ctx.headers["x-amz-content-sha256"] ?? "").startsWith("STREAMING-") ||
  (ctx.headers["content-encoding"] ?? "").split(",").some((e) => e.trim() === "aws-chunked")

// The access key id a SigV4 (`Credential=<akid>/<date>/...`) or SigV2 (`AWS <akid>:<sig>`) header signs with
export const accessKeyOf = (authorization: string | undefined): string | undefined =>
  authorization === undefined
    ? undefined
    : (/Credential=([^/,\s]+)\//.exec(authorization) ?? /^AWS ([^:\s]+):/.exec(authorization))?.[1]

const OWNER_HEADERS = ["x-amz-expected-bucket-owner", "x-amz-source-expected-bucket-owner"]

/**
 * The expected-owner check, stateless: every bucket belongs to whoever asks, so an expected
 * owner other than the requester's access key id is 403 AccessDenied, as S3 answers a
 * mismatch. (Real S3 compares account ids; locally the access key id stands in for one.)
 * An unsigned request has no requester to compare with, so it is not checked.
 */
const ownerRefusal = (ctx: RequestContext, resource: string): S3Error | undefined => {
  const requester = accessKeyOf(ctx.headers["authorization"])
  if (requester === undefined) return undefined
  const mismatched = OWNER_HEADERS.some((h) => {
    const expected = ctx.headers[h]
    return expected !== undefined && expected !== requester
  })
  return mismatched ? new S3Error({ code: "AccessDenied", message: "Access Denied", resource }) : undefined
}

/** Which S3 operation a request is, or the S3 error to answer instead */
export const parseOperation = (ctx: RequestContext): Result.Result<Operation, S3Error> =>
  Result.flatMap(parseTarget(ctx.path), (target): Result.Result<Operation, S3Error> => {
    // Authorization comes first, as on S3: a foreign owner learns nothing about the request
    const refusal = ownerRefusal(ctx, target.resource)
    if (refusal !== undefined) return Result.fail(refusal)
    if (isPresigned(ctx)) return Result.fail(notImplemented("Presigned URL authentication", target.resource))
    if (isChunkedUpload(ctx)) return Result.fail(notImplemented("aws-chunked (STREAMING-*) payloads", target.resource))
    switch (target._tag) {
      case "Service":
        return dispatch(serviceRoutes, target, ctx)
      case "Bucket":
        return dispatch(bucketRoutes, target, ctx)
      case "Object":
        return dispatch(objectRoutes, target, ctx)
    }
  })
