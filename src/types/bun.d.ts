// Minimal ambient declaration for the parts of the Bun global that
// BunServerFactoryLive uses. `bun-types` is deliberately not a dependency:
// this package is built and tested under Node, where `Bun` does not exist, so
// the global is typed as possibly undefined and callers must check for it.
//
// This file is a script (no imports/exports), so its declarations are global.
// It is not emitted by the build and nothing in the public API references it.

interface ImpostersBunServer {
  readonly port: number | undefined
  readonly hostname: string | undefined
  // Returns a Promise that resolves once the listener is closed (Bun >= 1.1)
  readonly stop: (closeActiveConnections?: boolean) => Promise<void> | void
}

interface ImpostersBunGlobal {
  readonly serve: (options: {
    readonly port: number
    readonly hostname: string
    readonly fetch: (request: Request) => Promise<Response>
  }) => ImpostersBunServer
}

// eslint-disable-next-line no-var
declare var Bun: ImpostersBunGlobal | undefined
