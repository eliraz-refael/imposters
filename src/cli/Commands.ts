import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { HandlerHttpClientLive } from "../client/HandlerHttpClient"
import { ImpostersClient, ImpostersClientLive } from "../client/ImpostersClient"
import { makeCompositeHandler } from "../server/AdminServer"
import { BunServerFactoryLive, NodeServerFactoryLive, ServerFactory } from "../server/ServerFactory"
import { loadConfigFile } from "./ConfigLoader"
import { version } from "./version"

const configOption = Flag.File("config").pipe(
  Flag.withAlias("c"),
  Flag.withDescription("Path to JSON config file"),
  Flag.optional
)

const portOption = Flag.Int("port").pipe(
  Flag.withAlias("p"),
  Flag.withDescription("Admin server port (default: 2525)"),
  Flag.optional
)

const runtimeOption = Flag.Literals("runtime", ["node", "bun"]).pipe(
  Flag.withDescription("Server runtime: node (default) or bun"),
  Flag.withDefault("node" as const)
)

const startCommand = Command.make(
  "start",
  { config: configOption, port: portOption, runtime: runtimeOption },
  ({ config, port, runtime }) =>
    Effect.gen(function*() {
      const adminPort = Option.isSome(port) ? port.value : Number(process.env.ADMIN_PORT ?? 2525)

      const { dispose, handler } = makeCompositeHandler(adminPort)

      const serverFactory = yield* ServerFactory
      // A bind failure (port in use, Bun runtime missing) is fatal: report it plainly and exit
      const server = yield* serverFactory.create({ port: adminPort, fetch: handler }).pipe(
        Effect.catchTag("ServerBindError", (e) =>
          Effect.sync(() => {
            console.error(`Failed to start admin server on port ${e.port}: ${e.reason}`)
            return process.exit(1)
          }))
      )

      console.log(`Imposters admin server running on http://localhost:${server.port} (runtime: ${runtime})`)
      console.log(`Admin UI: http://localhost:${server.port}/_ui`)

      // Load config and create imposters if config file provided
      if (Option.isSome(config)) {
        const configData = yield* loadConfigFile(config.value).pipe(
          Effect.catchTag("ConfigLoadError", (e) =>
            Effect.sync(() => {
              console.error(`Warning: ${e.message}`)
              return null
            }))
        )

        if (configData !== null && configData.imposters.length > 0) {
          const clientLayer = ImpostersClientLive(`http://localhost:${server.port}`).pipe(
            Layer.provide(HandlerHttpClientLive(handler))
          )

          yield* Effect.provide(
            Effect.gen(function*() {
              const client = yield* ImpostersClient
              for (const imp of configData.imposters) {
                const created = yield* client.imposters.createImposter({
                  payload: {
                    port: imp.port,
                    ...(imp.name !== undefined ? { name: imp.name } : {}),
                    protocol: "HTTP" as const,
                    adminPath: "/_admin"
                  }
                }).pipe(Effect.catch((e) => {
                  console.error(`Failed to create imposter on port ${imp.port}: ${e}`)
                  return Effect.succeed(null)
                }))

                if (created === null) continue

                for (const stub of imp.stubs) {
                  yield* client.imposters.addStub({
                    params: { imposterId: created.id },
                    payload: stub
                  }).pipe(Effect.catch((e) => {
                    console.error(`Failed to add stub: ${e}`)
                    return Effect.void
                  }))
                }

                yield* client.imposters.updateImposter({
                  params: { id: created.id },
                  payload: { status: "running" as const }
                }).pipe(Effect.catch((e) => {
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
      yield* Effect.callback<never, never>(() => {
        const shutdown = () => {
          console.log("Shutting down...")
          // Exiting releases every port, so the stop is not awaited: runMain's own
          // signal handler runs next and would exit with 130 before it resolved.
          Effect.runFork(server.stop(true))
          dispose()
          process.exit(0)
        }
        // Prepended because binding is now asynchronous, so runMain has already
        // registered its SIGINT/SIGTERM handlers by the time this line runs.
        process.prependListener("SIGINT", shutdown)
        process.prependListener("SIGTERM", shutdown)
      })
    }).pipe(
      Effect.provide(runtime === "bun" ? BunServerFactoryLive : NodeServerFactoryLive)
    )
)

const command = Command.make("imposters").pipe(
  Command.withSubcommands([startCommand])
)

export const run = Command.run(command, { version })

export const main = run.pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
