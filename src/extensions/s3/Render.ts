/**
 * Kernel answers → HTTP responses: S3's XML bodies, headers and status codes.
 */
import * as DateTime from "effect/DateTime"
import * as Result from "effect/Result"
import type { S3Reply, StoredObject } from "./Kernel"
import { errorStatus, type S3Error } from "./S3Error"
import { element, renderDocument, S3_XMLNS, type XmlElement } from "./Xml"

/** Answers every request from region us-east-1, the region path-style clients assume */
export const REGION = "us-east-1"
const OWNER = element("Owner", [element("ID", "imposters"), element("DisplayName", "imposters")])

export interface RenderContext {
  readonly requestId: string
  /** A HEAD request: errors and objects go out without a body */
  readonly head: boolean
}

const httpDate = (dt: DateTime.Utc): string => DateTime.toDateUtc(dt).toUTCString()
const isoDate = (dt: DateTime.Utc): string => DateTime.formatIso(dt)

// `encoding-type=url` answers with keys URL-encoded, spaces as `+`
const urlEncode = (s: string): string => encodeURIComponent(s).replaceAll("%20", "+")

const xmlResponse = (root: XmlElement, ctx: RenderContext, status = 200): Response => {
  const bytes = new TextEncoder().encode(renderDocument(root))
  return new Response(bytes, {
    status,
    headers: {
      "content-type": "application/xml",
      "content-length": String(bytes.length),
      "x-amz-request-id": ctx.requestId
    }
  })
}

const emptyResponse = (status: number, ctx: RenderContext, headers: Record<string, string> = {}): Response =>
  new Response(null, {
    status,
    headers: status === 204 || status === 304
      ? { ...headers, "x-amz-request-id": ctx.requestId }
      : { ...headers, "content-length": "0", "x-amz-request-id": ctx.requestId }
  })

// No checksum headers: the SDK validates any it is given, and the emulator computes none
const objectHeaders = (object: StoredObject): Record<string, string> => ({
  "etag": object.etag,
  "last-modified": httpDate(object.lastModified)
})

const objectResponse = (object: StoredObject, ctx: RenderContext, head: boolean): Response =>
  new Response(head ? null : object.body, {
    status: 200,
    headers: {
      ...objectHeaders(object),
      "content-type": object.contentType,
      "content-length": String(object.body.length),
      "x-amz-request-id": ctx.requestId
    }
  })

const renderReply = (reply: S3Reply, ctx: RenderContext): Response => {
  switch (reply._tag) {
    case "BucketList":
      return xmlResponse(
        element("ListAllMyBucketsResult", [
          OWNER,
          element(
            "Buckets",
            reply.buckets.map((b) =>
              element("Bucket", [element("Name", b.name), element("CreationDate", isoDate(b.createdAt))])
            )
          )
        ], { xmlns: S3_XMLNS }),
        ctx
      )
    case "BucketCreated":
      return emptyResponse(200, ctx, { location: `/${reply.bucket}` })
    case "BucketFound":
      return emptyResponse(200, ctx, { "x-amz-bucket-region": REGION })
    case "BucketDeleted":
      return emptyResponse(204, ctx)
    case "VersioningNeverEnabled":
      return xmlResponse(element("VersioningConfiguration", [], { xmlns: S3_XMLNS }), ctx)
    // S3 answers PutBucketOwnershipControls with 200, PutBucketPolicy with 204
    case "OwnershipControlsAccepted":
      return emptyResponse(200, ctx)
    case "PolicyAccepted":
      return emptyResponse(204, ctx)
    case "ObjectListing": {
      const text = (s: string) => reply.urlEncoded ? urlEncode(s) : s
      return xmlResponse(
        element("ListBucketResult", [
          element("Name", reply.bucket),
          element("Prefix", text(reply.prefix)),
          element("KeyCount", String(reply.objects.length)),
          element("MaxKeys", String(reply.maxKeys)),
          reply.urlEncoded ? element("EncodingType", "url") : undefined,
          element("IsTruncated", "false"),
          ...reply.objects.map(({ key, object }) =>
            element("Contents", [
              element("Key", text(key)),
              element("LastModified", isoDate(object.lastModified)),
              element("ETag", object.etag),
              element("Size", String(object.body.length)),
              element("StorageClass", "STANDARD"),
              reply.fetchOwner ? OWNER : undefined
            ])
          )
        ], { xmlns: S3_XMLNS }),
        ctx
      )
    }
    case "ObjectStored":
      return emptyResponse(200, ctx, { etag: reply.object.etag })
    case "ObjectFound":
      return objectResponse(reply.object, ctx, reply.head)
    case "ObjectNotModified":
      return emptyResponse(304, ctx, objectHeaders(reply.object))
    case "ObjectCopied":
      return xmlResponse(
        element("CopyObjectResult", [
          element("LastModified", isoDate(reply.object.lastModified)),
          element("ETag", reply.object.etag)
        ], { xmlns: S3_XMLNS }),
        ctx
      )
    case "ObjectDeleted":
      return emptyResponse(204, ctx)
    case "ObjectsDeleted":
      return xmlResponse(
        element("DeleteResult", [
          ...(reply.quiet ? [] : reply.deleted.map((key) => element("Deleted", [element("Key", key)]))),
          ...reply.errors.map((e) =>
            element("Error", [element("Key", e.key), element("Code", e.code), element("Message", e.message)])
          )
        ], { xmlns: S3_XMLNS }),
        ctx
      )
  }
}

/** An S3 error: the `<Error>` document, or only the status and headers for a HEAD request */
export const renderError = (error: S3Error, ctx: RenderContext): Response => {
  const status = errorStatus[error.code]
  if (ctx.head) return emptyResponse(status, ctx)
  return xmlResponse(
    element("Error", [
      element("Code", error.code),
      element("Message", error.message),
      element("Resource", error.resource),
      element("RequestId", ctx.requestId)
    ]),
    ctx,
    status
  )
}

export const render = (result: Result.Result<S3Reply, S3Error>, ctx: RenderContext): Response =>
  Result.match(result, {
    onFailure: (error) => renderError(error, ctx),
    onSuccess: (reply) => renderReply(reply, ctx)
  })
