// @vitest-environment happy-dom
import { it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { runCase, Scenario, toCase, useLiveListHarness } from "imposters/test/helpers/liveList"
import { describe } from "vitest"

// The live page's request list as a property: scenarios of stream opens, drops and give-ups,
// logged requests (arriving at once or still in flight), pauses, re-fetch answers (ok, possibly
// with rows logged after they were sent, or failed), time passing and pagehide/pageshow,
// generated from the `Scenario` Schema and shrunk on failure. Most of a scenario is episodes
// aimed at the hard states (a burst during a re-fetch, a drop mid re-fetch, a pause around an
// answer, an event that arrives after a newer answer). The invariants and the convergence check
// are in test/helpers/liveList.ts.

useLiveListHarness()

describe("ui.ts live list (property)", () => {
  it.effect.prop(
    "keeps its invariants after every step, and converges on the server's newest rows",
    { scenario: Scenario },
    ({ scenario }) => Effect.promise(() => runCase(toCase(scenario))),
    { timeout: 60_000, arbitrary: { runs: 200, size: 60 } } // about 7 s
  )
})
