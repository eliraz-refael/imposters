import * as Layer from "effect/Layer"
import { ImposterRepositoryLive } from "../repositories/ImposterRepository"
import { BunServerFactoryLive } from "../server/BunServer"
import { FiberManagerLive } from "../server/FiberManager"
import { ImposterServerLive } from "../server/ImposterServer"
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
