import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { HandlerHttpClientLive } from "../client/HandlerHttpClient"
import { ImpostersClientLive } from "../client/ImpostersClient"
import { Extensions, type ImposterExtension } from "../extensions/Extension"
import { S3Extension } from "../extensions/s3/S3Extension"
import { makeCompositeHandler } from "../server/AdminServer"
import { BunServerFactoryLive, NodeServerFactoryLive, ServerFactory } from "../server/ServerFactory"
import { createConfiguredImposters, loadConfigFile } from "./ConfigLoader"
import { version } from "./version"

// Extension registration point: the one place an extension is attached. Import it from
// src/extensions/<name>/ and add it here; removing one is this line plus its import.
const extensions: ReadonlyArray<ImposterExtension> = [S3Extension]

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

      // A registration mistake is fatal. The admin handler builds its layers in the background,
      // so without this check it would only show up as every admin request failing.
      yield* Effect.scoped(Layer.build(Extensions.layer(extensions))).pipe(
        Effect.catchDefect((defect) =>
          Effect.sync(() => {
            console.error(defect instanceof Error ? defect.message : String(defect))
            return process.exit(1)
          })
        )
      )

      const { dispose, handler } = makeCompositeHandler(adminPort, extensions)

      // A config that does not load completely is fatal. It loads through the in-process handler
      // before the admin port binds, so once the admin server answers, every imposter is up.
      if (Option.isSome(config)) {
        const clientLayer = ImpostersClientLive(`http://localhost:${adminPort}`).pipe(
          Layer.provide(HandlerHttpClientLive(handler))
        )
        yield* loadConfigFile(config.value).pipe(
          Effect.andThen((configData) => createConfiguredImposters(configData.imposters)),
          Effect.provide(clientLayer),
          Effect.catchTag("ConfigLoadError", (e) =>
            Effect.sync(() => {
              console.error(`Failed to load config: ${e.message}`)
              return process.exit(1)
            }))
        )
      }

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
