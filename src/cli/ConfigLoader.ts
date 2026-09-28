import { Console, Data, Effect, Schema } from "effect"
import * as fs from "node:fs"
import { ImpostersClient } from "../client/ImpostersClient"
import type { ImposterConfig } from "../schemas/ConfigFileSchema"
import { ConfigFile } from "../schemas/ConfigFileSchema"

export class ConfigLoadError extends Data.TaggedError("ConfigLoadError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const loadConfigFile = (
  filePath: string
): Effect.Effect<Schema.Schema.Type<typeof ConfigFile>, ConfigLoadError> =>
  Effect.gen(function*() {
    const content = yield* Effect.try({
      try: () => fs.readFileSync(filePath, "utf-8"),
      catch: (error) =>
        new ConfigLoadError({
          message: `Failed to read config file: ${filePath}`,
          cause: error
        })
    })

    const json = yield* Effect.try({
      try: () => JSON.parse(content) as unknown,
      catch: (error) =>
        new ConfigLoadError({
          message: `Invalid JSON in config file: ${filePath}`,
          cause: error
        })
    })

    return yield* Schema.decodeUnknownEffect(ConfigFile)(json).pipe(
      Effect.mapError(
        (error) =>
          new ConfigLoadError({
            message: `Config validation failed: ${String(error)}`,
            cause: error
          })
      )
    )
  })

const describeError = (error: unknown): string => error instanceof Error ? error.message : String(error)

const failWith = (message: string) => (error: unknown) =>
  new ConfigLoadError({ message: `${message}: ${describeError(error)}`, cause: error })

// Creates, stubs and starts each configured imposter through the admin API. Stops at the
// first failure: the CLI treats a half-loaded config as fatal, so "running" means "all up".
export const createConfiguredImposters = (
  imposters: ReadonlyArray<ImposterConfig>
): Effect.Effect<void, ConfigLoadError, ImpostersClient> =>
  Effect.gen(function*() {
    const client = yield* ImpostersClient
    for (const imp of imposters) {
      const label = imp.name ?? `on port ${imp.port}`
      const created = yield* client.imposters.createImposter({
        payload: {
          port: imp.port,
          protocol: imp.protocol,
          adminPath: "/_admin",
          ...(imp.name !== undefined ? { name: imp.name } : {}),
          ...(imp.proxy !== undefined ? { proxy: imp.proxy } : {})
        }
      }).pipe(Effect.mapError(failWith(`Failed to create imposter ${label}`)))

      for (const stub of imp.stubs) {
        yield* client.imposters.addStub({ params: { imposterId: created.id }, payload: stub }).pipe(
          Effect.mapError(failWith(`Failed to add a stub to imposter ${label}`))
        )
      }

      yield* client.imposters.updateImposter({ params: { id: created.id }, payload: { status: "running" } }).pipe(
        Effect.mapError(failWith(`Failed to start imposter ${label}`))
      )

      yield* Console.log(`Created ${imp.protocol} imposter "${imp.name ?? created.id}" on port ${imp.port}`)
    }
  })
