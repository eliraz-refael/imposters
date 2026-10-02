import * as Data from "effect/Data"
import * as Equal from "effect/Equal"
import type { Stub, UpdateStubRequest } from "../schemas/StubSchema.js"

/** A stub edit; the admin API and the `/_admin` UI both apply theirs through ImposterServer.applyStubChange */
export type StubChange = Data.TaggedEnum<{
  // `index` is the insert position (0 is first); omitted, the stub goes last
  Add: { readonly stub: Stub; readonly index?: number | undefined }
  Update: { readonly stubId: string; readonly patch: UpdateStubRequest }
  Remove: { readonly stubId: string }
}>

export const StubChange = Data.taggedEnum<StubChange>()

/** The stub with the patch's given fields replacing its own */
export const applyStubPatch = (stub: Stub, patch: UpdateStubRequest): Stub => ({
  ...stub,
  ...(patch.predicates !== undefined ? { predicates: patch.predicates } : {}),
  ...(patch.responses !== undefined ? { responses: patch.responses } : {}),
  ...(patch.responseMode !== undefined ? { responseMode: patch.responseMode } : {})
})

/**
 * Whether an edit changed what the stub answers (its responses or how it cycles them). Such an
 * edit restarts the stub's hit counters and response cycle; a predicate-only edit keeps both.
 */
export const answersChanged = (before: Stub, after: Stub): boolean =>
  before.responseMode !== after.responseMode || !Equal.equals(before.responses, after.responses)
