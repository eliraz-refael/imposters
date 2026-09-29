import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketOwnershipControlsCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  type S3ClientConfig,
  S3ServiceException
} from "@aws-sdk/client-s3"
import { makeTestServer } from "imposters/client/testing"
import { S3Extension } from "imposters/extensions/s3/S3Extension"
import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// Ports 8801-8829 belong to this file (8801-8805 in use).
//
// Replays neeo-monorepo's S3 call shapes (libs/platform/storage/src/s3/bucket.ts,
// tools/provision/src/storage.ts, tools/vitest/src/local-s3.ts) with the real SDK.

const server = makeTestServer({ extensions: [S3Extension] })

afterAll(() => {
  server.dispose()
})

const admin = (path: string, init?: RequestInit) => server.handler(new Request(`http://localhost:2525${path}`, init))
const sendJson = (method: string, path: string, body: unknown) =>
  admin(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

const startS3 = async (port: number, stubs: ReadonlyArray<unknown> = []) => {
  const created = await sendJson("POST", "/imposters", { port, protocol: "S3", name: `s3-${port}` })
  expect(created.status).toBe(201)
  const { id }: { id: string } = await created.json()
  for (const stub of stubs) {
    expect((await sendJson("POST", `/imposters/${id}/stubs`, stub)).status).toBe(201)
  }
  expect((await sendJson("PATCH", `/imposters/${id}`, { status: "running" })).status).toBe(200)
  return id
}

const removeImposter = (id: string) => admin(`/imposters/${id}?force=true`, { method: "DELETE" })

interface LoggedRequest {
  readonly request: {
    readonly method: string
    readonly path: string
    readonly headers: Record<string, string>
    readonly query: Record<string, string>
  }
  readonly response: { readonly status: number; readonly matchedStubId?: string }
}

const requestLog = async (id: string): Promise<ReadonlyArray<LoggedRequest>> =>
  (await admin(`/imposters/${id}/requests?limit=500`)).json()

// neeo's client: libs/platform/s3/src/client.ts with LOCAL_S3's endpoint and credentials
const clientFor = (port: number, overrides: Partial<S3ClientConfig> = {}) =>
  new S3Client({
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${port}`,
    forcePathStyle: true,
    credentials: { accessKeyId: "neeo-local", secretAccessKey: "neeo-local-secret" },
    requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000, throwOnRequestTimeout: true },
    ...overrides
  })

// What the SDK threw, as neeo's bucket.ts inspects it
const failureOf = async (request: Promise<unknown>) => {
  try {
    await request
  } catch (cause) {
    return cause instanceof S3ServiceException
      ? { service: true, name: cause.name, status: cause.$metadata.httpStatusCode }
      : { service: false, name: cause instanceof Error ? cause.name : String(cause), status: undefined }
  }
  throw new Error("expected the request to fail")
}

const md5Etag = (bytes: Uint8Array) => `"${createHash("md5").update(bytes).digest("hex")}"`

// Every byte value, including ones that are never valid UTF-8
const BINARY = new Uint8Array(Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) % 256))
const PDF = { content: new TextEncoder().encode("%PDF-1.7 content"), contentType: "application/pdf" }
const OWNER = "neeo-local"

// The five PUTs tools/provision/src/storage.ts makes, in its order, named by its BucketSetting
const bucketSettings = (
  client: S3Client,
  bucket: string,
  owner: string
): ReadonlyArray<readonly [string, () => Promise<{ readonly $metadata: { readonly httpStatusCode?: number } }>]> => [
  ["public-access", () =>
    client.send(
      new PutPublicAccessBlockCommand({
        Bucket: bucket,
        ExpectedBucketOwner: owner,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true
        }
      })
    )],
  ["ownership", () =>
    client.send(
      new PutBucketOwnershipControlsCommand({
        Bucket: bucket,
        ExpectedBucketOwner: owner,
        OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] }
      })
    )],
  ["encryption", () =>
    client.send(
      new PutBucketEncryptionCommand({
        Bucket: bucket,
        ExpectedBucketOwner: owner,
        ServerSideEncryptionConfiguration: {
          Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }]
        }
      })
    )],
  [
    "tls-only",
    () => client.send(new PutBucketPolicyCommand({ Bucket: bucket, ExpectedBucketOwner: owner, Policy: "{}" }))
  ],
  ["multipart-abort", () =>
    client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        ExpectedBucketOwner: owner,
        LifecycleConfiguration: {
          Rules: [{
            ID: "abort-unfinished-multipart-uploads",
            Status: "Enabled",
            Filter: { Prefix: "" },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 }
          }]
        }
      })
    )]
]

describe("S3 extension: neeo's call shapes against the real SDK", () => {
  const port = 8801
  let id = ""
  const client = clientFor(port)

  beforeAll(async () => {
    id = await startS3(port)
  })

  afterAll(async () => {
    client.destroy()
    await removeImposter(id)
  })

  const put = (bucket: string, key: string, content: Uint8Array, contentType: string) =>
    client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: content,
        ContentType: contentType,
        ContentLength: content.length,
        ExpectedBucketOwner: OWNER
      })
    )

  const keysIn = async (bucket: string, prefix?: string) => {
    const listing = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))
    return (listing.Contents ?? []).flatMap((o) => o.Key === undefined ? [] : [o.Key])
  }

  it("answers ListBuckets, which is how neeo checks the service is reachable", async () => {
    const answer = await client.send(new ListBucketsCommand({}))
    expect(answer.$metadata.httpStatusCode).toBe(200)
  })

  it("creates a bucket, and refuses a second create with BucketAlreadyOwnedByYou", async () => {
    await client.send(new CreateBucketCommand({ Bucket: "created-once", ObjectOwnership: "BucketOwnerEnforced" }))
    expect(await failureOf(client.send(new CreateBucketCommand({ Bucket: "created-once" })))).toEqual({
      service: true,
      name: "BucketAlreadyOwnedByYou",
      status: 409
    })
  })

  it("stores binary bytes exactly and reads them back byte-identical, with type, ETag and length", async () => {
    await client.send(new CreateBucketCommand({ Bucket: "binary" }))
    const written = await put("binary", "files/blob.bin", BINARY, "application/octet-stream")
    expect(written.ETag).toBe(md5Etag(BINARY))

    const read = await client.send(new GetObjectCommand({ Bucket: "binary", Key: "files/blob.bin" }))
    expect(await read.Body?.transformToByteArray()).toEqual(BINARY)
    expect(read.ETag).toBe(md5Etag(BINARY))
    expect(read.ContentType).toBe("application/octet-stream")
    expect(read.ContentLength).toBe(BINARY.length)
    expect(read.LastModified).toBeInstanceOf(Date)
    // No checksum headers, so the SDK has nothing to validate against
    expect(read.ChecksumCRC32).toBeUndefined()
    expect(read.ChecksumSHA256).toBeUndefined()
  })

  it("the SDK sends a Uint8Array PutObject as a plain signed payload, not aws-chunked STREAMING-*", async () => {
    await client.send(new CreateBucketCommand({ Bucket: "payload-shape" }))
    await put("payload-shape", "doc.pdf", PDF.content, PDF.contentType)
    const puts = (await requestLog(id)).filter((e) =>
      e.request.method === "PUT" && e.request.path === "/payload-shape/doc.pdf"
    )
    expect(puts).toHaveLength(1)
    const headers = puts[0]?.request.headers ?? {}
    expect(headers["x-amz-content-sha256"]).toBeDefined()
    expect(headers["x-amz-content-sha256"]).not.toMatch(/^STREAMING-/)
    expect(headers["content-encoding"] ?? "").not.toContain("aws-chunked")
    expect(puts[0]?.response.status).toBe(200)
  })

  it("answers 304 for the current ETag, which the SDK throws with httpStatusCode 304", async () => {
    await client.send(new CreateBucketCommand({ Bucket: "etags" }))
    await put("etags", "doc.pdf", PDF.content, PDF.contentType)
    const found = await client.send(new GetObjectCommand({ Bucket: "etags", Key: "doc.pdf" }))
    const etag = found.ETag ?? ""
    await found.Body?.transformToByteArray()

    // neeo's isNotModified: an S3ServiceException whose $metadata.httpStatusCode is 304
    const notModified = await failureOf(
      client.send(new GetObjectCommand({ Bucket: "etags", Key: "doc.pdf", IfNoneMatch: etag }))
    )
    expect(notModified).toMatchObject({ service: true, status: 304 })

    const stale = await client.send(new GetObjectCommand({ Bucket: "etags", Key: "doc.pdf", IfNoneMatch: "\"stale\"" }))
    expect(await stale.Body?.transformToByteArray()).toEqual(PDF.content)
  })

  it("answers NoSuchKey for a key nothing wrote, and NoSuchBucket for a bucket nobody created", async () => {
    await client.send(new CreateBucketCommand({ Bucket: "misses" }))
    expect(await failureOf(client.send(new GetObjectCommand({ Bucket: "misses", Key: "nothing" })))).toEqual({
      service: true,
      name: "NoSuchKey",
      status: 404
    })
    expect(await failureOf(client.send(new GetObjectCommand({ Bucket: "no-such-bucket", Key: "k" })))).toEqual({
      service: true,
      name: "NoSuchBucket",
      status: 404
    })
  })

  it("HeadObject answers the metadata without a body; a miss is a bodiless 404", async () => {
    await client.send(new CreateBucketCommand({ Bucket: "heads" }))
    await put("heads", "doc.pdf", PDF.content, PDF.contentType)
    const head = await client.send(new HeadObjectCommand({ Bucket: "heads", Key: "doc.pdf" }))
    expect(head.ContentLength).toBe(PDF.content.length)
    expect(head.ContentType).toBe(PDF.contentType)
    expect(head.ETag).toBe(md5Etag(PDF.content))
    expect(await failureOf(client.send(new HeadObjectCommand({ Bucket: "heads", Key: "missing" })))).toMatchObject({
      service: true,
      status: 404
    })
  })

  it("copies an object to a second key, keeping its type; a missing source is NoSuchKey", async () => {
    await client.send(new CreateBucketCommand({ Bucket: "copies" }))
    await put("copies", "from.pdf", PDF.content, PDF.contentType)
    const copied = await client.send(
      new CopyObjectCommand({
        Bucket: "copies",
        Key: "to.pdf",
        CopySource: "copies/from.pdf",
        ExpectedBucketOwner: OWNER,
        ExpectedSourceBucketOwner: OWNER
      })
    )
    expect(copied.CopyObjectResult?.ETag).toBe(md5Etag(PDF.content))

    const read = await client.send(new GetObjectCommand({ Bucket: "copies", Key: "to.pdf" }))
    expect(read.ContentType).toBe(PDF.contentType)
    expect(await read.Body?.transformToByteArray()).toEqual(PDF.content)

    expect(
      await failureOf(client.send(new CopyObjectCommand({ Bucket: "copies", Key: "x", CopySource: "copies/none" })))
    ).toMatchObject({ service: true, name: "NoSuchKey", status: 404 })
  })

  it("keys with spaces, unicode and URL metacharacters round-trip through put, list, get and copy", async () => {
    await client.send(new CreateBucketCommand({ Bucket: "odd-keys" }))
    const keys = ["a b/c+d", "ünï/cødé 😀", "q?x=1&y#frag", "percent%20literal", "/leading-slash", "tilde~*'()!"]
    for (const key of keys) await put("odd-keys", key, new TextEncoder().encode(key), "text/plain")
    expect([...(await keysIn("odd-keys"))].sort()).toEqual([...keys].sort())
    for (const key of keys) {
      const read = await client.send(new GetObjectCommand({ Bucket: "odd-keys", Key: key }))
      expect(await read.Body?.transformToString()).toBe(key)
    }
    // As on real S3, CopySource is URL-encoded by the caller
    await client.send(
      new CopyObjectCommand({
        Bucket: "odd-keys",
        Key: "copy of q",
        CopySource: `odd-keys/${encodeURIComponent("q?x=1&y#frag")}`
      })
    )
    const copy = await client.send(new GetObjectCommand({ Bucket: "odd-keys", Key: "copy of q" }))
    expect(await copy.Body?.transformToString()).toBe("q?x=1&y#frag")
  })

  it("DeleteObjects quiet: deletes exactly the given keys, and reports no errors", async () => {
    await client.send(new CreateBucketCommand({ Bucket: "deletes-quiet" }))
    await put("deletes-quiet", "pictures/1/original", PDF.content, PDF.contentType)
    await put("deletes-quiet", "pictures/1/thumbnail", PDF.content, PDF.contentType)

    const answer = await client.send(
      new DeleteObjectsCommand({
        Bucket: "deletes-quiet",
        Delete: { Objects: [{ Key: "pictures/1/original" }, { Key: "never-written" }], Quiet: true },
        ExpectedBucketOwner: OWNER
      })
    )
    expect(answer.Errors).toBeUndefined()
    expect(answer.Deleted).toBeUndefined()
    expect(await keysIn("deletes-quiet")).toEqual(["pictures/1/thumbnail"])
  })

  it("DeleteObjects non-quiet lists every key as deleted, including one that was never there", async () => {
    await client.send(new CreateBucketCommand({ Bucket: "deletes-loud" }))
    await put("deletes-loud", "a", PDF.content, PDF.contentType)
    await put("deletes-loud", "b", PDF.content, PDF.contentType)

    const answer = await client.send(
      new DeleteObjectsCommand({
        Bucket: "deletes-loud",
        Delete: { Objects: [{ Key: "a" }, { Key: "b" }, { Key: "gone" }] }
      })
    )
    expect(answer.Deleted?.map((d) => d.Key)).toEqual(["a", "b", "gone"])
    expect(answer.Errors).toBeUndefined()
    expect(await keysIn("deletes-loud")).toEqual([])
  })

  it("provisioning: versioning is not Enabled; ownership and policy are accepted, the other three PUTs are 501", async () => {
    const bucket = "provisioned"
    await client.send(new CreateBucketCommand({ Bucket: bucket, ObjectOwnership: "BucketOwnerEnforced" }))
    const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: bucket, ExpectedBucketOwner: OWNER }))
    expect(versioning.Status).toBeUndefined()

    // tools/provision/src/storage.ts `applied`: a 501 locally is "unsupported", anything else a failure
    const outcomes: Array<readonly [string, number | undefined]> = []
    for (const [setting, send] of bucketSettings(client, bucket, OWNER)) {
      const outcome = await send().then(
        (answer) => answer.$metadata.httpStatusCode,
        (cause) => cause instanceof S3ServiceException ? cause.$metadata.httpStatusCode : -1
      )
      outcomes.push([setting, outcome])
    }
    expect(outcomes).toEqual([
      ["public-access", 501],
      ["ownership", 200],
      ["encryption", 501],
      ["tls-only", 204],
      ["multipart-abort", 501]
    ])
    // So storage.spec.ts "creates the bucket" reports exactly these as unsupported locally
    expect(outcomes.filter(([, status]) => status === 501).map(([setting]) => setting)).toEqual([
      "public-access",
      "encryption",
      "multipart-abort"
    ])
  })

  it("the accepted config PUTs still need the bucket", async () => {
    for (const [setting, send] of bucketSettings(client, "no-such-provisioned", OWNER)) {
      if (setting === "ownership" || setting === "tls-only") {
        expect(await failureOf(send())).toEqual({ service: true, name: "NoSuchBucket", status: 404 })
      }
    }
  })

  it("lists buckets, and objects under a prefix", async () => {
    await client.send(new CreateBucketCommand({ Bucket: "listing" }))
    for (const key of ["docs/b", "docs/a", "pictures/c", "docs"]) await put("listing", key, PDF.content, "text/plain")

    const buckets = await client.send(new ListBucketsCommand({}))
    expect(buckets.Buckets?.map((b) => b.Name)).toEqual(expect.arrayContaining(["listing", "binary", "copies"]))
    expect(buckets.Buckets?.every((b) => b.CreationDate instanceof Date)).toBe(true)

    expect(await keysIn("listing", "docs/")).toEqual(["docs/a", "docs/b"])
    expect(await keysIn("listing", "docs")).toEqual(["docs", "docs/a", "docs/b"])
    expect(await keysIn("listing")).toEqual(["docs", "docs/a", "docs/b", "pictures/c"])
    const listed = await client.send(new ListObjectsV2Command({ Bucket: "listing", Prefix: "pictures/" }))
    expect(listed.KeyCount).toBe(1)
    expect(listed.IsTruncated).toBe(false)
    expect(listed.Contents?.[0]).toMatchObject({
      Key: "pictures/c",
      Size: PDF.content.length,
      ETag: md5Etag(PDF.content)
    })
  })

  it("ListObjectsV2 FetchOwner gives each object an Owner; without it Owner is undefined", async () => {
    await client.send(new CreateBucketCommand({ Bucket: "owners" }))
    await put("owners", "one", PDF.content, "text/plain")
    await put("owners", "two", PDF.content, "text/plain")

    const fetched = await client.send(new ListObjectsV2Command({ Bucket: "owners", FetchOwner: true }))
    expect(fetched.Contents?.map((o) => o.Owner?.ID)).toEqual(["imposters", "imposters"])

    const plain = await client.send(new ListObjectsV2Command({ Bucket: "owners" }))
    expect(plain.Contents).toHaveLength(2)
    expect(plain.Contents?.map((o) => o.Owner)).toEqual([undefined, undefined])
  })

  it("a listing that would be truncated answers 501 rather than paginating", async () => {
    await client.send(new CreateBucketCommand({ Bucket: "truncated" }))
    await put("truncated", "one", PDF.content, "text/plain")
    await put("truncated", "two", PDF.content, "text/plain")
    expect(await failureOf(client.send(new ListObjectsV2Command({ Bucket: "truncated", MaxKeys: 1 })))).toEqual({
      service: true,
      name: "NotImplemented",
      status: 501
    })
    expect((await client.send(new ListObjectsV2Command({ Bucket: "truncated", MaxKeys: 2 }))).KeyCount).toBe(2)
  })

  it("head and delete bucket, the way neeo's test teardown removes one", async () => {
    await client.send(new CreateBucketCommand({ Bucket: "teardown" }))
    await put("teardown", "left-over", PDF.content, PDF.contentType)
    expect((await client.send(new HeadBucketCommand({ Bucket: "teardown" }))).$metadata.httpStatusCode).toBe(200)

    expect(await failureOf(client.send(new DeleteBucketCommand({ Bucket: "teardown" })))).toEqual({
      service: true,
      name: "BucketNotEmpty",
      status: 409
    })

    // removeBucket from tools/vitest/src/local-s3.ts
    const keys = await keysIn("teardown")
    await client.send(
      new DeleteObjectsCommand({ Bucket: "teardown", Delete: { Objects: keys.map((Key) => ({ Key })) } })
    )
    await client.send(new DeleteBucketCommand({ Bucket: "teardown" }))

    expect(await failureOf(client.send(new HeadBucketCommand({ Bucket: "teardown" })))).toMatchObject({
      service: true,
      status: 404
    })
  })
})

describe("S3 extension: the expected-owner check", () => {
  const port = 8805
  const FOREIGN = "111122223333"
  let id = ""
  const client = clientFor(port)

  beforeAll(async () => {
    id = await startS3(port)
    await client.send(new CreateBucketCommand({ Bucket: "owned" }))
    await client.send(new PutObjectCommand({ Bucket: "owned", Key: "doc.pdf", Body: PDF.content }))
  })

  afterAll(async () => {
    client.destroy()
    await removeImposter(id)
  })

  const ACCESS_DENIED = { service: true, name: "AccessDenied", status: 403 }

  // bucket.spec.ts "when the bucket belongs to another owner": each of these becomes BucketUnavailable in neeo
  it.each([
    ["put", () =>
      client.send(
        new PutObjectCommand({ Bucket: "owned", Key: "new", Body: PDF.content, ExpectedBucketOwner: FOREIGN })
      )],
    ["get", () => client.send(new GetObjectCommand({ Bucket: "owned", Key: "doc.pdf", ExpectedBucketOwner: FOREIGN }))],
    [
      "get of a missing key",
      () => client.send(new GetObjectCommand({ Bucket: "owned", Key: "missing", ExpectedBucketOwner: FOREIGN }))
    ],
    ["copy", () =>
      client.send(
        new CopyObjectCommand({
          Bucket: "owned",
          Key: "to",
          CopySource: "owned/doc.pdf",
          ExpectedBucketOwner: FOREIGN,
          ExpectedSourceBucketOwner: FOREIGN
        })
      )],
    ["copy with only a foreign source owner", () =>
      client.send(
        new CopyObjectCommand({
          Bucket: "owned",
          Key: "to",
          CopySource: "owned/doc.pdf",
          ExpectedBucketOwner: OWNER,
          ExpectedSourceBucketOwner: FOREIGN
        })
      )],
    ["delete", () =>
      client.send(
        new DeleteObjectsCommand({
          Bucket: "owned",
          Delete: { Objects: [{ Key: "doc.pdf" }], Quiet: true },
          ExpectedBucketOwner: FOREIGN
        })
      )],
    ["versioning", () => client.send(new GetBucketVersioningCommand({ Bucket: "owned", ExpectedBucketOwner: FOREIGN }))]
  ])("refuses %s for a foreign ExpectedBucketOwner with 403 AccessDenied", async (_, request) => {
    expect(await failureOf(request())).toEqual(ACCESS_DENIED)
  })

  it("refuses HEAD with a bodiless 403", async () => {
    const onBucket = await failureOf(
      client.send(new HeadBucketCommand({ Bucket: "owned", ExpectedBucketOwner: FOREIGN }))
    )
    const onObject = await failureOf(
      client.send(new HeadObjectCommand({ Bucket: "owned", Key: "doc.pdf", ExpectedBucketOwner: FOREIGN }))
    )
    expect([onBucket.status, onObject.status]).toEqual([403, 403])
  })

  it("refuses the accepted config PUTs for a foreign owner too", async () => {
    for (const [setting, send] of bucketSettings(client, "owned", FOREIGN)) {
      if (setting === "ownership" || setting === "tls-only") expect(await failureOf(send())).toEqual(ACCESS_DENIED)
    }
  })

  it("nothing a refused request asked for happened", async () => {
    const listing = await client.send(new ListObjectsV2Command({ Bucket: "owned" }))
    expect(listing.Contents?.map((o) => o.Key)).toEqual(["doc.pdf"])
  })

  it("passes a matching ExpectedBucketOwner", async () => {
    const read = await client.send(
      new GetObjectCommand({ Bucket: "owned", Key: "doc.pdf", ExpectedBucketOwner: OWNER })
    )
    expect(await read.Body?.transformToByteArray()).toEqual(PDF.content)
  })

  it("does not check an unsigned request, which has no requester to compare with", async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/owned/doc.pdf`, {
      headers: { "x-amz-expected-bucket-owner": FOREIGN }
    })
    expect(resp.status).toBe(200)
    expect(new Uint8Array(await resp.arrayBuffer())).toEqual(PDF.content)
  })
})

describe("S3 extension: fault injection with stubs", () => {
  it("a stub answers 503 SlowDown for one key while every other key reaches the emulator", async () => {
    const port = 8802
    const id = await startS3(port, [{
      predicates: [
        { field: "method", operator: "equals", value: "GET" },
        { field: "path", operator: "equals", value: "/flaky/slow.pdf" }
      ],
      responses: [{
        status: 503,
        headers: { "content-type": "application/xml" },
        body: "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
          "<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error>"
      }]
    }])
    const client = clientFor(port, { maxAttempts: 1 })
    try {
      await client.send(new CreateBucketCommand({ Bucket: "flaky" }))
      for (const key of ["slow.pdf", "fine.pdf"]) {
        await client.send(new PutObjectCommand({ Bucket: "flaky", Key: key, Body: PDF.content }))
      }

      expect(await failureOf(client.send(new GetObjectCommand({ Bucket: "flaky", Key: "slow.pdf" })))).toEqual({
        service: true,
        name: "SlowDown",
        status: 503
      })
      const fine = await client.send(new GetObjectCommand({ Bucket: "flaky", Key: "fine.pdf" }))
      expect(await fine.Body?.transformToByteArray()).toEqual(PDF.content)

      // The stub answered the failing GET; the emulator answered everything else
      const log = await requestLog(id)
      const stubbed = log.filter((e) => e.response.matchedStubId !== undefined).map((e) => e.request.path)
      expect(stubbed).toEqual(["/flaky/slow.pdf"])
    } finally {
      client.destroy()
      await removeImposter(id)
    }
  })

  it("a delayed stub trips the SDK request timeout", async () => {
    const port = 8803
    const id = await startS3(port, [{
      predicates: [{ field: "path", operator: "equals", value: "/stalled/doc.pdf" }],
      responses: [{ status: 200, body: "late", delay: 2_000 }]
    }])
    const client = clientFor(port, {
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 1_000, requestTimeout: 200, throwOnRequestTimeout: true }
    })
    try {
      const failure = await failureOf(client.send(new GetObjectCommand({ Bucket: "stalled", Key: "doc.pdf" })))
      expect(failure).toEqual({ service: false, name: "TimeoutError", status: undefined })
    } finally {
      client.destroy()
      await removeImposter(id)
    }
  })

  it("the store lives per start: a restarted S3 imposter is empty again", async () => {
    const port = 8804
    const id = await startS3(port)
    const client = clientFor(port)
    try {
      await client.send(new CreateBucketCommand({ Bucket: "ephemeral" }))
      expect((await sendJson("PATCH", `/imposters/${id}`, { status: "stopped" })).status).toBe(200)
      expect((await sendJson("PATCH", `/imposters/${id}`, { status: "running" })).status).toBe(200)
      // A fresh client, so no pooled socket points at the stopped server
      const fresh = clientFor(port)
      const buckets = await fresh.send(new ListBucketsCommand({}))
      fresh.destroy()
      expect(buckets.Buckets ?? []).toEqual([])
    } finally {
      client.destroy()
      await removeImposter(id)
    }
  })
})
