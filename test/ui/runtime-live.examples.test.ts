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

  pinned("a re-fetch that lands while paused leaves the list as it is", {
    initial: 0,
    steps: [{ _tag: "Log", count: 2 }, { _tag: "Open" }, { _tag: "Pause" }, { _tag: "AnswerOk" }]
  })

  pinned("a stream opened after a re-fetch re-fetches what it missed before it opened", {
    initial: 0,
    steps: [{ _tag: "GiveUp" }, { _tag: "Pause" }, { _tag: "Resume" }, { _tag: "Log", count: 2 }]
  })

  pinned("rows queued before a re-fetch are not added on top of its newer answer", {
    initial: 0,
    steps: [{ _tag: "Open" }, { _tag: "Log", count: 25 }, { _tag: "PageHide" }, { _tag: "Log", count: 25 }]
  })
})
