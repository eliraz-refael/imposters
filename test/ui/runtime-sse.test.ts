// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest"

// The browser runtime (ui-assets/ui.ts), run as source in happy-dom. Every live list is started
// the way a page starts one after a click: a data-action swap puts it into the page.

// An EventSource we drive: it records what the runtime opened and closed
class FakeEventSource extends EventTarget {
  static readonly instances: Array<FakeEventSource> = []
  closed = false
  constructor(readonly url: string) {
    super()
    FakeEventSource.instances.push(this)
  }
  close(): void {
    this.closed = true
  }
  emit(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }))
  }
}

let nextFragment = ""
const addListener = vi.spyOn(window, "addEventListener")

// Window listeners of this type still attached: registered, and not removed by an aborted signal
const liveWindowListeners = (type: string): number =>
  addListener.mock.calls.filter(([registered, , options]) =>
    registered === type && !(typeof options === "object" && options.signal?.aborted === true)
  ).length

const button = (): HTMLElement => {
  const el = document.getElementById("load")
  if (el === null) throw new Error("no #load button")
  return el
}

// Clicks the data-action button and waits for the swap to start the new list's connection
const swapIn = async (id: string): Promise<FakeEventSource> => {
  const before = FakeEventSource.instances.length
  nextFragment = `<ul id="${id}" data-sse="/_admin/events"></ul>`
  button().click()
  await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(before + 1))
  await vi.waitFor(() => expect(document.getElementById(id)).not.toBeNull())
  return FakeEventSource.instances[before]
}

const persistedPageshow = (): Event => {
  const event = new Event("pageshow")
  Object.defineProperty(event, "persisted", { value: true })
  return event
}

beforeAll(async () => {
  vi.stubGlobal("EventSource", FakeEventSource)
  vi.stubGlobal("fetch", () => Promise.resolve(new Response(nextFragment)))
  document.body.innerHTML = `<div id="live"></div><button id="load" data-action="GET /fragment" data-target="#live">`
  await import("../../ui-assets/ui")
})

describe("ui.ts live updates (data-sse)", () => {
  it("a list swapped out closes its connection on its next event and drops its page listeners", async () => {
    const old = await swapIn("first")
    const pageshow = liveWindowListeners("pageshow")
    const pagehide = liveWindowListeners("pagehide")
    // The spy sees the runtime's own listeners, so the counts below mean something
    expect(pageshow).toBeGreaterThan(0)
    expect(pagehide).toBeGreaterThan(0)

    const current = await swapIn("second")
    old.emit("<li>late</li>")

    expect(old.closed).toBe(true)
    expect(current.closed).toBe(false)
    // The new list added one of each, the old one's are gone
    expect(liveWindowListeners("pageshow")).toBe(pageshow)
    expect(liveWindowListeners("pagehide")).toBe(pagehide)
    // Its late event did not land anywhere on the page
    expect(document.body.innerHTML).not.toContain("late")
  })

  it("the new list opened exactly one connection, and still receives its events", async () => {
    await swapIn("third")
    const opened = FakeEventSource.instances.length
    const current = await swapIn("fourth")
    expect(FakeEventSource.instances.length).toBe(opened + 1)
    current.emit("<li>fresh</li>")
    expect(document.getElementById("fourth")?.textContent).toBe("fresh")
  })

  it("a list swapped out closes its connection on the next pageshow, even with no event", async () => {
    const old = await swapIn("fifth")
    const current = await swapIn("sixth")
    const opened = FakeEventSource.instances.length

    window.dispatchEvent(new Event("pageshow"))

    expect(old.closed).toBe(true)
    expect(current.closed).toBe(false)
    expect(FakeEventSource.instances.length).toBe(opened)
  })

  it("a list still on the page closes on pagehide and reopens on a back-forward-cache pageshow", async () => {
    const source = await swapIn("seventh")
    const opened = FakeEventSource.instances.length

    window.dispatchEvent(new Event("pagehide"))
    expect(source.closed).toBe(true)

    window.dispatchEvent(persistedPageshow())
    expect(FakeEventSource.instances.length).toBe(opened + 1)
    expect(FakeEventSource.instances[opened].url).toBe("/_admin/events")
    expect(FakeEventSource.instances[opened].closed).toBe(false)
  })
})
