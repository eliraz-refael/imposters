import { Command, Options } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { makeWebHandler } from "../server/AdminServer.js"
import { ImpostersClientLive } from "../client/ImpostersClient.js"
import { HandlerHttpClientLive } from "../client/HandlerHttpClient.js"
import { ImpostersClient } from "../client/ImpostersClient.js"
import { loadConfigFile } from "./ConfigLoader.js"

const configOption = Options.file("config").pipe(
  Options.withAlias("c"),
  Options.withDescription("Path to JSON config file"),
  Options.optional
)

const portOption = Options.integer("port").pipe(
  Options.withAlias("p"),
  Options.withDescription("Admin server port (default: 2525)"),
  Options.optional
)

const startCommand = Command.make(
  "start",
  { config: configOption, port: portOption },
  ({ config, port }) =>
    Effect.gen(function* () {
      const adminPort = Option.isSome(port) ? port.value : Number(process.env.ADMIN_PORT ?? 2525)

      const { handler, dispose } = makeWebHandler()
      const server = Bun.serve({ port: adminPort, fetch: handler })

      console.log(`Imposters admin server running on http://localhost:${server.port}`)

      // Load config and create imposters if config file provided
      if (Option.isSome(config)) {
        const configData = yield* loadConfigFile(config.value).pipe(
          Effect.catchTag("ConfigLoadError", (e) =>
            Effect.sync(() => {
              console.error(`Warning: ${e.message}`)
              return null
            })
          )
        )

        if (configData !== null && configData.imposters.length > 0) {
          const clientLayer = ImpostersClientLive(`http://localhost:${server.port}`).pipe(
            Layer.provide(HandlerHttpClientLive(handler))
          )

          yield* Effect.provide(
            Effect.gen(function* () {
              const client = yield* ImpostersClient
              for (const imp of configData.imposters) {
                const created = yield* client.imposters.createImposter({
                  payload: {
                    port: imp.port,
                    ...(imp.name !== undefined ? { name: imp.name } : {}),
                    protocol: "HTTP" as const,
                    adminPath: "/_admin"
                  }
                }).pipe(Effect.catchAll((e) => {
                  console.error(`Failed to create imposter on port ${imp.port}: ${e}`)
                  return Effect.succeed(null)
                }))

                if (created === null) continue

                for (const stub of imp.stubs) {
                  yield* client.imposters.addStub({
                    path: { imposterId: created.id },
                    payload: stub
                  }).pipe(Effect.catchAll((e) => {
                    console.error(`Failed to add stub: ${e}`)
                    return Effect.void
                  }))
                }

                yield* client.imposters.updateImposter({
                  path: { id: created.id },
                  payload: { status: "running" as const }
                }).pipe(Effect.catchAll((e) => {
                  console.error(`Failed to start imposter ${created.id}: ${e}`)
                  return Effect.void
                }))

                console.log(`Created imposter "${imp.name ?? created.id}" on port ${imp.port}`)
              }
            }),
            clientLayer
          )
        }
      }

      // Keep running until interrupted
      yield* Effect.async<never, never>(() => {
        const shutdown = () => {
          console.log("Shutting down...")
          server.stop(true)
          dispose()
          process.exit(0)
        }
        process.on("SIGINT", shutdown)
        process.on("SIGTERM", shutdown)
      })
    })
)

const command = Command.make("imposters").pipe(
  Command.withSubcommands([startCommand])
)

export const run = Command.run(command, {
  name: "imposters",
  version: "0.1.0"
})

export const main = run(process.argv).pipe(
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain
)
