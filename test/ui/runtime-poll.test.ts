// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

// The browser runtime's throttled poll (data-poll-throttle), on fake timers: each SSE arrival
// (`ui:arrival`) refreshes the element, at most once per throttle period.

const THROTTLE = 1000
const answers: Array<(body: string) => void> = []
const fetched: Array<string> = []

const arrival = (): boolean => document.dispatchEvent(new CustomEvent("ui:arrival"))

const panel = (): string => document.getElementById("side")?.textContent ?? ""

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
  // Each fetch stays in flight until the test answers it
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    fetched.push(String(input))
    return new Promise<Response>((resolve) => answers.push((body) => resolve(new Response(body))))
  })
  document.body.innerHTML =
    `<div id="side" data-poll="60000" data-poll-throttle="${THROTTLE}" data-url="/_admin/fragments/live">v0</div>`
  await import("../../ui-assets/ui")
})

afterAll(() => {
  vi.useRealTimers()
})

// Answers the fetch in flight and lets its swap land
const answer = async (body: string): Promise<void> => {
  const next = answers.shift()
  if (next === undefined) throw new Error("no fetch in flight")
  next(body)
  await vi.advanceTimersByTimeAsync(0)
}

describe("ui.ts throttled poll", () => {
  it("an arrival while a refresh is in flight refreshes again once it completes, still throttled", async () => {
    arrival()
    await vi.advanceTimersByTimeAsync(THROTTLE)
    expect(fetched).toHaveLength(1)

    // Arrives while the first refresh is still waiting for its answer, which comes later
    arrival()
    await vi.advanceTimersByTimeAsync(THROTTLE * 2)
    expect(fetched).toHaveLength(1)
    await answer("v1")
    expect(panel()).toBe("v1")

    // The arrival is not lost: one more refresh, a throttle period after the last one began
    await vi.advanceTimersByTimeAsync(THROTTLE)
    expect(fetched).toHaveLength(2)
    await answer("v2")
    expect(panel()).toBe("v2")

    // And only one: nothing else arrived
    await vi.advanceTimersByTimeAsync(THROTTLE * 3)
    expect(fetched).toHaveLength(2)
  })

  it("arrivals in one throttle period make one refresh", async () => {
    const before = fetched.length
    arrival()
    arrival()
    arrival()
    await vi.advanceTimersByTimeAsync(THROTTLE)
    expect(fetched).toHaveLength(before + 1)
    await answer("v3")
    await vi.advanceTimersByTimeAsync(THROTTLE * 3)
    expect(fetched).toHaveLength(before + 1)
  })
})
