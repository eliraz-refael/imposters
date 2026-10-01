import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import {
  CreateImposterRequest,
  DeleteImposterResponse,
  ImposterResponse,
  ListImpostersResponse,
  Statistics,
  UpdateImposterRequest
} from "../schemas/ImposterSchema.js"
import { RequestLogEntry } from "../schemas/RequestLogSchema.js"
import { CreateStubRequest, Stub, UpdateStubRequest } from "../schemas/StubSchema.js"
import { ApiBadRequestError, ApiConflictError, ApiNotFoundError, ApiServiceError } from "./ApiErrors.js"
import { DeleteImposterUrlParams, ListImpostersUrlParams, ListRequestsUrlParams } from "./ApiSchemas.js"

const IdParams = { id: Schema.String }
const ImposterIdParams = { imposterId: Schema.String }
const StubParams = { imposterId: Schema.String, stubId: Schema.String }
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

const addStub = HttpApiEndpoint.post("addStub", "/imposters/:imposterId/stubs", {
  params: ImposterIdParams,
  payload: CreateStubRequest,
  success: Stub.pipe(HttpApiSchema.status(201)),
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
  .add(listStubs)
  .add(updateStub)
  .add(deleteStub)
  .add(listRequests)
  .add(clearRequests)
  .add(getImposterStats)
  .add(resetImposterStats)
