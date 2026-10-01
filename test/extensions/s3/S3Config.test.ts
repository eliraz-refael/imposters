import {
  CreateBucketCommand,
  GetObjectCommand,
  ListBucketsCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3"
import { Effect, ManagedRuntime, Schema } from "effect"
import { createConfiguredImposters, loadConfigFile } from "imposters/cli/ConfigLoader"
import { makeTestServer } from "imposters/client/testing"
import { S3Extension } from "imposters/extensions/s3/S3Extension"
import { PortNumber } from "imposters/schemas/common"
import * as path from "node:path"
import { afterAll, describe, expect, it } from "vitest"

// Ports 8831-8839 belong to this file.

const server = makeTestServer({ extensions: [S3Extension] })
const runtime = ManagedRuntime.make(server.clientLayer)

afterAll(async () => {
  await runtime.dispose()
  server.dispose()
})

const EXAMPLE = path.join(__dirname, "../../../examples/s3.json")

describe("an S3 imposter from a config file", () => {
  it("examples/s3.json declares an S3 imposter on 7070", async () => {
    const config = await runtime.runPromise(loadConfigFile(EXAMPLE))
    expect(config.imposters.map((i) => [i.name, i.port, i.protocol])).toEqual([["local-s3", 7070, "S3"]])
  })

  it("loads through the CLI's config path and serves S3", async () => {
    // The example, moved off 7070 so the test never collides with a real local S3
    const port = Schema.decodeUnknownSync(PortNumber)(8831)
    await runtime.runPromise(
      loadConfigFile(EXAMPLE).pipe(
        Effect.andThen((config) => createConfiguredImposters(config.imposters.map((i) => ({ ...i, port }))))
      )
    )

    const client = new S3Client({
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${port}`,
      forcePathStyle: true,
      credentials: { accessKeyId: "local-dev", secretAccessKey: "local-dev-secret" }
    })
    try {
      await client.send(new CreateBucketCommand({ Bucket: "from-config" }))
      await client.send(new PutObjectCommand({ Bucket: "from-config", Key: "k", Body: new Uint8Array([1, 2, 3]) }))
      const read = await client.send(new GetObjectCommand({ Bucket: "from-config", Key: "k" }))
      expect(await read.Body?.transformToByteArray()).toEqual(new Uint8Array([1, 2, 3]))
      const buckets = await client.send(new ListBucketsCommand({}))
      expect(buckets.Buckets?.map((b) => b.Name)).toEqual(["from-config"])
    } finally {
      client.destroy()
    }
  })
})
