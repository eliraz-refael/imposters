import { it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, expect } from "vitest"
import {
  calculateUptime,
  canStart,
  canStop,
  createImposterConfig,
  ImposterError,
  ImposterNotFoundError,
  isRunning,
  PortInUseError,
  updateImposterPort,
  updateImposterStatus
} from "imposters/domain/imposter.js"
import { Uuid } from "imposters/services/Uuid.js"

const TestUuid = Layer.succeed(Uuid, {
  generate: Effect.succeed("test-uuid-1234-5678"),
  generateShort: Effect.succeed("test1234")
})

describe("imposter domain", () => {
  it.effect("createImposterConfig creates config with defaults", () =>
    Effect.gen(function*() {
      const config = yield* createImposterConfig({ name: "test" })
      expect(config._tag).toBe("ImposterConfig")
      expect(config.id).toBe("test1234")
      expect(config.name).toBe("test")
      expect(config.port).toBe(0)
      expect(config.status).toBe("starting")
      expect(config.createdAt).toBeDefined()
    }).pipe(Effect.provide(TestUuid))
  )

  it.effect("createImposterConfig uses id as name when name not provided", () =>
    Effect.gen(function*() {
      const config = yield* createImposterConfig({})
      expect(config.name).toBe("test1234")
    }).pipe(Effect.provide(TestUuid))
  )

  describe("updateImposterStatus", () => {
    it.effect("updates status correctly", () =>
      Effect.gen(function*() {
        const config = yield* createImposterConfig({ name: "test" })
        const updated = updateImposterStatus("running")(config)
        expect(updated.status).toBe("running")
        expect(updated.name).toBe("test")
        expect(updated.id).toBe(config.id)
      }).pipe(Effect.provide(TestUuid))
    )
  })

  describe("updateImposterPort", () => {
    it.effect("updates port correctly", () =>
      Effect.gen(function*() {
        const config = yield* createImposterConfig({ name: "test", port: 3000 })
        const updated = updateImposterPort(4000)(config)
        expect(updated.port).toBe(4000)
        expect(updated.name).toBe("test")
      }).pipe(Effect.provide(TestUuid))
    )
  })

  describe("calculateUptime", () => {
    it.effect("returns positive duration", () =>
      Effect.gen(function*() {
        const startTime = DateTime.unsafeNow()
        const uptime = yield* calculateUptime(startTime)
        expect(Duration.toMillis(uptime)).toBeGreaterThanOrEqual(0)
      })
    )
  })

  describe("predicates", () => {
    it.effect("isRunning returns true for running status", () =>
      Effect.gen(function*() {
        const config = yield* createImposterConfig({ name: "test" })
        const running = updateImposterStatus("running")(config)
        expect(isRunning(running)).toBe(true)
        expect(isRunning(config)).toBe(false)
      }).pipe(Effect.provide(TestUuid))
    )

    it.effect("canStart returns true for stopped and starting", () =>
      Effect.gen(function*() {
        const config = yield* createImposterConfig({ name: "test" })
        const stopped = updateImposterStatus("stopped")(config)
        const starting = updateImposterStatus("starting")(config)
        const running = updateImposterStatus("running")(config)
        expect(canStart(stopped)).toBe(true)
        expect(canStart(starting)).toBe(true)
        expect(canStart(running)).toBe(false)
      }).pipe(Effect.provide(TestUuid))
    )

    it.effect("canStop returns true for running and stopping", () =>
      Effect.gen(function*() {
        const config = yield* createImposterConfig({ name: "test" })
        const running = updateImposterStatus("running")(config)
        const stopping = updateImposterStatus("stopping")(config)
        const stopped = updateImposterStatus("stopped")(config)
        expect(canStop(running)).toBe(true)
        expect(canStop(stopping)).toBe(true)
        expect(canStop(stopped)).toBe(false)
      }).pipe(Effect.provide(TestUuid))
    )
  })

  describe("errors", () => {
    it("ImposterError is a proper tagged error", () => {
      const err = new ImposterError({ reason: "test error" })
      expect(err._tag).toBe("ImposterError")
      expect(err.reason).toBe("test error")
      expect(err instanceof Error).toBe(true)
    })

    it("PortInUseError is a proper tagged error", () => {
      const err = new PortInUseError({ port: 3000 })
      expect(err._tag).toBe("PortInUseError")
      expect(err.port).toBe(3000)
      expect(err instanceof Error).toBe(true)
    })

    it("ImposterNotFoundError is a proper tagged error", () => {
      const err = new ImposterNotFoundError({ id: "abc" })
      expect(err._tag).toBe("ImposterNotFoundError")
      expect(err.id).toBe("abc")
      expect(err instanceof Error).toBe(true)
    })
  })
})
