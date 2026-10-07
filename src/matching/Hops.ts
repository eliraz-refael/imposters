// Loop protection, pure. Every outbound call an imposter makes (a callback or a proxy forward)
// carries `x-imposters-hop`: the hop it arrived with, plus one. A request that arrives at the
// limit and would have to call out is answered 508 instead, with `x-imposters-loop` so the
// caller one hop up can tell a detected loop from a stub that merely answers 508.

export const HOP_HEADER = "x-imposters-hop"
export const LOOP_HEADER = "x-imposters-loop"

// How many hops a chain of calls may take, unless --max-hops or IMPOSTERS_MAX_HOPS say otherwise
export const DEFAULT_MAX_HOPS = 8
// The range --max-hops accepts
export const MAX_HOPS_RANGE = { minimum: 1, maximum: 100 } as const

// The hop a request arrived with: absent or malformed reads as 0
export const parseHop = (value: string | undefined): number => {
  const trimmed = value?.trim() ?? ""
  return /^\d{1,15}$/.test(trimmed) ? Number(trimmed) : 0
}

// The hop an outbound call sends
export const nextHop = (incoming: number): number => incoming + 1

// Whether a request at `incoming` may still call out
export const mayCallOut = (incoming: number, maxHops: number): boolean => incoming < maxHops

export const hopLimitReason = (maxHops: number): string => `hop limit ${maxHops} reached`

// The answer to a request that would need a call past the limit
export const loopResponse = (hop: number, limit: number): Response =>
  new Response(JSON.stringify({ error: "Loop detected", hop, limit }), {
    status: 508,
    headers: { "content-type": "application/json", [LOOP_HEADER]: String(limit) }
  })

// A 508 another imposter gave because it detected a loop (a stub's own 508 has no loop header)
export const isLoopAnswer = (status: number, headers: Readonly<Record<string, string>>): boolean =>
  status === 508 && headers[LOOP_HEADER] !== undefined

// --max-hops, else IMPOSTERS_MAX_HOPS, else the default; an invalid value is an error to report
export const resolveMaxHops = (
  flag: number | undefined,
  env: string | undefined
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: string } => {
  const inRange = (n: number) => Number.isInteger(n) && n >= MAX_HOPS_RANGE.minimum && n <= MAX_HOPS_RANGE.maximum
  const range = `a whole number from ${MAX_HOPS_RANGE.minimum} to ${MAX_HOPS_RANGE.maximum}`
  if (flag !== undefined) {
    return inRange(flag) ? { ok: true, value: flag } : { ok: false, error: `--max-hops must be ${range}, not ${flag}` }
  }
  const text = env?.trim() ?? ""
  if (text === "") return { ok: true, value: DEFAULT_MAX_HOPS }
  const n = /^\d+$/.test(text) ? Number(text) : Number.NaN
  return inRange(n)
    ? { ok: true, value: n }
    : { ok: false, error: `IMPOSTERS_MAX_HOPS must be ${range}, not ${JSON.stringify(text)}` }
}
