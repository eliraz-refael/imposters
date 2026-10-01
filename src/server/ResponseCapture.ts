import { decodeUtf8 } from "../matching/RequestMatcher.js"
import { isNullBodyStatus } from "../matching/ResponseGenerator.js"

const LOG_BODY_LIMIT_BYTES = 10240

export interface CapturedResponse {
  /** An unread copy of the response, byte-identical to the original */
  readonly response: Response
  readonly headers: Record<string, string>
  /** The first 10 KiB of the body as text, or `undefined` when the body is empty or binary */
  readonly logBody: string | undefined
}

/**
 * Reads a response once for the request log, and hands back a fresh copy to send.
 * Bodies are handled as bytes, so binary responses (images, archives) pass through untouched.
 */
export const captureResponse = async (response: Response): Promise<CapturedResponse> => {
  const bytes = new Uint8Array(await response.arrayBuffer())
  const headers: Record<string, string> = {}
  response.headers.forEach((val, key) => {
    headers[key] = val
  })
  // Only a truncated prefix may end mid-character; a complete body must be strictly valid UTF-8
  const truncated = bytes.length > LOG_BODY_LIMIT_BYTES
  const logBody = bytes.length === 0 ? undefined : decodeUtf8(bytes.subarray(0, LOG_BODY_LIMIT_BYTES), truncated)
  return {
    response: new Response(isNullBodyStatus(response.status) ? null : bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    }),
    headers,
    logBody
  }
}
