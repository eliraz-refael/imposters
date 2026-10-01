import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { v4 } from "uuid"
import { Uuid } from "./Uuid.js"

export const UuidLive = Layer.succeed(Uuid, {
  generate: Effect.sync(() => v4()),
  generateShort: Effect.sync(() => v4().substring(0, 8))
})
