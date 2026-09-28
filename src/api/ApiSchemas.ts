import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ImposterStatus, NonNegativeInt, Protocol } from "../schemas/common"

// Query params are decoded through HttpApi's string-tree codec, which parses
// plain Number / Boolean schemas from their string form. No *FromString needed.
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export const PaginationUrlParams = Schema.Struct({
  limit: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(50))),
  offset: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0)))
})

export const ListImpostersUrlParams = Schema.Struct({
  ...PaginationUrlParams.fields,
  status: Schema.optional(ImposterStatus),
  protocol: Schema.optional(Protocol)
})
export type ListImpostersUrlParams = Schema.Schema.Type<typeof ListImpostersUrlParams>

export const DeleteImposterUrlParams = Schema.Struct({
  force: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)))
})
export type DeleteImposterUrlParams = Schema.Schema.Type<typeof DeleteImposterUrlParams>

export const ListRequestsUrlParams = Schema.Struct({
  limit: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(50))),
  method: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number)
})
export type ListRequestsUrlParams = Schema.Schema.Type<typeof ListRequestsUrlParams>
