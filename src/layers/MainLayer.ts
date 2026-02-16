import * as Layer from "effect/Layer"
import { ImposterRepositoryLive } from "../repositories/ImposterRepository.js"
import { BunServerFactoryLive } from "../server/BunServer.js"
import { FiberManagerLive } from "../server/FiberManager.js"
import { ImposterServerLive } from "../server/ImposterServer.js"
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

// ImposterServerLive depends on FiberManager + ImposterRepository + ServerFactory + RequestLogger + Metrics + Proxy
const ImposterServerWithDeps = ImposterServerLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      FiberManagerLive,
      ImposterRepositoryLive,
      BunServerFactoryLive,
      RequestLoggerLive,
      MetricsServiceLive,
      ProxyServiceWithDeps
    )
  )
)

// Compose all services
export const MainLayer = Layer.mergeAll(
  UuidLive,
  AppConfigLive,
  PortAllocatorWithDeps,
  ImposterRepositoryLive,
  FiberManagerLive,
  RequestLoggerLive,
  MetricsServiceLive,
  ImposterServerWithDeps
)
