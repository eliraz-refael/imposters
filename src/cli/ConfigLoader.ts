import { Data, Effect, Schema } from "effect"
import * as fs from "node:fs"
import { ConfigFile } from "../schemas/ConfigFileSchema.js"

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

    return yield* Schema.decodeUnknown(ConfigFile)(json).pipe(
      Effect.mapError(
        (error) =>
          new ConfigLoadError({
            message: `Config validation failed: ${String(error)}`,
            cause: error
          })
      )
    )
  })
