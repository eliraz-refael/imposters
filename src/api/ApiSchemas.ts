import * as Schema from "effect/Schema"
import { ImposterStatus, Protocol } from "../schemas/common"

export const PaginationUrlParams = Schema.Struct({
  limit: Schema.optionalWith(
    Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
    { default: () => 50 }
  ),
  offset: Schema.optionalWith(
    Schema.NumberFromString.pipe(Schema.int(), Schema.nonNegative()),
    { default: () => 0 }
  )
})

export const ListImpostersUrlParams = Schema.Struct({
  ...PaginationUrlParams.fields,
  status: Schema.optional(ImposterStatus),
  protocol: Schema.optional(Protocol)
})
export type ListImpostersUrlParams = Schema.Schema.Type<typeof ListImpostersUrlParams>

export const DeleteImposterUrlParams = Schema.Struct({
  force: Schema.optionalWith(Schema.BooleanFromString, { default: () => false })
})
export type DeleteImposterUrlParams = Schema.Schema.Type<typeof DeleteImposterUrlParams>

export const ListRequestsUrlParams = Schema.Struct({
  limit: Schema.optionalWith(
    Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
    { default: () => 50 }
  ),
  method: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  status: Schema.optional(Schema.NumberFromString)
})
export type ListRequestsUrlParams = Schema.Schema.Type<typeof ListRequestsUrlParams>
