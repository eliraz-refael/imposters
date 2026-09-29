import * as Data from "effect/Data"

/** Every S3 error code the emulator answers with */
export type S3ErrorCode =
  | "AccessDenied"
  | "BucketAlreadyOwnedByYou"
  | "BucketNotEmpty"
  | "InvalidArgument"
  | "InvalidBucketName"
  | "InvalidRequest"
  | "InvalidURI"
  | "KeyTooLongError"
  | "MalformedXML"
  | "NoSuchBucket"
  | "NoSuchKey"
  | "NotImplemented"

/** The HTTP status real S3 sends with each code */
export const errorStatus: { readonly [Code in S3ErrorCode]: number } = {
  AccessDenied: 403,
  BucketAlreadyOwnedByYou: 409,
  BucketNotEmpty: 409,
  InvalidArgument: 400,
  InvalidBucketName: 400,
  InvalidRequest: 400,
  InvalidURI: 400,
  KeyTooLongError: 400,
  MalformedXML: 400,
  NoSuchBucket: 404,
  NoSuchKey: 404,
  NotImplemented: 501
}

/** An S3 error answer. `resource` is the path it concerns, e.g. `/bucket/key`. */
export class S3Error extends Data.TaggedError("S3Error")<{
  readonly code: S3ErrorCode
  readonly message: string
  readonly resource: string
}> {}

export const bucketResource = (bucket: string): string => `/${bucket}`
export const objectResource = (bucket: string, key: string): string => `/${bucket}/${key}`

export const noSuchBucket = (bucket: string): S3Error =>
  new S3Error({
    code: "NoSuchBucket",
    message: "The specified bucket does not exist",
    resource: bucketResource(bucket)
  })

export const noSuchKey = (bucket: string, key: string): S3Error =>
  new S3Error({
    code: "NoSuchKey",
    message: "The specified key does not exist.",
    resource: objectResource(bucket, key)
  })

/** A request the emulator recognises but deliberately does not serve */
export const notImplemented = (what: string, resource: string): S3Error =>
  new S3Error({ code: "NotImplemented", message: `${what} is not implemented by the imposters S3 emulator`, resource })
