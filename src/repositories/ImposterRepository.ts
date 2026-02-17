import { Context, Data, Effect, HashMap, Layer, Ref } from "effect"
import type { ImposterConfig } from "../domain/imposter"
import { ImposterNotFoundError } from "../domain/imposter"
import type { Stub } from "../schemas/StubSchema"

export class StubNotFoundError extends Data.TaggedError("StubNotFoundError")<{
  readonly imposterId: string
  readonly stubId: string
}> {}

export interface ImposterRecord {
  readonly config: ImposterConfig
  readonly stubs: ReadonlyArray<Stub>
}

export interface ImposterRepositoryShape {
  readonly create: (config: ImposterConfig) => Effect.Effect<ImposterRecord>
  readonly get: (id: string) => Effect.Effect<ImposterRecord, ImposterNotFoundError>
  readonly getAll: Effect.Effect<ReadonlyArray<ImposterRecord>>
  readonly update: (
    id: string,
    fn: (r: ImposterRecord) => ImposterRecord
  ) => Effect.Effect<ImposterRecord, ImposterNotFoundError>
  readonly remove: (id: string) => Effect.Effect<ImposterRecord, ImposterNotFoundError>
  readonly addStub: (imposterId: string, stub: Stub) => Effect.Effect<Stub, ImposterNotFoundError>
  readonly getStubs: (imposterId: string) => Effect.Effect<ReadonlyArray<Stub>, ImposterNotFoundError>
  readonly updateStub: (
    imposterId: string,
    stubId: string,
    fn: (s: Stub) => Stub
  ) => Effect.Effect<Stub, ImposterNotFoundError | StubNotFoundError>
  readonly removeStub: (
    imposterId: string,
    stubId: string
  ) => Effect.Effect<Stub, ImposterNotFoundError | StubNotFoundError>
}

export class ImposterRepository extends Context.Tag("ImposterRepository")<
  ImposterRepository,
  ImposterRepositoryShape
>() {}

export const ImposterRepositoryLive = Layer.effect(
  ImposterRepository,
  Effect.gen(function*() {
    const storeRef = yield* Ref.make(HashMap.empty<string, ImposterRecord>())

    const getRecord = (id: string): Effect.Effect<ImposterRecord, ImposterNotFoundError> =>
      Ref.get(storeRef).pipe(
        Effect.flatMap((store) => {
          const record = HashMap.get(store, id)
          return record._tag === "Some"
            ? Effect.succeed(record.value)
            : Effect.fail(new ImposterNotFoundError({ id }))
        })
      )

    type Store = HashMap.HashMap<string, ImposterRecord>
    type ModifyRecord<A, E> = readonly [Effect.Effect<A, E>, Store]
    type RecordResult = ModifyRecord<ImposterRecord, ImposterNotFoundError>
    type StubResult = ModifyRecord<Stub, ImposterNotFoundError>
    type StubOrNotFound = ModifyRecord<Stub, ImposterNotFoundError | StubNotFoundError>

    const create = (config: ImposterConfig): Effect.Effect<ImposterRecord> => {
      const record: ImposterRecord = { config, stubs: [] }
      return Ref.modify(
        storeRef,
        (store): ModifyRecord<ImposterRecord, never> => [Effect.succeed(record), HashMap.set(store, config.id, record)]
      ).pipe(Effect.flatten)
    }

    const get = (id: string) => getRecord(id)

    const getAll: Effect.Effect<ReadonlyArray<ImposterRecord>> = Ref.get(storeRef).pipe(
      Effect.map((store) => Array.from(HashMap.values(store)))
    )

    const update = (id: string, fn: (r: ImposterRecord) => ImposterRecord) =>
      Ref.modify(storeRef, (store): RecordResult => {
        const existing = HashMap.get(store, id)
        if (existing._tag === "None") {
          return [Effect.fail(new ImposterNotFoundError({ id })), store]
        }
        const updated = fn(existing.value)
        return [Effect.succeed(updated), HashMap.set(store, id, updated)]
      }).pipe(Effect.flatten)

    const remove = (id: string) =>
      Ref.modify(storeRef, (store): RecordResult => {
        const existing = HashMap.get(store, id)
        if (existing._tag === "None") {
          return [Effect.fail(new ImposterNotFoundError({ id })), store]
        }
        return [Effect.succeed(existing.value), HashMap.remove(store, id)]
      }).pipe(Effect.flatten)

    const addStub = (imposterId: string, stub: Stub) =>
      Ref.modify(storeRef, (store): StubResult => {
        const existing = HashMap.get(store, imposterId)
        if (existing._tag === "None") {
          return [Effect.fail(new ImposterNotFoundError({ id: imposterId })), store]
        }
        const updated: ImposterRecord = { ...existing.value, stubs: [...existing.value.stubs, stub] }
        return [Effect.succeed(stub), HashMap.set(store, imposterId, updated)]
      }).pipe(Effect.flatten)

    const getStubs = (imposterId: string) => getRecord(imposterId).pipe(Effect.map((r) => r.stubs))

    const updateStub = (imposterId: string, stubId: string, fn: (s: Stub) => Stub) =>
      Ref.modify(storeRef, (store): StubOrNotFound => {
        const existing = HashMap.get(store, imposterId)
        if (existing._tag === "None") {
          return [Effect.fail(new ImposterNotFoundError({ id: imposterId })), store]
        }
        const stubIndex = existing.value.stubs.findIndex((s) => s.id === stubId)
        if (stubIndex === -1) {
          return [Effect.fail(new StubNotFoundError({ imposterId, stubId })), store]
        }
        const updatedStub = fn(existing.value.stubs[stubIndex]!)
        const newStubs = [...existing.value.stubs]
        newStubs[stubIndex] = updatedStub
        const updated: ImposterRecord = { ...existing.value, stubs: newStubs }
        return [Effect.succeed(updatedStub), HashMap.set(store, imposterId, updated)]
      }).pipe(Effect.flatten)

    const removeStub = (imposterId: string, stubId: string) =>
      Ref.modify(storeRef, (store): StubOrNotFound => {
        const existing = HashMap.get(store, imposterId)
        if (existing._tag === "None") {
          return [Effect.fail(new ImposterNotFoundError({ id: imposterId })), store]
        }
        const stub = existing.value.stubs.find((s) => s.id === stubId)
        if (!stub) {
          return [Effect.fail(new StubNotFoundError({ imposterId, stubId })), store]
        }
        const updated: ImposterRecord = {
          ...existing.value,
          stubs: existing.value.stubs.filter((s) => s.id !== stubId)
        }
        return [Effect.succeed(stub), HashMap.set(store, imposterId, updated)]
      }).pipe(Effect.flatten)

    return { create, get, getAll, update, remove, addStub, getStubs, updateStub, removeStub }
  })
)
