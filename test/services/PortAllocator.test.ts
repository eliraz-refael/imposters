import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { AppConfig } from "imposters/services/AppConfig.js"
import { PortAllocator, PortAllocatorLive } from "imposters/services/PortAllocator.js"
import { describe, expect } from "vitest"

// Use a small port range for testing
const TestConfig = Layer.succeed(AppConfig, {
  adminPort: 2525,
  portRangeMin: 5000,
  portRangeMax: 5002,
  maxImposters: 100,
  logLevel: "info" as const
})

const TestPortAllocator = PortAllocatorLive.pipe(Layer.provide(TestConfig))

describe("PortAllocator", () => {
  it.effect("allocate preferred port succeeds", () =>
    Effect.gen(function*() {
      const allocator = yield* PortAllocator
      const port = yield* allocator.allocate(5000)
      expect(port).toBe(5000)
    }).pipe(Effect.provide(TestPortAllocator)))

  it.effect("allocate same port twice fails", () =>
    Effect.gen(function*() {
      const allocator = yield* PortAllocator
      yield* allocator.allocate(5000)
      const error = yield* Effect.flip(allocator.allocate(5000))
      expect(error._tag).toBe("PortAllocatorError")
    }).pipe(Effect.provide(TestPortAllocator)))

  it.effect("allocate without preference returns port in range", () =>
    Effect.gen(function*() {
      const allocator = yield* PortAllocator
      const port = yield* allocator.allocate()
      expect(port).toBeGreaterThanOrEqual(5000)
      expect(port).toBeLessThanOrEqual(5002)
    }).pipe(Effect.provide(TestPortAllocator)))

  it.effect("release port allows re-allocation", () =>
    Effect.gen(function*() {
      const allocator = yield* PortAllocator
      yield* allocator.allocate(5000)
      yield* allocator.release(5000)
      const port = yield* allocator.allocate(5000)
      expect(port).toBe(5000)
    }).pipe(Effect.provide(TestPortAllocator)))

  it.effect("exhaust all ports fails with PortExhaustedError", () =>
    Effect.gen(function*() {
      const allocator = yield* PortAllocator
      yield* allocator.allocate(5000)
      yield* allocator.allocate(5001)
      yield* allocator.allocate(5002)
      const error = yield* Effect.flip(allocator.allocate())
      expect(error._tag).toBe("PortExhaustedError")
    }).pipe(Effect.provide(TestPortAllocator)))

  it.effect("isAvailable reflects current state", () =>
    Effect.gen(function*() {
      const allocator = yield* PortAllocator
      expect(yield* allocator.isAvailable(5000)).toBe(true)
      yield* allocator.allocate(5000)
      expect(yield* allocator.isAvailable(5000)).toBe(false)
      yield* allocator.release(5000)
      expect(yield* allocator.isAvailable(5000)).toBe(true)
    }).pipe(Effect.provide(TestPortAllocator)))

  it.effect("concurrent allocations don't produce duplicates", () =>
    Effect.gen(function*() {
      const allocator = yield* PortAllocator
      const ports = yield* Effect.all([
        allocator.allocate(),
        allocator.allocate(),
        allocator.allocate()
      ])
      const uniquePorts = new Set(ports)
      expect(uniquePorts.size).toBe(3)
    }).pipe(Effect.provide(TestPortAllocator)))
})
