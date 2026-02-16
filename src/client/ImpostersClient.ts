import type { HttpClient } from "@effect/platform"
import { FetchHttpClient, HttpApiClient } from "@effect/platform"
import type { Effect } from "effect"
import { Context, Layer } from "effect"
import { AdminApi } from "../api/AdminApi.js"

export const makeImpostersClient = (baseUrl?: string) =>
  HttpApiClient.make(AdminApi, { baseUrl: baseUrl ?? "http://localhost:2525" })

export type ImpostersClientShape = Effect.Effect.Success<ReturnType<typeof makeImpostersClient>>

export class ImpostersClient extends Context.Tag("ImpostersClient")<
  ImpostersClient,
  ImpostersClientShape
>() {}

export const ImpostersClientLive = (baseUrl?: string): Layer.Layer<ImpostersClient, never, HttpClient.HttpClient> =>
  Layer.effect(ImpostersClient, makeImpostersClient(baseUrl))

export const ImpostersClientFetchLive = (baseUrl?: string): Layer.Layer<ImpostersClient> =>
  ImpostersClientLive(baseUrl).pipe(Layer.provide(FetchHttpClient.layer))
