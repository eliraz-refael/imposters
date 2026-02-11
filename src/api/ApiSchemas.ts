import * as Schema from "effect/Schema"
import { ImposterStatus, Protocol } from "../schemas/common.js"

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
