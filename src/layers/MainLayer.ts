import * as Layer from "effect/Layer"
import { Extensions, type ImposterExtension } from "../extensions/Extension"
import { ImposterRepositoryLive } from "../repositories/ImposterRepository"
import { FiberManagerLive } from "../server/FiberManager"
import { ImposterServerLive } from "../server/ImposterServer"
import { NodeServerFactoryLive } from "../server/ServerFactory"
import { AppConfigLive } from "../services/AppConfig"
import { MetricsServiceLive } from "../services/MetricsService"
import { PortAllocatorLive } from "../services/PortAllocator"
import { ProxyServiceLive } from "../services/ProxyService"
import { RequestLoggerLive } from "../services/RequestLogger"
import { UuidLive } from "../services/UuidLive"

// PortAllocatorLive depends on AppConfig
const PortAllocatorWithDeps = PortAllocatorLive.pipe(Layer.provide(AppConfigLive))

// ProxyServiceLive depends on Uuid
const ProxyServiceWithDeps = ProxyServiceLive.pipe(Layer.provide(UuidLive))

// Every core service, with `extensions` registered. The imposter runtime and the API
// handlers both read the one `Extensions` built here, so they agree on the protocols.
export const makeMainLayer = (extensions: ReadonlyArray<ImposterExtension>) => {
  const ExtensionsLive = Extensions.layer(extensions)

  // ImposterServerLive depends on FiberManager + ImposterRepository + ServerFactory + RequestLogger + Metrics
  // + Proxy + Extensions
  const ImposterServerWithDeps = ImposterServerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        FiberManagerLive,
        ImposterRepositoryLive,
        NodeServerFactoryLive,
        RequestLoggerLive,
        MetricsServiceLive,
        ProxyServiceWithDeps,
        ExtensionsLive
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
