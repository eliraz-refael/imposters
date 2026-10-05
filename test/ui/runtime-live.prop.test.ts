// @vitest-environment happy-dom
import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Case, runCase, useLiveListHarness } from "imposters/test/helpers/liveList"
import { describe } from "vitest"

// The live page's request list as a property: random sequences of stream opens, drops and
// give-ups, logged requests, pauses, re-fetch answers (ok or failed), time passing and
// pagehide/pageshow, generated from the `Case` Schema and shrunk on failure. The invariants
// and the convergence check are in test/helpers/liveList.ts.

useLiveListHarness()

describe("ui.ts live list (property)", () => {
  it.effect.prop(
    "keeps its invariants after every step, and converges on the server's newest rows",
    { input: Case },
    ({ input }) => Effect.promise(() => runCase(input)),
    { timeout: 60_000, arbitrary: { runs: 200, size: 60 } }
  )
})
