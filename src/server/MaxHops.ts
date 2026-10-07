import * as Context from "effect/Context"
import { DEFAULT_MAX_HOPS } from "../matching/Hops.js"

// How many hops a chain of outbound calls may take before an imposter answers 508 instead of
// calling out (--max-hops / IMPOSTERS_MAX_HOPS). Process-wide: the count crosses imposters, so
// per-imposter limits would disagree along one chain.
export const MaxHops = Context.Reference<number>("imposters/MaxHops", { defaultValue: () => DEFAULT_MAX_HOPS })
