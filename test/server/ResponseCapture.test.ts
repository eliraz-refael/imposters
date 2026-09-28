import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { captureResponse } from "imposters/server/ResponseCapture"
import { describe, expect } from "vitest"

const LOG_BODY_LIMIT_BYTES = 10240

const utf8 = (s: string) => new TextEncoder().encode(s)

describe("captureResponse", () => {
  it.effect.prop(
    "returns a byte-identical response for arbitrary bytes",
    { bytes: Schema.Uint8Array },
    ({ bytes }) =>
      Effect.gen(function*() {
        const sent = new Uint8Array(bytes)
        const captured = yield* Effect.promise(() =>
          captureResponse(new Response(sent, { status: 200, headers: { "content-type": "application/octet-stream" } }))
        )
        expect(captured.response.status).toBe(200)
        expect(captured.headers["content-type"]).toBe("application/octet-stream")
        const received = new Uint8Array(yield* Effect.promise(() => captured.response.arrayBuffer()))
        expect(received).toEqual(sent)
      }),
    { arbitrary: { runs: 50 } }
  )

  it.effect.prop(
    "logBody is the UTF-8 text of a short body",
    { s: Schema.String },
    ({ s }) =>
      Effect.gen(function*() {
        const captured = yield* Effect.promise(() => captureResponse(new Response(utf8(s))))
        expect(captured.logBody).toBe(s === "" ? undefined : new TextDecoder().decode(utf8(s)))
      }),
    { arbitrary: { runs: 50 } }
  )

  it.each([204, 205, 304])("handles null-body status %i without throwing", async (status) => {
    const captured = await captureResponse(new Response(null, { status, headers: { etag: "\"abc\"" } }))
    expect(captured.response.status).toBe(status)
    expect(captured.response.body).toBeNull()
    expect(captured.headers["etag"]).toBe("\"abc\"")
    expect(captured.logBody).toBeUndefined()
  })

  it("logBody is undefined for a binary body", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
    const captured = await captureResponse(new Response(jpeg))
    expect(captured.logBody).toBeUndefined()
    expect(new Uint8Array(await captured.response.arrayBuffer())).toEqual(jpeg)
  })

  it("logBody is undefined for a short body ending in an incomplete character", async () => {
    // Under the limit the whole body is decoded strictly, so a dangling lead byte means binary
    const captured = await captureResponse(new Response(new Uint8Array([0x41, 0xc3])))
    expect(captured.logBody).toBeUndefined()
  })

  it("logBody is undefined for an empty body", async () => {
    const captured = await captureResponse(new Response(""))
    expect(captured.logBody).toBeUndefined()
  })

  it.each([{ char: "é", width: 2 }, { char: "€", width: 3 }, { char: "😀", width: 4 }])(
    "logBody is text when $char ($width bytes) is cut at the log limit",
    async ({ char, width }) => {
      // The character starts one byte before the limit, so the log prefix ends mid-character
      const prefix = "a".repeat(LOG_BODY_LIMIT_BYTES - 1)
      const body = utf8(prefix + char + "tail")
      expect(utf8(char).length).toBe(width)
      const captured = await captureResponse(new Response(body))
      expect(captured.logBody).toBe(prefix)
      expect(new Uint8Array(await captured.response.arrayBuffer())).toEqual(body)
    }
  )

  it("logBody is truncated to the log limit", async () => {
    const captured = await captureResponse(new Response("x".repeat(LOG_BODY_LIMIT_BYTES * 2)))
    expect(captured.logBody).toBe("x".repeat(LOG_BODY_LIMIT_BYTES))
  })
})
