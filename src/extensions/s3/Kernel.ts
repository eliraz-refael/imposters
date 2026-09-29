/**
 * The S3 state machine: a pure `apply(store, operation, now)` that answers an operation and
 * returns the next store. It knows nothing of HTTP or XML, and runs inside `Ref.modify`, so
 * every operation is atomic.
 */
import * as Data from "effect/Data"
import type * as DateTime from "effect/DateTime"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { createHash } from "node:crypto"
import { keyTooLong, type Operation } from "./Operation"
import { bucketResource, noSuchBucket, noSuchKey, notImplemented, S3Error } from "./S3Error"

export interface StoredObject {
  readonly body: Uint8Array<ArrayBuffer>
  readonly contentType: string
  /** Quoted MD5 hex of the body, as S3 sends it for a single-part upload */
  readonly etag: string
  readonly lastModified: DateTime.Utc
}

export interface StoredBucket {
  readonly createdAt: DateTime.Utc
  readonly objects: HashMap.HashMap<string, StoredObject>
}

/** Every bucket, by name. Held per imposter start, so it is empty again after a restart. */
export type Store = HashMap.HashMap<string, StoredBucket>

export const emptyStore: Store = HashMap.empty()

export interface ListedObject {
  readonly key: string
  readonly object: StoredObject
}

export interface DeleteFailure {
  readonly key: string
  readonly code: string
  readonly message: string
}

export type S3Reply = Data.TaggedEnum<{
  BucketList: { readonly buckets: ReadonlyArray<{ readonly name: string; readonly createdAt: DateTime.Utc }> }
  BucketCreated: { readonly bucket: string }
  BucketFound: Record<never, never>
  BucketDeleted: Record<never, never>
  /** Versioning was never enabled: an empty VersioningConfiguration */
  VersioningNeverEnabled: Record<never, never>
  OwnershipControlsAccepted: Record<never, never>
  PolicyAccepted: Record<never, never>
  ObjectListing: {
    readonly bucket: string
    readonly prefix: string
    readonly maxKeys: number
    readonly urlEncoded: boolean
    readonly fetchOwner: boolean
    readonly objects: ReadonlyArray<ListedObject>
  }
  ObjectStored: { readonly object: StoredObject }
  ObjectFound: { readonly object: StoredObject; readonly head: boolean }
  ObjectNotModified: { readonly object: StoredObject }
  ObjectCopied: { readonly object: StoredObject }
  ObjectDeleted: Record<never, never>
  ObjectsDeleted: {
    readonly deleted: ReadonlyArray<string>
    readonly errors: ReadonlyArray<DeleteFailure>
    readonly quiet: boolean
  }
}>

export const S3Reply = Data.taggedEnum<S3Reply>()

export const etagOf = (body: Uint8Array): string => `"${createHash("md5").update(body).digest("hex")}"`

// S3 lists keys in UTF-8 binary order, which differs from JS (UTF-16) order past the BMP
const encoder = new TextEncoder()
const byUtf8 = (a: string, b: string): number => Buffer.compare(encoder.encode(a), encoder.encode(b))

// If-None-Match is a comma-separated list of (possibly weak) entity tags, or `*`
export const noneMatch = (header: string, etag: string): boolean =>
  header.split(",").map((t) => t.trim()).some((t) => {
    const tag = t.startsWith("W/") ? t.slice(2) : t
    return tag === "*" || tag === etag || `"${tag}"` === etag
  })

type Answer = readonly [Result.Result<S3Reply, S3Error>, Store]

const reply = (value: S3Reply, store: Store): Answer => [Result.succeed(value), store]
const refuse = (error: S3Error, store: Store): Answer => [Result.fail(error), store]

// Runs `f` against an existing bucket, or refuses with NoSuchBucket
const inBucket = (store: Store, bucket: string, f: (b: StoredBucket) => Answer): Answer =>
  Option.match(HashMap.get(store, bucket), {
    onNone: () => refuse(noSuchBucket(bucket), store),
    onSome: f
  })

const withObjects = (store: Store, bucket: string, b: StoredBucket, objects: StoredBucket["objects"]): Store =>
  HashMap.set(store, bucket, { ...b, objects })

const deleteFailureOf = (key: string): DeleteFailure | undefined =>
  key === ""
    ? { key, code: "InvalidArgument", message: "An object key must not be empty" }
    : keyTooLong(key)
    ? { key, code: "KeyTooLongError", message: "Your key is too long" }
    : undefined

/** Answers `op` against `store` at time `now`, returning the reply and the next store */
export const apply = (store: Store, op: Operation, now: DateTime.Utc): Answer => {
  switch (op._tag) {
    case "ListBuckets":
      return reply(
        S3Reply.BucketList({
          buckets: HashMap.toEntries(store)
            .map(([name, b]) => ({ name, createdAt: b.createdAt }))
            .sort((a, b) => byUtf8(a.name, b.name))
        }),
        store
      )

    case "CreateBucket":
      return HashMap.has(store, op.bucket)
        ? refuse(
          new S3Error({
            code: "BucketAlreadyOwnedByYou",
            message: "Your previous request to create the named bucket succeeded and you already own it.",
            resource: bucketResource(op.bucket)
          }),
          store
        )
        : reply(
          S3Reply.BucketCreated({ bucket: op.bucket }),
          HashMap.set(store, op.bucket, { createdAt: now, objects: HashMap.empty() })
        )

    case "HeadBucket":
      return inBucket(store, op.bucket, () => reply(S3Reply.BucketFound(), store))

    case "DeleteBucket":
      return inBucket(store, op.bucket, (b) =>
        HashMap.isEmpty(b.objects)
          ? reply(S3Reply.BucketDeleted(), HashMap.remove(store, op.bucket))
          : refuse(
            new S3Error({
              code: "BucketNotEmpty",
              message: "The bucket you tried to delete is not empty",
              resource: bucketResource(op.bucket)
            }),
            store
          ))

    case "GetBucketVersioning":
      return inBucket(store, op.bucket, () => reply(S3Reply.VersioningNeverEnabled(), store))

    // Accepted so provisioning runs, but neither stored nor enforced
    case "PutBucketOwnershipControls":
      return inBucket(store, op.bucket, () => reply(S3Reply.OwnershipControlsAccepted(), store))

    case "PutBucketPolicy":
      return inBucket(store, op.bucket, () => reply(S3Reply.PolicyAccepted(), store))

    case "ListObjectsV2":
      return inBucket(store, op.bucket, (b) => {
        const objects = HashMap.toEntries(b.objects)
          .filter(([key]) => key.startsWith(op.prefix))
          .sort(([x], [y]) => byUtf8(x, y))
          .map(([key, object]) => ({ key, object }))
        // A truncated listing needs continuation tokens, which the emulator does not issue
        return objects.length > op.maxKeys
          ? refuse(
            notImplemented(
              `A listing of more than max-keys (${op.maxKeys}) objects, which needs pagination,`,
              bucketResource(op.bucket)
            ),
            store
          )
          : reply(
            S3Reply.ObjectListing({
              bucket: op.bucket,
              prefix: op.prefix,
              maxKeys: op.maxKeys,
              urlEncoded: op.urlEncoded,
              fetchOwner: op.fetchOwner,
              objects
            }),
            store
          )
      })

    case "PutObject":
      return inBucket(store, op.bucket, (b) => {
        const object: StoredObject = {
          body: op.body,
          contentType: op.contentType,
          etag: etagOf(op.body),
          lastModified: now
        }
        return reply(
          S3Reply.ObjectStored({ object }),
          withObjects(store, op.bucket, b, HashMap.set(b.objects, op.key, object))
        )
      })

    case "GetObject":
    case "HeadObject":
      return inBucket(store, op.bucket, (b) =>
        Option.match(HashMap.get(b.objects, op.key), {
          onNone: () => refuse(noSuchKey(op.bucket, op.key), store),
          onSome: (object) =>
            op.ifNoneMatch !== undefined && noneMatch(op.ifNoneMatch, object.etag)
              ? reply(S3Reply.ObjectNotModified({ object }), store)
              : reply(S3Reply.ObjectFound({ object, head: op._tag === "HeadObject" }), store)
        }))

    case "CopyObject":
      return inBucket(store, op.sourceBucket, (source) =>
        Option.match(HashMap.get(source.objects, op.sourceKey), {
          onNone: () => refuse(noSuchKey(op.sourceBucket, op.sourceKey), store),
          onSome: (original) =>
            inBucket(store, op.bucket, (target) => {
              const object: StoredObject = { ...original, lastModified: now }
              return reply(
                S3Reply.ObjectCopied({ object }),
                withObjects(store, op.bucket, target, HashMap.set(target.objects, op.key, object))
              )
            })
        }))

    case "DeleteObject":
      return inBucket(
        store,
        op.bucket,
        (b) => reply(S3Reply.ObjectDeleted(), withObjects(store, op.bucket, b, HashMap.remove(b.objects, op.key)))
      )

    case "DeleteObjects":
      return inBucket(store, op.bucket, (b) => {
        // A key that is not there counts as deleted, as it does on S3
        const errors = op.keys.flatMap((key) => {
          const failure = deleteFailureOf(key)
          return failure === undefined ? [] : [failure]
        })
        const deleted = op.keys.filter((key) => deleteFailureOf(key) === undefined)
        const objects = deleted.reduce((acc, key) => HashMap.remove(acc, key), b.objects)
        return reply(
          S3Reply.ObjectsDeleted({ deleted, errors, quiet: op.quiet }),
          withObjects(store, op.bucket, b, objects)
        )
      })
  }
}
