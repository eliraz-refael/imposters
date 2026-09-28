import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { NonEmptyString, PortNumber } from "./common"
import { CreateStubRequest, ProxyConfig } from "./StubSchema"

export const ImposterConfig = Schema.Struct({
  name: Schema.optional(NonEmptyString),
  port: PortNumber,
  stubs: Schema.Array(CreateStubRequest).pipe(Schema.withDecodingDefault(Effect.sync(() => []))),
  proxy: Schema.optional(ProxyConfig)
})
export type ImposterConfig = Schema.Schema.Type<typeof ImposterConfig>

export const AdminConfig = Schema.Struct({
  port: PortNumber.pipe(Schema.withDecodingDefault(Effect.succeed(2525))),
  portRangeMin: PortNumber.pipe(Schema.withDecodingDefault(Effect.succeed(3000))),
  portRangeMax: PortNumber.pipe(Schema.withDecodingDefault(Effect.succeed(4000))),
  maxImposters: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.withDecodingDefault(Effect.succeed(100))),
  logLevel: Schema.Literals(["debug", "info", "warn", "error"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("info" as const))
  )
})
export type AdminConfig = Schema.Schema.Type<typeof AdminConfig>

export const ConfigFile = Schema.Struct({
  admin: AdminConfig.pipe(Schema.withDecodingDefault(Effect.sync(() => ({})))),
  imposters: Schema.Array(ImposterConfig).pipe(Schema.withDecodingDefault(Effect.sync(() => [])))
})
export type ConfigFile = Schema.Schema.Type<typeof ConfigFile>
