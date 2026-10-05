// @vitest-environment happy-dom
import * as DateTime from "effect/DateTime"
import { ImposterConfig } from "imposters/domain/imposter"
import { stubsPage } from "imposters/ui/pages/stubs"
import { draftFromQuery } from "imposters/ui/stubDraft"
import { describe, expect, it } from "vitest"

// The old stubs page's add form (htmx until PR 8), prefilled by "stub it"

const config = ImposterConfig({
  id: "imp",
  name: "orders-api",
  port: 3202,
  protocol: "HTTP",
  status: "running",
  createdAt: DateTime.makeUnsafe(0)
})

const field = (form: HTMLFormElement, name: string): HTMLTextAreaElement => {
  const el = form.elements.namedItem(name)
  if (!(el instanceof HTMLTextAreaElement)) throw new Error(`no textarea ${name}`)
  return el
}

// Runs the form's htmx after-request handler as htmx does: `this` is the form
const afterRequest = (form: HTMLFormElement, successful: boolean): void => {
  const code = form.getAttribute("hx-on::after-request")
  if (code === null) throw new Error("no after-request handler")
  const handler = new Function("event", code)
  handler.call(form, { detail: { successful } })
}

const draftNoteShown = (): boolean => (document.body.textContent ?? "").includes("A draft for GET /payments/pm_81")

const render = (): HTMLFormElement => {
  const draft = draftFromQuery(new URLSearchParams("draft=GET&path=/payments/pm_81"))
  if (draft === null) throw new Error("no draft")
  const page = stubsPage({ config, stubs: [], draft }).value
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(page)?.[1] ?? ""
  const form = document.querySelector<HTMLFormElement>("form[hx-post='/_admin/stubs']")
  if (form === null) throw new Error("no add form")
  return form
}

describe("the stubs page's add form, prefilled from a draft", () => {
  it("starts with the draft", () => {
    const form = render()
    expect(field(form, "predicates").value).toContain("/payments/pm_81")
    expect(field(form, "responses").value).toContain("\"status\": 200")
  })

  it("after a successful add, clears to an empty form (not back to the draft) and drops the draft note", () => {
    const form = render()
    expect(draftNoteShown()).toBe(true)
    afterRequest(form, true)
    expect(field(form, "predicates").value).toBe("[]")
    expect(field(form, "responses").value).toBe("")
    expect(draftNoteShown()).toBe(false)
  })

  it("after a failed add, keeps what was typed", () => {
    const form = render()
    field(form, "responses").value = "[{\"status\": 201}]"
    afterRequest(form, false)
    expect(field(form, "responses").value).toBe("[{\"status\": 201}]")
    expect(draftNoteShown()).toBe(true)
  })
})
