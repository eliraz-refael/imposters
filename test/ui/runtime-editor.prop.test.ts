// @vitest-environment happy-dom
import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Case, runCase, useEditorHarness } from "imposters/test/helpers/stubEditor"
import { describe } from "vitest"

// The stub editor's debounced check as a property: random interleavings of edits (typing,
// pastes, the mode control), time passing, and check answers arriving in any order or failing.
// The invariant, after every step: the status shows nothing for text that is gone (it is pending,
// or what it shows is for the text as it is now); and once typing stops and every answer is in,
// it settles on the current text. The harness is test/helpers/stubEditor.ts.

useEditorHarness()

describe("ui.ts stub editor (property)", () => {
  it.effect.prop(
    "never shows a check of stale text, and settles on the current text",
    { scenario: Case },
    ({ scenario }) => Effect.promise(() => runCase(scenario)),
    { timeout: 60_000, arbitrary: { runs: 200, size: 40 } }
  )
})
