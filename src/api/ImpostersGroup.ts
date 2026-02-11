import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import * as Schema from "effect/Schema"
import {
  CreateImposterRequest,
  DeleteImposterResponse,
  ImposterResponse,
  ListImpostersResponse,
  UpdateImposterRequest
} from "../schemas/ImposterSchema.js"
import { CreateStubRequest, Stub, UpdateStubRequest } from "../schemas/StubSchema.js"
import { ApiConflictError, ApiNotFoundError, ApiServiceError } from "./ApiErrors.js"
import { DeleteImposterUrlParams, ListImpostersUrlParams } from "./ApiSchemas.js"

const createImposter = HttpApiEndpoint.post("createImposter", "/imposters")
  .setPayload(CreateImposterRequest)
  .addSuccess(ImposterResponse, { status: 201 })
  .addError(ApiConflictError)
  .addError(ApiServiceError)

const listImposters = HttpApiEndpoint.get("listImposters", "/imposters")
  .setUrlParams(ListImpostersUrlParams)
  .addSuccess(ListImpostersResponse)

const getImposter =
  HttpApiEndpoint.get("getImposter")`/imposters/${HttpApiSchema.param("id", Schema.String)}`
    .addSuccess(ImposterResponse)
    .addError(ApiNotFoundError)

const updateImposter =
  HttpApiEndpoint.patch("updateImposter")`/imposters/${HttpApiSchema.param("id", Schema.String)}`
    .setPayload(UpdateImposterRequest)
    .addSuccess(ImposterResponse)
    .addError(ApiNotFoundError)
    .addError(ApiConflictError)
    .addError(ApiServiceError)

const deleteImposter =
  HttpApiEndpoint.del("deleteImposter")`/imposters/${HttpApiSchema.param("id", Schema.String)}`
    .setUrlParams(DeleteImposterUrlParams)
    .addSuccess(DeleteImposterResponse)
    .addError(ApiNotFoundError)
    .addError(ApiConflictError)

const addStub =
  HttpApiEndpoint.post("addStub")`/imposters/${HttpApiSchema.param("imposterId", Schema.String)}/stubs`
    .setPayload(CreateStubRequest)
    .addSuccess(Stub, { status: 201 })
    .addError(ApiNotFoundError)

const listStubs =
  HttpApiEndpoint.get("listStubs")`/imposters/${HttpApiSchema.param("imposterId", Schema.String)}/stubs`
    .addSuccess(Schema.Array(Stub))
    .addError(ApiNotFoundError)

const updateStub =
  HttpApiEndpoint.put("updateStub")`/imposters/${HttpApiSchema.param("imposterId", Schema.String)}/stubs/${HttpApiSchema.param("stubId", Schema.String)}`
    .setPayload(UpdateStubRequest)
    .addSuccess(Stub)
    .addError(ApiNotFoundError)

const deleteStub =
  HttpApiEndpoint.del("deleteStub")`/imposters/${HttpApiSchema.param("imposterId", Schema.String)}/stubs/${HttpApiSchema.param("stubId", Schema.String)}`
    .addSuccess(Stub)
    .addError(ApiNotFoundError)

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
