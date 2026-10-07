import * as Layer from "effect/Layer"
import { Extensions, type ImposterExtension } from "../extensions/Extension.js"
import { ImposterRepositoryLive } from "../repositories/ImposterRepository.js"
import { AdminPort } from "../server/AdminPort.js"
import { FiberManagerLive } from "../server/FiberManager.js"
import { ImposterServerLive } from "../server/ImposterServer.js"
import { MaxHops } from "../server/MaxHops.js"
import { DEFAULT_HOST, makeNodeServerFactory } from "../server/ServerFactory.js"
import { AppConfigLive } from "../services/AppConfig.js"
import { MetricsServiceLive } from "../services/MetricsService.js"
import { OutboundHttpLive } from "../services/OutboundHttp.js"
import { PortAllocatorLive } from "../services/PortAllocator.js"
import { ProxyServiceLive } from "../services/ProxyService.js"
import { RequestLoggerLive } from "../services/RequestLogger.js"
import { UuidLive } from "../services/UuidLive.js"

// PortAllocatorLive depends on AppConfig
const PortAllocatorWithDeps = PortAllocatorLive.pipe(Layer.provide(AppConfigLive))

// Every core service, with `extensions` registered. The imposter runtime and the API
// handlers both read the one `Extensions` built here, so they agree on the protocols.
// `adminPort` is where the admin UI is served, for the imposters' pages to link back to.
// `maxHops` is the hop limit of outbound calls (MaxHops's default when left out).
export const makeMainLayer = (
  extensions: ReadonlyArray<ImposterExtension>,
  host: string = DEFAULT_HOST,
  adminPort?: number,
  maxHops?: number
) => {
  const ExtensionsLive = Extensions.layer(extensions)

  // Callbacks and proxy forwards: the hop limit, and the outbound edges in the stats
  const OutboundHttpWithDeps = OutboundHttpLive.pipe(
    Layer.provide(MetricsServiceLive),
    Layer.provide(maxHops !== undefined ? Layer.succeed(MaxHops, maxHops) : Layer.empty)
  )

  // ProxyServiceLive depends on Uuid + OutboundHttp
  const ProxyServiceWithDeps = ProxyServiceLive.pipe(Layer.provide(Layer.mergeAll(UuidLive, OutboundHttpWithDeps)))

  // ImposterServerLive depends on FiberManager + ImposterRepository + ServerFactory + RequestLogger + Metrics
  // + Proxy + OutboundHttp + Extensions
  const ImposterServerWithDeps = ImposterServerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        FiberManagerLive,
        ImposterRepositoryLive,
        makeNodeServerFactory(host),
        RequestLoggerLive,
        MetricsServiceLive,
        ProxyServiceWithDeps,
        OutboundHttpWithDeps,
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
