import { it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Extensions, findExtension, type ImposterExtension, supportedProtocols } from "imposters/extensions/Extension"
import { Protocol } from "imposters/schemas/common"
import { describe, expect } from "vitest"

const fake = (protocol: string): ImposterExtension => ({
  protocol,
  make: () => Effect.succeed({ handle: () => Effect.succeed(new Response(protocol)) })
})

// Builds the registration layer and reads the service back
const register = (extensions: ReadonlyArray<ImposterExtension>) =>
  Effect.gen(function*() {
    return yield* Extensions
  }).pipe(Effect.provide(Extensions.layer(extensions)), Effect.exit)

const defectMessage = (exit: Exit.Exit<unknown>): string =>
  Exit.isFailure(exit) && Cause.hasDies(exit.cause) ? String(Cause.squash(exit.cause)) : "no defect"

describe("Extensions.layer", () => {
  it.effect("provides a valid registration as given", () =>
    Effect.gen(function*() {
      const extensions = [fake("S3"), fake("ECHO")]
      const exit = yield* register(extensions)
      expect(exit).toStrictEqual(Exit.succeed(extensions))
    }))

  it.effect("dies on a duplicate protocol", () =>
    Effect.gen(function*() {
      const message = defectMessage(yield* register([fake("S3"), fake("ECHO"), fake("S3")]))
      expect(message).toContain("Invalid imposter extension registration")
      expect(message).toContain(`"S3" is registered more than once`)
    }))

  it.effect("dies on the built-in HTTP protocol", () =>
    Effect.gen(function*() {
      expect(defectMessage(yield* register([fake("HTTP")]))).toContain(`"HTTP" is built in and cannot be registered`)
    }))

  it.effect("dies on a protocol that fails the pattern", () =>
    Effect.gen(function*() {
      for (const bad of ["s3", "3D", "", "S-3", "S 3"]) {
        expect(defectMessage(yield* register([fake(bad)]))).toContain(`"${bad}" is not a valid protocol`)
      }
    }))

  it.effect("lists every problem at once", () =>
    Effect.gen(function*() {
      const message = defectMessage(yield* register([fake("HTTP"), fake("s3"), fake("X"), fake("X")]))
      expect(message).toContain(`"HTTP" is built in`)
      expect(message).toContain(`"s3" is not a valid protocol`)
      expect(message).toContain(`"X" is registered more than once`)
    }))
})

describe("supportedProtocols / findExtension", () => {
  it("with no extensions, only HTTP is supported and nothing is findable", () => {
    expect(supportedProtocols([])).toEqual(["HTTP"])
    expect(Option.isNone(findExtension([], "HTTP"))).toBe(true)
  })

  it.effect.prop(
    "every supported protocol but HTTP finds its extension, and nothing else is findable",
    { candidates: Schema.Array(Protocol), probe: Protocol },
    ({ candidates, probe }) =>
      Effect.gen(function*() {
        // Any valid registration: distinct protocols, none of them HTTP
        const extensions = [...new Set(candidates)].filter((p) => p !== "HTTP").map(fake)
        const registered = yield* register(extensions)
        expect(Exit.isSuccess(registered)).toBe(true)

        const supported = supportedProtocols(extensions)
        expect(supported[0]).toBe("HTTP")
        expect(new Set(supported).size).toBe(supported.length)
        for (const protocol of supported.slice(1)) {
          const found = findExtension(extensions, protocol)
          expect(Option.map(found, (ext) => ext.protocol)).toStrictEqual(Option.some(protocol))
        }
        expect(Option.isNone(findExtension(extensions, "HTTP"))).toBe(true)
        expect(Option.isSome(findExtension(extensions, probe))).toBe(supported.slice(1).includes(probe))
      }),
    { arbitrary: { runs: 100 } }
  )
})

describe("Protocol schema", () => {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  const digits = "0123456789"
  // Stated without the regex: a letter, then letters or digits
  const wellFormed = (s: string) =>
    s.length > 0 && upper.includes(s[0] ?? "") && [...s.slice(1)].every((c) => (upper + digits).includes(c))

  it.prop(
    "accepts exactly the uppercase-letter-then-letters-or-digits strings",
    { chars: Schema.Array(Schema.Literals(["A", "S", "Z", "0", "3", "9", "a", "z", "-", "_", " ", "é"])) },
    ({ chars }) => {
      const s = chars.join("")
      expect(Schema.is(Protocol)(s)).toBe(wellFormed(s))
    },
    { arbitrary: { runs: 300 } }
  )

  it.prop("every generated protocol is well formed", { protocol: Protocol }, ({ protocol }) => {
    expect(wellFormed(protocol)).toBe(true)
  })
})
