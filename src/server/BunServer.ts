import { Context, Layer } from "effect"

export interface ServerInstance {
  readonly port: number
  readonly stop: (closeActive: boolean) => void
}

export interface ServerFactoryShape {
  readonly create: (options: {
    readonly port: number
    readonly fetch: (request: Request) => Promise<Response>
  }) => ServerInstance
}

export class ServerFactory extends Context.Tag("ServerFactory")<ServerFactory, ServerFactoryShape>() {}

export const BunServerFactoryLive = Layer.succeed(ServerFactory, {
  create: (options) => Bun.serve(options)
})
