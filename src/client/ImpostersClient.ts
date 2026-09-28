import type { Effect } from "effect"
import { Context, Layer } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { AdminApi } from "../api/AdminApi"

export const makeImpostersClient = (baseUrl?: string) =>
  HttpApiClient.make(AdminApi, { baseUrl: baseUrl ?? "http://localhost:2525" })

export type ImpostersClientShape = Effect.Success<ReturnType<typeof makeImpostersClient>>

export class ImpostersClient extends Context.Service<
  ImpostersClient,
  ImpostersClientShape
>()("ImpostersClient") {}

export const ImpostersClientLive = (baseUrl?: string): Layer.Layer<ImpostersClient, never, HttpClient.HttpClient> =>
  Layer.effect(ImpostersClient, makeImpostersClient(baseUrl))

export const ImpostersClientFetchLive = (baseUrl?: string): Layer.Layer<ImpostersClient> =>
  ImpostersClientLive(baseUrl).pipe(Layer.provide(FetchHttpClient.layer))
