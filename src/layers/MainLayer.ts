import * as Layer from "effect/Layer"
import { Extensions, type ImposterExtension } from "../extensions/Extension.js"
import { ImposterRepositoryLive } from "../repositories/ImposterRepository.js"
import { AdminPort } from "../server/AdminPort.js"
import { FiberManagerLive } from "../server/FiberManager.js"
import { ImposterServerLive } from "../server/ImposterServer.js"
import { DEFAULT_HOST, makeNodeServerFactory } from "../server/ServerFactory.js"
import { AppConfigLive } from "../services/AppConfig.js"
import { MetricsServiceLive } from "../services/MetricsService.js"
import { PortAllocatorLive } from "../services/PortAllocator.js"
import { ProxyServiceLive } from "../services/ProxyService.js"
import { RequestLoggerLive } from "../services/RequestLogger.js"
import { UuidLive } from "../services/UuidLive.js"

// PortAllocatorLive depends on AppConfig
const PortAllocatorWithDeps = PortAllocatorLive.pipe(Layer.provide(AppConfigLive))

// ProxyServiceLive depends on Uuid
const ProxyServiceWithDeps = ProxyServiceLive.pipe(Layer.provide(UuidLive))

// Every core service, with `extensions` registered. The imposter runtime and the API
// handlers both read the one `Extensions` built here, so they agree on the protocols.
// `adminPort` is where the admin UI is served, for the imposters' pages to link back to.
export const makeMainLayer = (
  extensions: ReadonlyArray<ImposterExtension>,
  host: string = DEFAULT_HOST,
  adminPort?: number
) => {
  const ExtensionsLive = Extensions.layer(extensions)

  // ImposterServerLive depends on FiberManager + ImposterRepository + ServerFactory + RequestLogger + Metrics
  // + Proxy + Extensions
  const ImposterServerWithDeps = ImposterServerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        FiberManagerLive,
        ImposterRepositoryLive,
        makeNodeServerFactory(host),
        RequestLoggerLive,
        MetricsServiceLive,
        ProxyServiceWithDeps,
        ExtensionsLive,
        Layer.succeed(AdminPort, adminPort)
      )
    )
  )

  return Layer.mergeAll(
    UuidLive,
    AppConfigLive,
    PortAllocatorWithDeps,
    ImposterRepositoryLive,
    FiberManagerLive,
    RequestLoggerLive,
    MetricsServiceLive,
    ExtensionsLive,
    ImposterServerWithDeps
  )
}

// Plain HTTP only: no extensions registered
export const MainLayer = makeMainLayer([])
