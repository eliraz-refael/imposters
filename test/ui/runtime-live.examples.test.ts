// @vitest-environment happy-dom
import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { type Case, runCase, useLiveListHarness } from "imposters/test/helpers/liveList"
import { describe } from "vitest"

// Counterexamples test/ui/runtime-live.prop.test.ts found in the live list, shrunk, kept as
// plain cases so each stays pinned. See test/helpers/liveList.ts for the steps and the checks.

useLiveListHarness()

const pinned = (name: string, input: Case): void => {
  it.effect(name, () => Effect.promise(() => runCase(input)))
}

describe("ui.ts live list: found by the property test", () => {
  pinned("a case with no steps converges on what was rendered", { initial: 3, steps: [] })

  pinned("a stream the browser gave up on (CLOSED) is reopened, and the list catches up", {
    initial: 0,
    steps: [{ _tag: "Log", count: 2 }, { _tag: "GiveUp" }]
  })
})
