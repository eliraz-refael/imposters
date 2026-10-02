import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { ExplainResponse, PreviewResponse } from "../schemas/ExplainSchema.js"
import {
  CreateImposterRequest,
  DeleteImposterResponse,
  ImposterResponse,
  ListImpostersResponse,
  Statistics,
  UpdateImposterRequest
} from "../schemas/ImposterSchema.js"
import { RequestLogEntry } from "../schemas/RequestLogSchema.js"
import { AddStubRequest, CreateStubRequest, Stub, UpdateStubRequest } from "../schemas/StubSchema.js"
import { ApiBadRequestError, ApiConflictError, ApiNotFoundError, ApiServiceError } from "./ApiErrors.js"
import { DeleteImposterUrlParams, ListImpostersUrlParams, ListRequestsUrlParams } from "./ApiSchemas.js"

const IdParams = { id: Schema.String }
const ImposterIdParams = { imposterId: Schema.String }
const StubParams = { imposterId: Schema.String, stubId: Schema.String }
const RequestParams = { id: Schema.String, requestId: Schema.String }
const MessageResponse = Schema.Struct({ message: Schema.String })

const createImposter = HttpApiEndpoint.post("createImposter", "/imposters", {
  payload: CreateImposterRequest,
  success: ImposterResponse.pipe(HttpApiSchema.status(201)),
  error: [ApiBadRequestError, ApiConflictError, ApiServiceError]
})

const listImposters = HttpApiEndpoint.get("listImposters", "/imposters", {
  query: ListImpostersUrlParams,
  success: ListImpostersResponse
})

const getImposter = HttpApiEndpoint.get("getImposter", "/imposters/:id", {
  params: IdParams,
  success: ImposterResponse,
  error: ApiNotFoundError
})

const updateImposter = HttpApiEndpoint.patch("updateImposter", "/imposters/:id", {
  params: IdParams,
  payload: UpdateImposterRequest,
  success: ImposterResponse,
  error: [ApiBadRequestError, ApiNotFoundError, ApiConflictError, ApiServiceError]
})

const deleteImposter = HttpApiEndpoint.delete("deleteImposter", "/imposters/:id", {
  params: IdParams,
  query: DeleteImposterUrlParams,
  success: DeleteImposterResponse,
  error: [ApiNotFoundError, ApiConflictError]
})

// An `index` in the body places the stub in matching order (0 is first); past the end is a 400
const addStub = HttpApiEndpoint.post("addStub", "/imposters/:imposterId/stubs", {
  params: ImposterIdParams,
  payload: AddStubRequest,
  success: Stub.pipe(HttpApiSchema.status(201)),
  error: [ApiBadRequestError, ApiNotFoundError]
})

// What a stub would answer of the unmatched requests seen so far, without adding it
const previewStub = HttpApiEndpoint.post("previewStub", "/imposters/:imposterId/stubs/preview", {
  params: ImposterIdParams,
  payload: CreateStubRequest,
  success: PreviewResponse,
  error: ApiNotFoundError
})

const listStubs = HttpApiEndpoint.get("listStubs", "/imposters/:imposterId/stubs", {
  params: ImposterIdParams,
  success: Schema.Array(Stub),
  error: ApiNotFoundError
})

const updateStub = HttpApiEndpoint.put("updateStub", "/imposters/:imposterId/stubs/:stubId", {
  params: StubParams,
  payload: UpdateStubRequest,
  success: Stub,
  error: ApiNotFoundError
})

const deleteStub = HttpApiEndpoint.delete("deleteStub", "/imposters/:imposterId/stubs/:stubId", {
  params: StubParams,
  success: Stub,
  error: ApiNotFoundError
})

const listRequests = HttpApiEndpoint.get("listRequests", "/imposters/:id/requests", {
  params: IdParams,
  query: ListRequestsUrlParams,
  success: Schema.Array(RequestLogEntry),
  error: ApiNotFoundError
})

// Why a logged request matches the stub it does (or none), against the current stubs
const explainRequest = HttpApiEndpoint.get("explainRequest", "/imposters/:id/requests/:requestId/explain", {
  params: RequestParams,
  success: ExplainResponse,
  error: ApiNotFoundError
})

const clearRequests = HttpApiEndpoint.delete("clearRequests", "/imposters/:id/requests", {
  params: IdParams,
  success: MessageResponse,
  error: ApiNotFoundError
})

const getImposterStats = HttpApiEndpoint.get("getImposterStats", "/imposters/:id/stats", {
  params: IdParams,
  success: Statistics,
  error: ApiNotFoundError
})

const resetImposterStats = HttpApiEndpoint.delete("resetImposterStats", "/imposters/:id/stats", {
  params: IdParams,
  success: MessageResponse,
  error: ApiNotFoundError
})

export const ImpostersGroup = HttpApiGroup.make("imposters")
  .add(createImposter)
  .add(listImposters)
  .add(getImposter)
  .add(updateImposter)
  .add(deleteImposter)
  .add(addStub)
  .add(previewStub)
  .add(listStubs)
  .add(updateStub)
  .add(deleteStub)
  .add(listRequests)
  .add(explainRequest)
  .add(clearRequests)
  .add(getImposterStats)
  .add(resetImposterStats)
