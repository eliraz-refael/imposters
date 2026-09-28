/**
 * The imposter extension point: how a protocol other than plain HTTP is plugged in.
 *
 * An extension lives in its own folder, `src/extensions/<name>/`, and is attached in one
 * place, the extension list in `src/cli/Commands.ts`. The core only knows this module.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { ImposterConfig } from "../domain/imposter"
import type { RequestContext } from "../matching/RequestMatcher"
import { HttpProtocol, Protocol } from "../schemas/common"

/** One running imposter's handler. Built by `make` on every start, so its state lives until the next stop. */
export interface ExtensionInstance {
  /**
   * Answers every request that no stub matched. Terminal: there is no fallthrough to
   * proxy or 404, so the extension renders its own errors. A defect becomes a 500.
   */
  readonly handle: (ctx: RequestContext) => Effect.Effect<Response>
}

export interface ImposterExtension {
  /** The protocol this extension serves, e.g. "S3". Uppercase letters and digits; "HTTP" is built in. */
  readonly protocol: string
  /** Runs once per imposter start. Per-imposter state (an in-memory store, say) belongs in the instance. */
  readonly make: (
    imposter: { readonly id: string; readonly config: ImposterConfig }
  ) => Effect.Effect<ExtensionInstance>
}

const isProtocol = Schema.is(Protocol)

// Every way an extension list can be misassembled, as one message per problem
const registrationProblems = (extensions: ReadonlyArray<ImposterExtension>): ReadonlyArray<string> => {
  const protocols = extensions.map((ext) => ext.protocol)
  const duplicates = [...new Set(protocols.filter((p, i) => protocols.indexOf(p) !== i))]
  return [
    ...protocols.filter((p) => p === HttpProtocol).map(() => `"${HttpProtocol}" is built in and cannot be registered`),
    ...protocols.filter((p) => !isProtocol(p)).map((p) =>
      `"${p}" is not a valid protocol (uppercase letters and digits, starting with a letter)`
    ),
    ...duplicates.map((p) => `"${p}" is registered more than once`)
  ]
}

/** The extensions registered at the composition root. Resolve it when a layer is built, not per request. */
export class Extensions extends Context.Service<Extensions, ReadonlyArray<ImposterExtension>>()("Extensions") {
  /**
   * Provides `extensions`. A registration mistake (duplicate, "HTTP", malformed protocol) is a
   * programmer error at the composition root, so building the layer dies with every problem listed.
   */
  static readonly layer = (extensions: ReadonlyArray<ImposterExtension>): Layer.Layer<Extensions> =>
    Layer.effect(
      Extensions,
      Effect.suspend(() => {
        const problems = registrationProblems(extensions)
        return problems.length === 0
          ? Effect.succeed(extensions)
          : Effect.die(new Error(`Invalid imposter extension registration: ${problems.join("; ")}`))
      })
    )
}

/** The extension serving `protocol`. None for "HTTP", which is built in and never registered. */
export const findExtension = (
  extensions: ReadonlyArray<ImposterExtension>,
  protocol: string
): Option.Option<ImposterExtension> => Option.fromNullishOr(extensions.find((ext) => ext.protocol === protocol))

/** Every protocol an imposter can be created with: "HTTP" first, then the extensions' in registration order. */
export const supportedProtocols = (extensions: ReadonlyArray<ImposterExtension>): ReadonlyArray<string> => [
  HttpProtocol,
  ...extensions.map((ext) => ext.protocol)
]
