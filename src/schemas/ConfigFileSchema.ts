import * as Schema from "effect/Schema"
import { NonEmptyString, PortNumber } from "./common.js"
import { CreateStubRequest, ProxyConfig } from "./StubSchema.js"

export const ImposterConfig = Schema.Struct({
  name: Schema.optional(NonEmptyString),
  port: PortNumber,
  stubs: Schema.optionalWith(Schema.Array(CreateStubRequest), { default: () => [] }),
  proxy: Schema.optional(ProxyConfig)
})
export type ImposterConfig = Schema.Schema.Type<typeof ImposterConfig>

export const AdminConfig = Schema.Struct({
  port: Schema.optionalWith(PortNumber, { default: () => 2525 as Schema.Schema.Type<typeof PortNumber> }),
  portRangeMin: Schema.optionalWith(PortNumber, { default: () => 3000 as Schema.Schema.Type<typeof PortNumber> }),
  portRangeMax: Schema.optionalWith(PortNumber, { default: () => 4000 as Schema.Schema.Type<typeof PortNumber> }),
  maxImposters: Schema.optionalWith(
    Schema.Number.pipe(Schema.int(), Schema.positive()),
    { default: () => 100 }
  ),
  logLevel: Schema.optionalWith(
    Schema.Literal("debug", "info", "warn", "error"),
    { default: () => "info" as const }
  )
})
export type AdminConfig = Schema.Schema.Type<typeof AdminConfig>

export const ConfigFile = Schema.Struct({
  admin: Schema.optionalWith(AdminConfig, { default: () => Schema.decodeSync(AdminConfig)({}) }),
  imposters: Schema.optionalWith(Schema.Array(ImposterConfig), { default: () => [] })
})
export type ConfigFile = Schema.Schema.Type<typeof ConfigFile>
