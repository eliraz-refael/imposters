import * as Layer from "effect/Layer"
import { ImposterRepositoryLive } from "../repositories/ImposterRepository.js"
import { AppConfigLive } from "../services/AppConfig.js"
import { PortAllocatorLive } from "../services/PortAllocator.js"
import { UuidLive } from "../services/UuidLive.js"

// PortAllocatorLive depends on AppConfig
const PortAllocatorWithDeps = PortAllocatorLive.pipe(Layer.provide(AppConfigLive))

// Compose all services
export const MainLayer = Layer.mergeAll(
  UuidLive,
  AppConfigLive,
  PortAllocatorWithDeps,
  ImposterRepositoryLive
)
