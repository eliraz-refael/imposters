import * as Layer from "effect/Layer"
import { ImposterRepositoryLive } from "../repositories/ImposterRepository.js"
import { AppConfigLive } from "../services/AppConfig.js"
import { PortAllocatorLive } from "../services/PortAllocator.js"
import { RequestLoggerLive } from "../services/RequestLogger.js"
import { UuidLive } from "../services/UuidLive.js"
import { BunServerFactoryLive } from "../server/BunServer.js"
import { FiberManagerLive } from "../server/FiberManager.js"
import { ImposterServerLive } from "../server/ImposterServer.js"

// PortAllocatorLive depends on AppConfig
const PortAllocatorWithDeps = PortAllocatorLive.pipe(Layer.provide(AppConfigLive))

// ImposterServerLive depends on FiberManager + ImposterRepository + ServerFactory + RequestLogger
const ImposterServerWithDeps = ImposterServerLive.pipe(
  Layer.provide(Layer.mergeAll(FiberManagerLive, ImposterRepositoryLive, BunServerFactoryLive, RequestLoggerLive))
)

// Compose all services
export const MainLayer = Layer.mergeAll(
  UuidLive,
  AppConfigLive,
  PortAllocatorWithDeps,
  ImposterRepositoryLive,
  FiberManagerLive,
  RequestLoggerLive,
  ImposterServerWithDeps
)
