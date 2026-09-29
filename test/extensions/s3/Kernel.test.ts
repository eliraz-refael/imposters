import { it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { apply, emptyStore, etagOf, noneMatch, type S3Reply, type Store } from "imposters/extensions/s3/Kernel"
import { Operation } from "imposters/extensions/s3/Operation"
import { describe, expect } from "vitest"
import { ObjectKey } from "./requests"

const T0 = DateTime.makeUnsafe(0)
const T1 = DateTime.makeUnsafe(60_000)

// Applies operations in order, returning every answer and the final store
const run = (ops: ReadonlyArray<Operation>, store: Store = emptyStore, now = T0) =>
  ops.reduce<
    { readonly answers: ReadonlyArray<Result.Result<S3Reply, { readonly code: string }>>; readonly store: Store }
  >(
    (acc, op) => {
      const [answer, next] = apply(acc.store, op, now)
      return { answers: [...acc.answers, answer], store: next }
    },
    { answers: [], store }
  )

const last = (ops: ReadonlyArray<Operation>, store?: Store, now?: DateTime.Utc) => {
  const { answers } = run(ops, store, now)
  return answers[answers.length - 1]
}

const codeOf = (answer: Result.Result<S3Reply, { readonly code: string }> | undefined) =>
  answer === undefined ? "none" : Result.match(answer, { onFailure: (e) => e.code, onSuccess: (r) => r._tag })

const bytes = (s: string) => new TextEncoder().encode(s)
const create = (bucket: string) => Operation.CreateBucket({ bucket })
const put = (bucket: string, key: string, body: Uint8Array<ArrayBuffer> = bytes(key), contentType = "text/plain") =>
  Operation.PutObject({ bucket, key, body, contentType })
const get = (bucket: string, key: string, ifNoneMatch?: string) => Operation.GetObject({ bucket, key, ifNoneMatch })
const list = (bucket: string, prefix = "", maxKeys = 1000) =>
  Operation.ListObjectsV2({ bucket, prefix, maxKeys, urlEncoded: false, fetchOwner: false })

const keysIn = (store: Store, bucket: string) =>
  Option.match(HashMap.get(store, bucket), {
    onNone: () => [],
    onSome: (b) => HashMap.toEntries(b.objects).map(([k]) => k).sort()
  })

describe("S3 kernel: objects", () => {
  it.prop(
    "put then get returns the exact bytes, type, and the MD5 ETag",
    { key: ObjectKey, body: Schema.Uint8Array, contentType: Schema.String },
    ({ body, contentType, key }) => {
      const sent = new Uint8Array(body)
      const answer = last([create("b"), put("b", key, sent, contentType), get("b", key)])
      const reply = answer === undefined ? undefined : Result.getOrThrow(answer)
      expect(reply?._tag).toBe("ObjectFound")
      if (reply?._tag !== "ObjectFound") return
      expect(reply.object.body).toEqual(sent)
      expect(reply.object.contentType).toBe(contentType)
      expect(reply.object.etag).toBe(etagOf(sent))
      expect(reply.object.etag).toMatch(/^"[0-9a-f]{32}"$/)
    },
    { arbitrary: { runs: 100 } }
  )

  it("a second put replaces the object and its ETag", () => {
    const { answers } = run([create("b"), put("b", "k", bytes("one")), put("b", "k", bytes("two")), get("b", "k")])
    const found = answers[3] === undefined ? undefined : Result.getOrThrow(answers[3])
    expect(found?._tag === "ObjectFound" ? found.object.etag : "").toBe(etagOf(bytes("two")))
  })

  it("stamps objects with the time the operation ran", () => {
    const { store } = run([create("b"), put("b", "k")], emptyStore, T1)
    const object = Option.flatMap(HashMap.get(store, "b"), (b) => HashMap.get(b.objects, "k"))
    expect(Option.map(object, (o) => o.lastModified)).toEqual(Option.some(T1))
  })

  it("a missing key is NoSuchKey and a missing bucket NoSuchBucket, for every object operation", () => {
    const ready = run([create("b")]).store
    expect(codeOf(last([get("b", "none")], ready))).toBe("NoSuchKey")
    expect(codeOf(last([Operation.HeadObject({ bucket: "b", key: "none", ifNoneMatch: undefined })], ready))).toBe(
      "NoSuchKey"
    )
    for (
      const op of [
        get("nope", "k"),
        put("nope", "k"),
        Operation.DeleteObject({ bucket: "nope", key: "k" }),
        Operation.DeleteObjects({ bucket: "nope", keys: ["k"], quiet: false }),
        list("nope"),
        Operation.CopyObject({ bucket: "b", key: "k", sourceBucket: "nope", sourceKey: "s" })
      ]
    ) {
      expect(codeOf(last([op], ready))).toBe("NoSuchBucket")
    }
  })

  it("If-None-Match with the current ETag (or *) is ObjectNotModified; any other is the object", () => {
    const ready = run([create("b"), put("b", "k")]).store
    const etag = etagOf(bytes("k"))
    expect(codeOf(last([get("b", "k", etag)], ready))).toBe("ObjectNotModified")
    expect(codeOf(last([get("b", "k", "*")], ready))).toBe("ObjectNotModified")
    expect(codeOf(last([get("b", "k", `"stale", ${etag}`)], ready))).toBe("ObjectNotModified")
    expect(codeOf(last([get("b", "k", "\"stale\"")], ready))).toBe("ObjectFound")
  })

  it("noneMatch accepts weak and unquoted tags", () => {
    expect(noneMatch("W/\"abc\"", "\"abc\"")).toBe(true)
    expect(noneMatch("abc", "\"abc\"")).toBe(true)
    expect(noneMatch("\"abcd\"", "\"abc\"")).toBe(false)
  })

  it("copy keeps body, type and ETag with a fresh LastModified, across buckets too", () => {
    const ready = run([create("a"), create("b"), put("a", "src", bytes("data"), "application/pdf")]).store
    const { answers, store } = run(
      [Operation.CopyObject({ bucket: "b", key: "dst", sourceBucket: "a", sourceKey: "src" }), get("b", "dst")],
      ready,
      T1
    )
    const found = answers[1] === undefined ? undefined : Result.getOrThrow(answers[1])
    expect(found?._tag === "ObjectFound" ? found.object : undefined).toEqual({
      body: bytes("data"),
      contentType: "application/pdf",
      etag: etagOf(bytes("data")),
      lastModified: T1
    })
    expect(keysIn(store, "a")).toEqual(["src"])
  })

  it("copying a missing source is NoSuchKey and changes nothing", () => {
    const ready = run([create("b")]).store
    const [answer, next] = apply(
      ready,
      Operation.CopyObject({ bucket: "b", key: "dst", sourceBucket: "b", sourceKey: "gone" }),
      T0
    )
    expect(codeOf(answer)).toBe("NoSuchKey")
    expect(next).toBe(ready)
  })
})

describe("S3 kernel: DeleteObjects", () => {
  it.prop(
    "partitions the keys into deleted and errors, removes exactly the deleted, and leaves the rest",
    {
      stored: Schema.Array(ObjectKey),
      requested: Schema.NonEmptyArray(Schema.Union([ObjectKey, Schema.Literal(""), Schema.Literal("x".repeat(1025))])),
      quiet: Schema.Boolean
    },
    ({ quiet, requested, stored }) => {
      const ready = run([create("b"), ...stored.map((k) => put("b", k))]).store
      const [answer, next] = apply(ready, Operation.DeleteObjects({ bucket: "b", keys: requested, quiet }), T0)
      const reply = Result.getOrThrow(answer)
      expect(reply._tag).toBe("ObjectsDeleted")
      if (reply._tag !== "ObjectsDeleted") return

      // Every requested key lands in exactly one side
      const failed = reply.errors.map((e) => e.key)
      expect([...reply.deleted, ...failed].sort()).toEqual([...requested].sort())
      expect(failed.every((k) => k === "" || k.length > 1024)).toBe(true)
      expect(reply.quiet).toBe(quiet)

      // A deleted key is gone whether or not it existed; unrequested keys stay
      const remaining = keysIn(next, "b")
      expect(remaining).toEqual([...new Set(stored.filter((k) => !reply.deleted.includes(k)))].sort())
    },
    { arbitrary: { runs: 100 } }
  )
})

describe("S3 kernel: buckets", () => {
  it("creating an existing bucket is BucketAlreadyOwnedByYou, and keeps its objects", () => {
    const { answers, store } = run([create("b"), put("b", "k"), create("b")])
    expect(codeOf(answers[2])).toBe("BucketAlreadyOwnedByYou")
    expect(keysIn(store, "b")).toEqual(["k"])
  })

  it("a bucket with objects is BucketNotEmpty; once emptied it deletes, and then is gone", () => {
    const { answers } = run([
      create("b"),
      put("b", "k"),
      Operation.DeleteBucket({ bucket: "b" }),
      Operation.DeleteObject({ bucket: "b", key: "k" }),
      Operation.DeleteBucket({ bucket: "b" }),
      Operation.HeadBucket({ bucket: "b" })
    ])
    expect(answers.map(codeOf)).toEqual([
      "BucketCreated",
      "ObjectStored",
      "BucketNotEmpty",
      "ObjectDeleted",
      "BucketDeleted",
      "NoSuchBucket"
    ])
  })

  it("lists buckets by name with their creation time", () => {
    const answer = last([create("zeta"), create("alpha"), Operation.ListBuckets()])
    expect(answer === undefined ? undefined : Result.getOrThrow(answer)).toMatchObject({
      buckets: [{ name: "alpha", createdAt: T0 }, { name: "zeta", createdAt: T0 }]
    })
  })

  it("ownership controls and policy are accepted on an existing bucket, and change nothing", () => {
    const ready = run([create("b"), put("b", "k")]).store
    for (
      const op of [Operation.PutBucketOwnershipControls({ bucket: "b" }), Operation.PutBucketPolicy({ bucket: "b" })]
    ) {
      const [answer, next] = apply(ready, op, T0)
      expect(Result.isSuccess(answer)).toBe(true)
      expect(next).toBe(ready)
      expect(codeOf(last([Operation.PutBucketPolicy({ bucket: "nope" })], ready))).toBe("NoSuchBucket")
      expect(codeOf(last([Operation.PutBucketOwnershipControls({ bucket: "nope" })], ready))).toBe("NoSuchBucket")
    }
  })

  it("versioning is never enabled", () => {
    expect(codeOf(last([create("b"), Operation.GetBucketVersioning({ bucket: "b" })]))).toBe("VersioningNeverEnabled")
  })
})

describe("S3 kernel: ListObjectsV2", () => {
  it.prop(
    "lists exactly the keys under the prefix, in UTF-8 byte order",
    { keys: Schema.Array(ObjectKey), prefix: Schema.String },
    ({ keys, prefix }) => {
      const answer = last([create("b"), ...keys.map((k) => put("b", k)), list("b", prefix)])
      const reply = answer === undefined ? undefined : Result.getOrThrow(answer)
      if (reply?._tag !== "ObjectListing") throw new Error(`unexpected ${reply?._tag}`)
      const expected = [...new Set(keys.filter((k) => k.startsWith(prefix)))].sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b))
      )
      expect(reply.objects.map((o) => o.key)).toEqual(expected)
    }
  )

  it("orders by UTF-8 bytes, not UTF-16 code units", () => {
    // U+FF5E sorts after U+1F600 in UTF-16 but before it in UTF-8
    const answer = last([create("b"), put("b", "😀"), put("b", "～"), list("b")])
    const reply = answer === undefined ? undefined : Result.getOrThrow(answer)
    expect(reply?._tag === "ObjectListing" ? reply.objects.map((o) => o.key) : []).toEqual(["～", "😀"])
  })

  it("a listing longer than max-keys is NotImplemented rather than truncated", () => {
    const ready = run([create("b"), put("b", "a"), put("b", "b")]).store
    expect(codeOf(last([list("b", "", 1)], ready))).toBe("NotImplemented")
    expect(codeOf(last([list("b", "", 2)], ready))).toBe("ObjectListing")
    expect(codeOf(last([list("b", "a", 1)], ready))).toBe("ObjectListing")
  })
})
