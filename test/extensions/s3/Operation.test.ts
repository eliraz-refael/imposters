import { it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { accessKeyOf, DEFAULT_CONTENT_TYPE, Operation, parseOperation } from "imposters/extensions/s3/Operation"
import { escapeXml } from "imposters/extensions/s3/Xml"
import { describe, expect } from "vitest"
import { encodeKey, ObjectKey, request, type RequestOptions, xmlDeleteBody } from "./requests"

const parse = (method: string, path: string, options?: RequestOptions) => parseOperation(request(method, path, options))

// The error code a request is refused with, or the operation's tag
const outcome = (method: string, path: string, options?: RequestOptions) =>
  Result.match(parse(method, path, options), { onFailure: (e) => e.code, onSuccess: (op) => op._tag })

const operation = (method: string, path: string, options?: RequestOptions) =>
  Result.getOrThrow(parse(method, path, options))

describe("parseOperation: the routing table", () => {
  it.each(
    [
      ["GET", "/", {}, "ListBuckets"],
      ["PUT", "/bucket", {}, "CreateBucket"],
      ["PUT", "/bucket/", {}, "CreateBucket"],
      ["HEAD", "/bucket", {}, "HeadBucket"],
      ["DELETE", "/bucket", {}, "DeleteBucket"],
      ["GET", "/bucket", { query: { versioning: "" } }, "GetBucketVersioning"],
      [
        "PUT",
        "/bucket",
        { query: { ownershipControls: "" }, body: "<OwnershipControls/>" },
        "PutBucketOwnershipControls"
      ],
      ["PUT", "/bucket", { query: { policy: "" }, body: "{}" }, "PutBucketPolicy"],
      ["GET", "/bucket", { query: { "list-type": "2", prefix: "a/" } }, "ListObjectsV2"],
      ["POST", "/bucket", { query: { delete: "" }, body: xmlDeleteBody(["k"]) }, "DeleteObjects"],
      ["PUT", "/bucket/key", { body: "x" }, "PutObject"],
      ["PUT", "/bucket/key", { headers: { "x-amz-copy-source": "bucket/other" } }, "CopyObject"],
      ["GET", "/bucket/key", {}, "GetObject"],
      ["HEAD", "/bucket/key", {}, "HeadObject"],
      ["DELETE", "/bucket/key", {}, "DeleteObject"]
    ] as const
  )("%s %s %j is %s", (method, path, options, expected) => {
    expect(outcome(method, path, options)).toBe(expected)
  })

  it("ignores the SDK's ?x-id tag", () => {
    expect(outcome("PUT", "/bucket/key", { query: { "x-id": "PutObject" } })).toBe("PutObject")
    expect(outcome("GET", "/", { query: { "x-id": "ListBuckets" } })).toBe("ListBuckets")
  })

  it.each([
    ["publicAccessBlock"],
    ["encryption"],
    ["lifecycle"],
    ["cors"],
    ["versioning"],
    ["tagging"],
    ["acl"]
  ])("a bucket-config PUT ?%s is NotImplemented", (subresource) => {
    expect(outcome("PUT", "/bucket", { query: { [subresource]: "" } })).toBe("NotImplemented")
  })

  it.each(
    [
      ["ListObjects v1", "GET", "/bucket", {}],
      ["ListObjectsV2 with a delimiter", "GET", "/bucket", { query: { "list-type": "2", delimiter: "/" } }],
      ["ListObjectsV2 with a continuation token", "GET", "/bucket", {
        query: { "list-type": "2", "continuation-token": "t" }
      }],
      ["ListObjectsV2 with start-after", "GET", "/bucket", { query: { "list-type": "2", "start-after": "a" } }],
      ["list-type=1", "GET", "/bucket", { query: { "list-type": "1" } }],
      ["a multipart upload start", "POST", "/bucket/key", { query: { uploads: "" } }],
      ["a multipart part", "PUT", "/bucket/key", { query: { partNumber: "1", uploadId: "u" } }],
      ["a multipart completion", "POST", "/bucket/key", { query: { uploadId: "u" } }],
      ["a versioned read", "GET", "/bucket/key", { query: { versionId: "v" } }],
      ["a presigned GET", "GET", "/bucket/key", {
        query: { "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Signature": "abc" }
      }],
      ["an aws-chunked upload", "PUT", "/bucket/key", {
        headers: { "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD" }
      }],
      ["an unsigned-trailer upload", "PUT", "/bucket/key", {
        headers: { "x-amz-content-sha256": "STREAMING-UNSIGNED-PAYLOAD-TRAILER" }
      }],
      ["content-encoding aws-chunked", "PUT", "/bucket/key", { headers: { "content-encoding": "gzip, aws-chunked" } }],
      ["a Range read", "GET", "/bucket/key", { headers: { range: "bytes=0-9" } }],
      ["If-Modified-Since", "GET", "/bucket/key", {
        headers: { "if-modified-since": "Mon, 01 Jan 2024 00:00:00 GMT" }
      }],
      ["a conditional write", "PUT", "/bucket/key", { headers: { "if-none-match": "*" } }],
      ["a copy with REPLACE metadata", "PUT", "/bucket/key", {
        headers: { "x-amz-copy-source": "bucket/a", "x-amz-metadata-directive": "REPLACE" }
      }],
      ["a conditional copy", "PUT", "/bucket/key", {
        headers: { "x-amz-copy-source": "bucket/a", "x-amz-copy-source-if-match": "\"e\"" }
      }],
      ["a copy from a version", "PUT", "/bucket/key", { headers: { "x-amz-copy-source": "bucket/a?versionId=1" } }],
      ["HEAD on the service", "HEAD", "/", {}],
      ["POST on a bucket without ?delete", "POST", "/bucket", {}],
      ["an unknown bucket subresource", "GET", "/bucket", { query: { website: "" } }]
    ] as const
  )("%s is NotImplemented", (_, method, path, options) => {
    expect(outcome(method, path, options)).toBe("NotImplemented")
  })

  it("names what is not implemented in the error", () => {
    const error = Result.match(parse("PUT", "/bucket", { query: { lifecycle: "" } }), {
      onFailure: (e) => e,
      onSuccess: () => undefined
    })
    expect(error?.message).toBe("CreateBucket with ?lifecycle is not implemented by the imposters S3 emulator")
    expect(error?.resource).toBe("/bucket")
  })
})

describe("parseOperation: operation details", () => {
  it.prop("decodes the bucket and key from a path the SDK encoded", { key: ObjectKey }, ({ key }) => {
    expect(operation("GET", `/bucket/${encodeKey(key)}`)).toEqual(
      Operation.GetObject({ bucket: "bucket", key, ifNoneMatch: undefined })
    )
  })

  it("refuses a path that is not valid percent-encoding with InvalidURI", () => {
    expect(outcome("GET", "/bucket/%E0%A4%A")).toBe("InvalidURI")
  })

  it("keeps the exact body bytes and the content type of a PutObject, defaulting the type as S3 does", () => {
    const bytes = new Uint8Array([0, 255, 1, 254])
    expect(operation("PUT", "/b/k", { body: bytes, headers: { "content-type": "image/png" } })).toEqual(
      Operation.PutObject({ bucket: "b", key: "k", body: bytes, contentType: "image/png" })
    )
    expect(operation("PUT", "/b/k", { body: bytes })).toMatchObject({ contentType: DEFAULT_CONTENT_TYPE })
  })

  it("refuses a key over 1024 UTF-8 bytes with KeyTooLongError", () => {
    expect(outcome("PUT", `/b/${"é".repeat(513)}`)).toBe("KeyTooLongError")
    expect(outcome("PUT", `/b/${"e".repeat(1024)}`)).toBe("PutObject")
  })

  it.each([["UPPER"], ["ab"], ["a..b"], ["-start"], ["under_score"], ["x".repeat(64)]])(
    "refuses to create a bucket named %j with InvalidBucketName",
    (name) => {
      expect(outcome("PUT", `/${name}`)).toBe("InvalidBucketName")
    }
  )

  it("reads ListObjectsV2's prefix, max-keys (capped at 1000) and encoding-type", () => {
    expect(operation("GET", "/b", { query: { "list-type": "2" } })).toEqual(
      Operation.ListObjectsV2({ bucket: "b", prefix: "", maxKeys: 1000, urlEncoded: false, fetchOwner: false })
    )
    expect(
      operation("GET", "/b", { query: { "list-type": "2", prefix: "p/", "max-keys": "5000", "encoding-type": "url" } })
    ).toEqual(
      Operation.ListObjectsV2({ bucket: "b", prefix: "p/", maxKeys: 1000, urlEncoded: true, fetchOwner: false })
    )
    expect(operation("GET", "/b", { query: { "list-type": "2", "fetch-owner": "true" } })).toEqual(
      Operation.ListObjectsV2({ bucket: "b", prefix: "", maxKeys: 1000, urlEncoded: false, fetchOwner: true })
    )
    expect(outcome("GET", "/b", { query: { "list-type": "2", "max-keys": "ten" } })).toBe("InvalidArgument")
    expect(outcome("GET", "/b", { query: { "list-type": "2", "encoding-type": "base64" } })).toBe("InvalidArgument")
  })

  it.each([
    ["bucket/from key", "bucket", "from key"],
    ["/bucket/from", "bucket", "from"],
    ["bucket/dir%2Ffile%20%F0%9F%98%80", "bucket", "dir/file 😀"],
    ["other/nested/path", "other", "nested/path"]
  ])("reads copy source %j", (source, sourceBucket, sourceKey) => {
    expect(operation("PUT", "/bucket/to", { headers: { "x-amz-copy-source": source } })).toEqual(
      Operation.CopyObject({ bucket: "bucket", key: "to", sourceBucket, sourceKey })
    )
  })

  it.each([["bucket"], ["bucket/"], ["/key-only"], ["%E0%A4%A"]])("refuses copy source %j", (source) => {
    expect(outcome("PUT", "/bucket/to", { headers: { "x-amz-copy-source": source } })).toBe("InvalidArgument")
  })

  it("refuses a copy onto itself with InvalidRequest, as S3 does", () => {
    expect(outcome("PUT", "/bucket/k", { headers: { "x-amz-copy-source": "bucket/k" } })).toBe("InvalidRequest")
  })

  it("passes If-None-Match through to GetObject and HeadObject", () => {
    const headers = { "if-none-match": "\"abc\"" }
    expect(operation("GET", "/b/k", { headers })).toMatchObject({ ifNoneMatch: "\"abc\"" })
    expect(operation("HEAD", "/b/k", { headers })).toMatchObject({ _tag: "HeadObject", ifNoneMatch: "\"abc\"" })
  })

  it.prop(
    "reads a DeleteObjects body's keys and Quiet flag",
    { keys: Schema.NonEmptyArray(ObjectKey), quiet: Schema.Boolean },
    ({ keys, quiet }) => {
      const body = xmlDeleteBody(keys, quiet, escapeXml)
      expect(operation("POST", "/b", { query: { delete: "" }, body })).toEqual(
        Operation.DeleteObjects({ bucket: "b", keys, quiet })
      )
    }
  )

  it.each([
    ["not XML", "garbage"],
    ["no objects", "<Delete></Delete>"],
    ["over 1000 objects", xmlDeleteBody(Array.from({ length: 1001 }, (_, i) => `k${i}`))]
  ])("refuses a DeleteObjects body with %s as MalformedXML", (_, body) => {
    expect(outcome("POST", "/b", { query: { delete: "" }, body })).toBe("MalformedXML")
  })
})

describe("parseOperation: the expected-owner check", () => {
  const SIGV4 = "AWS4-HMAC-SHA256 Credential=local-dev/20260928/us-east-1/s3/aws4_request, " +
    "SignedHeaders=host;x-amz-date, Signature=abc"
  const signed = (headers: Record<string, string>) => ({ authorization: SIGV4, ...headers })

  it("reads the access key id from SigV4 and SigV2 Authorization headers", () => {
    expect(accessKeyOf(SIGV4)).toBe("local-dev")
    expect(accessKeyOf("AWS AKIDEXAMPLE:c2lnbmF0dXJl")).toBe("AKIDEXAMPLE")
    expect(accessKeyOf("Bearer token")).toBeUndefined()
    expect(accessKeyOf(undefined)).toBeUndefined()
  })

  it.each(
    [
      ["GET", "/bucket/key", {}],
      ["PUT", "/bucket/key", {}],
      ["HEAD", "/bucket", {}],
      ["GET", "/bucket", { query: { versioning: "" } }],
      ["PUT", "/bucket", { query: { policy: "" } }],
      ["PUT", "/bucket", { query: { ownershipControls: "" } }],
      // Before anything else, including answers the emulator would not implement
      ["PUT", "/bucket", { query: { lifecycle: "" } }]
    ] as const
  )("%s %s %j with a foreign expected owner is AccessDenied", (method, path, options) => {
    const code = outcome(method, path, {
      ...options,
      headers: signed({ "x-amz-expected-bucket-owner": "111122223333" })
    })
    expect(code).toBe("AccessDenied")
  })

  it("checks the copy source's expected owner as well", () => {
    const headers = signed({
      "x-amz-copy-source": "bucket/from",
      "x-amz-expected-bucket-owner": "local-dev",
      "x-amz-source-expected-bucket-owner": "111122223333"
    })
    expect(outcome("PUT", "/bucket/to", { headers })).toBe("AccessDenied")
  })

  it("passes an expected owner equal to the requester", () => {
    const headers = signed({ "x-amz-expected-bucket-owner": "local-dev" })
    expect(outcome("GET", "/bucket/key", { headers })).toBe("GetObject")
  })

  it("does not check a request without credentials", () => {
    expect(outcome("GET", "/bucket/key", { headers: { "x-amz-expected-bucket-owner": "111122223333" } })).toBe(
      "GetObject"
    )
  })
})
