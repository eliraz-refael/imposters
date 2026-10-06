import { it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { NonEmptyString } from "imposters/schemas/common"
import type { RequestLogEntry } from "imposters/schemas/RequestLogSchema"
import { bodyText, hasUnloggedBody, replayRequest, shellQuote, toCurl } from "imposters/ui/resend"
import { execFileSync } from "node:child_process"
import { describe, expect } from "vitest"

const ORIGIN = "http://127.0.0.1:3001"

const entry = (request: Partial<RequestLogEntry["request"]>): RequestLogEntry => ({
  id: NonEmptyString.make("req-1"),
  imposterId: NonEmptyString.make("imp"),
  timestamp: DateTime.makeUnsafe(0),
  request: { method: "GET", path: "/", headers: {}, query: {}, ...request },
  response: { status: 200, headers: {}, proxied: false, outcome: "unmatched" },
  duration: 1
})

// What a POSIX shell hands curl: the command run with `curl` defined as a function that prints
// each of its arguments, NUL-separated. This is the shell's own reading of the quoting.
// A logged string is decoded UTF-8, so it never holds a lone surrogate (nor, as a shell word, a NUL)
const loggable = (s: string): string => new TextDecoder().decode(new TextEncoder().encode(s)).replaceAll("\u0000", "")

const shellArgs = (command: string): Array<string> => {
  const out = execFileSync("sh", ["-c", `curl() { for a in "$@"; do printf '%s\\0' "$a"; done; }\n${command}`], {
    encoding: "utf8"
  })
  return out.split("\0").slice(0, -1)
}

describe("shellQuote", () => {
  it("leaves a plain word alone and single-quotes anything the shell would read", () => {
    expect(shellQuote("GET")).toBe("GET")
    expect(shellQuote("http://h:1/a")).toBe("http://h:1/a")
    expect(shellQuote("")).toBe("''")
    expect(shellQuote("a b")).toBe("'a b'")
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(shellQuote("$HOME `id` \\ \"x\" *")).toBe(`'$HOME \`id\` \\ "x" *'`)
  })

  it.prop("any string without a NUL reads back as itself", { s: Schema.String }, ({ s }) => {
    const value = loggable(s)
    expect(shellArgs(`curl ${shellQuote(value)}`)).toEqual([value])
  }, { arbitrary: { runs: 150 } })
})

describe("toCurl", () => {
  it("a plain GET is curl and the URL, with its query", () => {
    const command = toCurl(entry({ path: "/orders", query: { status: "open", q: "a b&c" } }), ORIGIN)
    expect(command).toBe(`curl 'http://127.0.0.1:3001/orders?status=open&q=a+b%26c'`)
    expect(shellArgs(command)).toEqual(["http://127.0.0.1:3001/orders?status=open&q=a+b%26c"])
  })

  it("quotes headers and bodies with spaces, quotes, dollars and newlines", () => {
    const body = `{"note":"it's $5, \`echo pwned\`"}\nline two`
    const command = toCurl(
      entry({
        method: "POST",
        path: "/orders",
        headers: { "content-type": "application/json", "x-quote": `"double" and 'single'` },
        body
      }),
      ORIGIN
    )
    expect(command).toContain(" \\\n  -H ")
    expect(shellArgs(command)).toEqual([
      "http://127.0.0.1:3001/orders",
      "-H",
      "content-type: application/json",
      "-H",
      `x-quote: "double" and 'single'`,
      "--data-raw",
      body
    ])
  })

  it("sends a JSON body as JSON, not as [object Object]", () => {
    const command = toCurl(
      entry({ method: "PUT", headers: { "content-type": "application/json" }, body: { a: [1, "x'y"] } }),
      ORIGIN
    )
    expect(shellArgs(command)).toEqual([
      "-X",
      "PUT",
      "http://127.0.0.1:3001/",
      "-H",
      "content-type: application/json",
      "--data-raw",
      `{"a":[1,"x'y"]}`
    ])
  })

  it("leaves out the headers curl sets itself, and keeps a repeated header's joined value as one", () => {
    const command = toCurl(
      entry({
        headers: {
          host: "127.0.0.1:3001",
          "content-length": "0",
          connection: "keep-alive",
          "accept-encoding": "gzip",
          expect: "100-continue",
          accept: "text/html, application/json",
          "user-agent": "orders-worker/2.3"
        }
      }),
      ORIGIN
    )
    expect(shellArgs(command).filter((a) => a !== "-H")).toEqual([
      "http://127.0.0.1:3001/",
      "accept: text/html, application/json",
      "user-agent: orders-worker/2.3"
    ])
  })

  it("names the method only where curl would not infer it", () => {
    const methodArgs = (request: Partial<RequestLogEntry["request"]>) =>
      shellArgs(toCurl(entry(request), ORIGIN)).filter((a) => a === "-X" || a === "--head" || /^[A-Z]+$/.test(a))
    expect(methodArgs({ method: "GET" })).toEqual([])
    expect(methodArgs({ method: "HEAD" })).toEqual(["--head"])
    expect(methodArgs({ method: "POST" })).toEqual(["-X", "POST"])
    expect(methodArgs({ method: "POST", body: "x" })).toEqual([])
    // Data makes curl POST, so a GET with a body says GET
    expect(methodArgs({ method: "GET", body: "x" })).toEqual(["-X", "GET"])
    expect(methodArgs({ method: "DELETE" })).toEqual(["-X", "DELETE"])
  })

  it("an empty text body is still sent, and with no content type curl adds none", () => {
    const command = toCurl(entry({ method: "POST", body: "" }), ORIGIN)
    expect(shellArgs(command)).toEqual(["http://127.0.0.1:3001/", "-H", "content-type:", "--data-raw", ""])
  })

  it("a body that was not text reads from a file, and says so first", () => {
    const command = toCurl(
      entry({
        method: "PUT",
        path: "/media/cat.jpg",
        headers: { "content-type": "image/jpeg", "content-length": "2048" }
      }),
      ORIGIN
    )
    expect(command.split("\n")[0]).toMatch(/^# The body was not text/)
    expect(shellArgs(command)).toEqual([
      "-X",
      "PUT",
      "http://127.0.0.1:3001/media/cat.jpg",
      "-H",
      "content-type: image/jpeg",
      "--data-binary",
      "@body.bin"
    ])
    // A NUL cannot be in a shell word
    expect(toCurl(entry({ method: "POST", body: "a\u0000b" }), ORIGIN)).toContain("--data-binary @body.bin")
  })

  it("turns off curl's globbing for a path with brackets or braces", () => {
    const command = toCurl(entry({ path: "/items/[1]/{x}" }), ORIGIN)
    expect(shellArgs(command)).toEqual(["--globoff", "http://127.0.0.1:3001/items/[1]/{x}"])
  })

  it.prop(
    "any header value and body reach curl as they were logged",
    { value: Schema.String, body: Schema.String },
    ({ body, value }) => {
      const cleanValue = loggable(value).replaceAll(/[\r\n]/g, "")
      const cleanBody = loggable(body)
      const args = shellArgs(
        toCurl(
          entry({ method: "POST", headers: { "x-any": cleanValue, "content-type": "text/plain" }, body: cleanBody }),
          ORIGIN
        )
      )
      expect(args).toEqual([
        "http://127.0.0.1:3001/",
        "-H",
        `x-any: ${cleanValue}`,
        "-H",
        "content-type: text/plain",
        "--data-raw",
        cleanBody
      ])
    },
    { arbitrary: { runs: 100 } }
  )
})

describe("bodyText and hasUnloggedBody", () => {
  it("a string body is itself, JSON is JSON, nothing is undefined", () => {
    expect(bodyText("a")).toBe("a")
    expect(bodyText({ a: 1 })).toBe(`{"a":1}`)
    expect(bodyText(null)).toBe("null")
    expect(bodyText(undefined)).toBeUndefined()
  })

  it("an empty body declared with a length, or chunked, was not kept", () => {
    expect(hasUnloggedBody(entry({ headers: { "content-length": "10" } }).request)).toBe(true)
    expect(hasUnloggedBody(entry({ headers: { "transfer-encoding": "chunked" } }).request)).toBe(true)
    expect(hasUnloggedBody(entry({ headers: { "content-length": "0" } }).request)).toBe(false)
    expect(hasUnloggedBody(entry({ headers: { "content-length": "10" }, body: "0123456789" }).request)).toBe(false)
  })
})

describe("replayRequest", () => {
  it("rebuilds the method, path, query, headers and body", async () => {
    const replay = replayRequest(
      entry({
        method: "POST",
        path: "/orders",
        query: { a: "1" },
        headers: { "content-type": "application/json", "x-id": "7", host: "example.test:9", "content-length": "99" },
        body: { sku: "mug" }
      }),
      "http://localhost:3001"
    )
    expect(replay._tag).toBe("Ready")
    if (replay._tag !== "Ready") return
    const { request } = replay
    expect(request.method).toBe("POST")
    expect(request.url).toBe("http://localhost:3001/orders?a=1")
    expect(request.headers.get("x-id")).toBe("7")
    expect(request.headers.get("host")).toBe("example.test:9")
    // The length of what is sent now
    expect(request.headers.get("content-length")).toBe("13")
    expect(await request.text()).toBe(`{"sku":"mug"}`)
  })

  it("adds no content type the request did not have", () => {
    const replay = replayRequest(entry({ method: "POST", body: "plain" }), "http://localhost:3001")
    expect(replay._tag === "Ready" && replay.request.headers.get("content-type")).toBeNull()
  })

  it("sends no body with GET or HEAD", () => {
    const replay = replayRequest(entry({ method: "GET", body: "odd" }), "http://localhost:3001")
    expect(replay._tag === "Ready" && replay.request.body).toBeNull()
  })

  it("refuses a body the log could not keep", () => {
    const replay = replayRequest(
      entry({ method: "PUT", headers: { "content-length": "2048" } }),
      "http://localhost:3001"
    )
    expect(replay).toEqual({ _tag: "Refused", reason: expect.stringContaining("not text") })
  })
})
