import { it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { ImposterConfig } from "imposters/domain/imposter"
import { emptyStore, etagOf } from "imposters/extensions/s3/Kernel"
import { handleS3, S3Extension } from "imposters/extensions/s3/S3Extension"
import { parseXml } from "imposters/extensions/s3/Xml"
import { describe, expect } from "vitest"
import { encodeKey, ObjectKey, request, type RequestOptions, xmlDeleteBody } from "./requests"

// A fresh emulator; `send` answers one request against it
const emulator = Effect.map(Ref.make(emptyStore), (store) => ({
  send: (method: string, path: string, options?: RequestOptions) =>
    Effect.flatMap(handleS3(store, request(method, path, options)), (response) =>
      Effect.promise(async () => ({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        bytes: new Uint8Array(await response.arrayBuffer())
      })))
}))

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

const ErrorXml = Schema.Struct({
  Error: Schema.Struct({
    Code: Schema.String,
    Message: Schema.String,
    Resource: Schema.String,
    RequestId: Schema.String
  })
})
const errorOf = (bytes: Uint8Array) =>
  Result.getOrThrow(
    Result.flatMap(parseXml(text(bytes)), (tree) => Result.mapError(Schema.decodeUnknownResult(ErrorXml)(tree), String))
  ).Error

describe("S3Extension", () => {
  it.effect("is the S3 protocol, and each make starts from an empty store", () =>
    Effect.gen(function*() {
      expect(S3Extension.protocol).toBe("S3")
      const config = ImposterConfig({
        id: "s3",
        name: "s3",
        port: 8899,
        protocol: "S3",
        status: "running",
        createdAt: DateTime.makeUnsafe(0)
      })
      const bucketsOf = (response: Response) =>
        Effect.promise(async () => (await response.text()).includes("<Name>kept</Name>"))

      const first = yield* S3Extension.make({ id: "s3", config })
      expect((yield* first.handle(request("PUT", "/kept"))).status).toBe(200)
      expect(yield* bucketsOf(yield* first.handle(request("GET", "/")))).toBe(true)

      // A restart is a new make: the old instance's buckets are not there
      const second = yield* S3Extension.make({ id: "s3", config })
      expect(yield* bucketsOf(yield* second.handle(request("GET", "/")))).toBe(false)
    }))
})

describe("handleS3: responses", () => {
  it.effect.prop(
    "put then get over HTTP returns the exact bytes with ETag, type, length and Last-Modified",
    { key: ObjectKey, body: Schema.Uint8Array },
    ({ body, key }) =>
      Effect.gen(function*() {
        const s3 = yield* emulator
        const sent = new Uint8Array(body)
        expect((yield* s3.send("PUT", "/bkt")).status).toBe(200)
        const put = yield* s3.send("PUT", `/bkt/${encodeKey(key)}`, {
          body: sent,
          headers: { "content-type": "image/png" }
        })
        expect(put.status).toBe(200)
        expect(put.headers["etag"]).toBe(etagOf(sent))

        const got = yield* s3.send("GET", `/bkt/${encodeKey(key)}`)
        expect(got.status).toBe(200)
        expect(got.bytes).toEqual(sent)
        expect(got.headers).toMatchObject({
          "etag": etagOf(sent),
          "content-type": "image/png",
          "content-length": String(sent.length),
          // TestClock starts at the epoch
          "last-modified": "Thu, 01 Jan 1970 00:00:00 GMT"
        })
        expect(Object.keys(got.headers).filter((h) => h.startsWith("x-amz-checksum"))).toEqual([])
      }),
    { arbitrary: { runs: 50 } }
  )

  it.effect("HeadObject has the object's headers and no body; 304 has the ETag and no body", () =>
    Effect.gen(function*() {
      const s3 = yield* emulator
      yield* s3.send("PUT", "/bkt")
      yield* s3.send("PUT", "/bkt/k", { body: "hello" })
      const head = yield* s3.send("HEAD", "/bkt/k")
      expect(head.status).toBe(200)
      expect(head.bytes.length).toBe(0)
      expect(head.headers["content-length"]).toBe("5")
      expect(head.headers["content-type"]).toBe("binary/octet-stream")

      const etag = etagOf(new TextEncoder().encode("hello"))
      const notModified = yield* s3.send("GET", "/bkt/k", { headers: { "if-none-match": etag } })
      expect(notModified.status).toBe(304)
      expect(notModified.bytes.length).toBe(0)
      expect(notModified.headers["etag"]).toBe(etag)
    }))

  it.effect("errors are S3 <Error> documents with the status for their code", () =>
    Effect.gen(function*() {
      const s3 = yield* emulator
      yield* s3.send("PUT", "/bkt")
      const cases = [
        [yield* s3.send("GET", "/bkt/missing"), 404, "NoSuchKey", "/bkt/missing"],
        [yield* s3.send("GET", "/nobucket/k"), 404, "NoSuchBucket", "/nobucket"],
        [yield* s3.send("PUT", "/bkt"), 409, "BucketAlreadyOwnedByYou", "/bkt"],
        [yield* s3.send("PUT", "/bkt", { query: { lifecycle: "" } }), 501, "NotImplemented", "/bkt"],
        [
          yield* s3.send("GET", "/bkt/k", {
            headers: {
              authorization: "AWS4-HMAC-SHA256 Credential=me/20260928/us-east-1/s3/aws4_request",
              "x-amz-expected-bucket-owner": "111122223333"
            }
          }),
          403,
          "AccessDenied",
          "/bkt/k"
        ],
        [yield* s3.send("PUT", "/Bad_Name"), 400, "InvalidBucketName", "/Bad_Name"]
      ] as const
      for (const [response, status, code, resource] of cases) {
        expect(response.status).toBe(status)
        expect(response.headers["content-type"]).toBe("application/xml")
        const error = errorOf(response.bytes)
        expect(error).toMatchObject({ Code: code, Resource: resource })
        expect(error.RequestId).toMatch(/^[0-9A-F]{16}$/)
        expect(response.headers["x-amz-request-id"]).toBe(error.RequestId)
      }
    }))

  it.effect("HEAD errors carry the status but no body", () =>
    Effect.gen(function*() {
      const s3 = yield* emulator
      const missing = yield* s3.send("HEAD", "/nobucket")
      expect(missing.status).toBe(404)
      expect(missing.bytes.length).toBe(0)
      const denied = yield* s3.send("HEAD", "/nobucket", {
        headers: { authorization: "AWS me:sig", "x-amz-expected-bucket-owner": "someone-else" }
      })
      expect(denied.status).toBe(403)
      expect(denied.bytes.length).toBe(0)
    }))

  it.effect("PutBucketOwnershipControls answers 200 and PutBucketPolicy 204, both empty", () =>
    Effect.gen(function*() {
      const s3 = yield* emulator
      yield* s3.send("PUT", "/bkt")
      const ownership = yield* s3.send("PUT", "/bkt", { query: { ownershipControls: "" } })
      const policy = yield* s3.send("PUT", "/bkt", { query: { policy: "" }, body: "{}" })
      expect([ownership.status, ownership.bytes.length, policy.status, policy.bytes.length]).toEqual([200, 0, 204, 0])
    }))

  it.effect("ListObjectsV2 puts an Owner in each Contents only with fetch-owner=true", () =>
    Effect.gen(function*() {
      const s3 = yield* emulator
      yield* s3.send("PUT", "/bkt")
      yield* s3.send("PUT", "/bkt/a", { body: "1" })
      yield* s3.send("PUT", "/bkt/b", { body: "2" })
      const list = (query: Record<string, string>) =>
        Effect.map(s3.send("GET", "/bkt", { query: { "list-type": "2", ...query } }), (r) => text(r.bytes))

      const withOwner = yield* list({ "fetch-owner": "true" })
      const contents = withOwner.match(/<Contents>.*?<\/Contents>/g) ?? []
      expect(contents).toHaveLength(2)
      for (const entry of contents) {
        expect(entry).toContain("<Owner><ID>imposters</ID><DisplayName>imposters</DisplayName></Owner>")
      }
      for (const query of [{}, { "fetch-owner": "false" }]) {
        expect(yield* list(query)).not.toContain("<Owner>")
      }
    }))

  it.effect("renders listings, copies, deletes and versioning as S3 XML", () =>
    Effect.gen(function*() {
      const s3 = yield* emulator
      yield* s3.send("PUT", "/bkt")
      yield* s3.send("PUT", "/bkt/a%26b", { body: "1" })
      yield* s3.send("PUT", "/bkt/dir/c", { body: "22" })

      const listing = text((yield* s3.send("GET", "/bkt", { query: { "list-type": "2", prefix: "" } })).bytes)
      expect(listing).toContain("<Key>a&amp;b</Key>")
      expect(listing).toContain("<KeyCount>2</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>")
      expect(listing).toContain("<Size>2</Size>")

      const encoded = text(
        (yield* s3.send("GET", "/bkt", { query: { "list-type": "2", "encoding-type": "url" } })).bytes
      )
      expect(encoded).toContain("<Key>a%26b</Key>")
      expect(encoded).toContain("<EncodingType>url</EncodingType>")

      const copy = yield* s3.send("PUT", "/bkt/copy", { headers: { "x-amz-copy-source": "/bkt/dir%2Fc" } })
      expect(copy.status).toBe(200)
      expect(text(copy.bytes)).toMatch(
        /<CopyObjectResult [^>]*><LastModified>1970-01-01T00:00:00.000Z<\/LastModified><ETag>&quot;[0-9a-f]{32}&quot;<\/ETag><\/CopyObjectResult>/
      )

      const loud = text(
        (yield* s3.send("POST", "/bkt", { query: { delete: "" }, body: xmlDeleteBody(["copy", "gone"]) })).bytes
      )
      expect(loud).toContain("<Deleted><Key>copy</Key></Deleted><Deleted><Key>gone</Key></Deleted>")
      const quiet = text(
        (yield* s3.send("POST", "/bkt", { query: { delete: "" }, body: xmlDeleteBody(["a&amp;b"], true) })).bytes
      )
      expect(quiet).not.toContain("<Deleted>")

      const versioning = text((yield* s3.send("GET", "/bkt", { query: { versioning: "" } })).bytes)
      expect(versioning).toBe(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<VersioningConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"/>"
      )

      expect((yield* s3.send("DELETE", "/bkt/dir/c")).status).toBe(204)
      expect((yield* s3.send("DELETE", "/bkt")).status).toBe(204)
      const buckets = text((yield* s3.send("GET", "/")).bytes)
      expect(buckets).toContain("<Buckets/>")
    }))
})
