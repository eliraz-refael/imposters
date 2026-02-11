import { HttpApiBuilder } from "@effect/platform"
import * as Layer from "effect/Layer"
import { ApiLayer } from "../layers/ApiLayer.js"
import { MainLayer } from "../layers/MainLayer.js"

export const FullLayer = ApiLayer.pipe(Layer.provide(MainLayer))

export const makeWebHandler = () => HttpApiBuilder.toWebHandler(FullLayer)
