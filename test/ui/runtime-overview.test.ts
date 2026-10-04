// @vitest-environment happy-dom
import * as Option from "effect/Option"
import { type ImposterRow, type Overview, summarize } from "imposters/ui/admin/OverviewData"
import { emptyCreateForm, overviewFragment, overviewPage } from "imposters/ui/admin/pages/Overview"
import { beforeAll, describe, expect, it, vi } from "vitest"

// The browser runtime (ui-assets/ui.ts) on the real /_ui markup and the router's real answers

const row = (overrides: Partial<ImposterRow>): ImposterRow => ({
  id: "imp-1",
  name: "users-api",
  port: 3000,
  protocol: "HTTP",
  running: true,
  stubs: 0,
  uiUrl: "http://localhost:3000/_admin",
  timeline: [],
  last15: { requests: 0, serverErrors: 0, unmatched: 0 },
  ...overrides
})

const overview = (imposters: ReadonlyArray<ImposterRow>): Overview => ({
  imposters,
  summary: summarize(imposters),
  health: Option.none(),
  protocols: ["HTTP"],
  portRange: Option.none(),
  bindHost: "127.0.0.1",
  adminPort: 2525,
  version: "1.2.3"
})

let answer: Response = new Response("")

// The <body> of a rendered page
const bodyOf = (page: string): string => page.slice(page.indexOf("<body>") + 6, page.indexOf("</body>"))

const input = (id: string): HTMLInputElement => {
  const el = document.getElementById(id)
  if (!(el instanceof HTMLInputElement)) throw new Error(`no input #${id}`)
  return el
}

beforeAll(async () => {
  vi.stubGlobal("fetch", () => Promise.resolve(answer))
  document.body.innerHTML = bodyOf(overviewPage(overview([row({})]), { theme: null, form: emptyCreateForm }).value)
  await import("../../ui-assets/ui")
})

describe("ui.ts on the /_ui overview", () => {
  it("a create whose start fails shows the new stopped row, resets the form and shows the message in it", async () => {
    const stopped = row({ id: "imp-2", name: "orders-api", port: 3001, running: false })
    const message = "Created orders-api, but it could not start: Failed to bind port 3001."
    answer = new Response(overviewFragment(overview([row({}), stopped]), { formError: message }).value)

    input("new-name").value = "orders-api"
    input("new-port").value = "3001"
    const form = document.querySelector("form.new-form")
    const create = form?.querySelector("button[type=submit]")
    if (!(form instanceof HTMLFormElement) || !(create instanceof HTMLElement)) throw new Error("no create form")
    form.requestSubmit(create)

    await vi.waitFor(() => expect(document.getElementById("imposter-imp-2")).not.toBeNull())
    expect(document.getElementById("imposter-imp-2")?.className).toContain("row-off")
    expect(document.getElementById("overview-headline")?.textContent).toContain("1 of 2 running")
    expect(document.getElementById("new-error")?.textContent).toBe(message)
    expect(input("new-name").value).toBe("")
    expect(input("new-port").value).toBe("")

    // The slot is still the form's: the next action clears it
    answer = new Response(overviewFragment(overview([row({}), stopped])).value)
    form.requestSubmit(create)
    await vi.waitFor(() => expect(document.getElementById("new-error")?.textContent).toBe(""))
    expect(document.querySelector("form.new-form [data-error-slot]")?.id).toBe("new-error")
  })
})
