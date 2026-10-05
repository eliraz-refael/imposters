// @vitest-environment happy-dom
import {
  answerWith,
  area,
  choose,
  control,
  element,
  flush,
  inFlight,
  mount,
  mustControl,
  press,
  sent,
  setText,
  status,
  textDraft,
  typeInto,
  useEditorHarness
} from "imposters/test/helpers/stubEditor"
import { draftToText } from "imposters/ui/editor/draftText"
import { readForm } from "imposters/ui/editor/formModel"
import { stubFormView } from "imposters/ui/pages/stubForm"
import { describe, expect, it, vi } from "vitest"
import { CHECK_DELAY_MS } from "../../ui-assets/editor"
import { startForm } from "../../ui-assets/form"

// The stub editor's form view in the page (ui-assets/form.ts, started by editor.js), on the real
// editor markup: rows and cards added, removed and reordered, the delay and body switches, a
// body that is not JSON, the form | JSON tabs, the check's marks, and where the focus goes. The
// edits as a property are runtime-form.prop.test.ts.

useEditorHarness()

const STUB = {
  predicates: [
    { field: "method", operator: "equals", value: "GET" },
    { field: "path", operator: "startsWith", value: "/payments/" }
  ],
  responses: [{ status: 200, headers: { "content-type": "application/json" }, body: { id: "pm_81" } }]
}

const TWO = { responses: [{ status: 200 }, { status: 503, body: "busy" }] }

const wait = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
  await flush()
}

const tab = (name: string): HTMLButtonElement => element<HTMLButtonElement>(`[data-tab="${name}"]`)
const formView = (): HTMLElement => element("[data-form-view]")
const jsonView = (): HTMLElement => element("[data-json-view]")
const note = (): HTMLElement => element("[data-editor-note]")
const submit = (): HTMLButtonElement => element<HTMLButtonElement>("button[type=submit]")
const focused = (): string | undefined =>
  document.activeElement instanceof HTMLElement ? document.activeElement.dataset.k : undefined
const visible = (key: string): boolean => {
  const el = control(key)
  return el !== undefined && el.closest("[hidden]") === null
}

describe("the stub form: opening", () => {
  it("opens by default on the draft, with the tabs shown and the JSON view hidden", async () => {
    await mount(draftToText(STUB))
    expect(element("[data-editor-tabs]").hidden).toBe(false)
    expect(formView().hidden).toBe(false)
    expect(jsonView().hidden).toBe(true)
    expect(tab("form").getAttribute("aria-selected")).toBe("true")
    expect(tab("json").getAttribute("aria-selected")).toBe("false")
    expect(mustControl<HTMLSelectElement>("c1.operator").value).toBe("startsWith")
    expect(mustControl<HTMLInputElement>("c1.value").value).toBe("/payments/")
    expect(mustControl<HTMLInputElement>("r0.h0.name").value).toBe("content-type")
    expect(mustControl<HTMLTextAreaElement>("r0.body").value).toBe(`{ "id": "pm_81" }`)
    expect(element("[data-c=reason]").textContent).toBe("OK")
  })

  it("opens on the JSON, saying why, for a stub the form cannot show", async () => {
    await mount(draftToText({
      predicates: [{ field: "body", operator: "equals", value: { amount: 42 } }],
      responses: [{ status: 200 }]
    }))
    expect(formView().hidden).toBe(true)
    expect(jsonView().hidden).toBe(false)
    expect(tab("form").getAttribute("aria-disabled")).toBe("true")
    expect(note().hidden).toBe(false)
    expect(note().textContent).toContain("condition 1 compares the body with JSON, not text")
    // The draft is left exactly as it was
    expect(textDraft()).toEqual({
      predicates: [{ field: "body", operator: "equals", value: { amount: 42 } }],
      responses: [{ status: 200 }]
    })
  })
})

describe("the stub form: conditions", () => {
  it("adds a row, focuses its field, and writes it into the draft", async () => {
    await mount(draftToText(STUB))
    press("add-condition")
    expect(focused()).toBe("c2.field")
    expect(textDraft()).toMatchObject({ predicates: [{}, {}, { field: "path", operator: "equals", value: "" }] })
    expect(status().dataset.state).toBe("pending")
  })

  it("removes a row and focuses the remove button now in its place, else the one above, else add", async () => {
    await mount(draftToText(STUB))
    press("c0.remove")
    expect(textDraft()).toMatchObject({ predicates: [{ field: "path", value: "/payments/" }] })
    expect(focused()).toBe("c0.remove")
    press("c0.remove")
    expect(textDraft()).toMatchObject({ predicates: [] })
    expect(focused()).toBe("add-condition")
  })

  it("a header condition takes a name and a value; exists takes only the name", async () => {
    await mount(draftToText(STUB))
    choose("c1.field", "headers")
    expect(focused()).toBe("c1.field")
    expect(visible("c1.name")).toBe(true)
    expect(mustControl("c1.name").getAttribute("aria-label")).toBe("Condition 2 header name")
    typeInto("c1.name", "authorization")
    choose("c1.operator", "exists")
    expect(visible("c1.value")).toBe(false)
    expect(element("[data-row=condition]:nth-child(2) [data-c=present]").hidden).toBe(false)
    expect(textDraft()).toMatchObject({
      predicates: [{}, { field: "headers", operator: "exists", value: { authorization: "/payments/" } }]
    })
  })

  it("the Aa toggle writes caseSensitive: false, and leaves it out again", async () => {
    await mount(draftToText(STUB))
    expect(mustControl("c0.case").getAttribute("aria-pressed")).toBe("true")
    press("c0.case")
    expect(mustControl("c0.case").getAttribute("aria-pressed")).toBe("false")
    expect(focused()).toBe("c0.case")
    expect(textDraft()).toMatchObject({ predicates: [{ caseSensitive: false }, {}] })
    press("c0.case")
    expect(textDraft()).toEqual(STUB)
  })
})

describe("the stub form: responses", () => {
  it("adds a card and focuses its status; the last card cannot be removed", async () => {
    await mount(draftToText(STUB))
    expect(mustControl<HTMLButtonElement>("r0.remove").disabled).toBe(true)
    press("add-response")
    expect(focused()).toBe("r1.status")
    expect(textDraft()).toMatchObject({ responses: [{}, { status: 200 }] })
    expect(mustControl<HTMLButtonElement>("r0.remove").disabled).toBe(false)
    expect(element("#resp-1-title").textContent).toBe("response 2")
  })

  it("moves a card up and down, the focus going with it", async () => {
    await mount(draftToText(TWO))
    expect(mustControl<HTMLButtonElement>("r0.up").disabled).toBe(true)
    expect(mustControl<HTMLButtonElement>("r1.down").disabled).toBe(true)
    press("r1.up")
    expect(textDraft()).toEqual({ responses: [{ status: 503, body: "busy" }, { status: 200 }] })
    // At the top its up button is off, so the focus lands on its down button
    expect(focused()).toBe("r0.down")
    press("r0.down")
    expect(textDraft()).toEqual(TWO)
    expect(focused()).toBe("r1.up")
  })

  it("removes a card, focusing the remove button now in its place, else the one above", async () => {
    await mount(draftToText(TWO))
    press("r1.remove")
    expect(textDraft()).toEqual({ responses: [{ status: 200 }] })
    // The one card left cannot be removed, so the focus goes to "add response"
    expect(focused()).toBe("add-response")
  })

  it("the status's reason phrase follows what is typed", async () => {
    await mount(draftToText(STUB))
    typeInto("r0.status", "503")
    expect(element("[data-c=reason]").textContent).toBe("Service Unavailable")
    expect(textDraft()).toMatchObject({ responses: [{ status: 503 }] })
    typeInto("r0.status", "")
    expect(element("[data-c=reason]").textContent).toBe("OK (the default)")
    expect(textDraft()).toEqual({
      ...STUB,
      responses: [{ headers: { "content-type": "application/json" }, body: { id: "pm_81" } }]
    })
  })

  it("headers: added (focused by name), named, refused when nameless or repeated, removed", async () => {
    await mount(draftToText(STUB))
    press("r0.add-header")
    expect(focused()).toBe("r0.h1.name")
    // A nameless header cannot go into the draft: the form says so, and the draft waits
    expect(status().textContent).toContain("response 1 · header 2: give the header a name, or remove it")
    expect(mustControl("r0.h1.name").getAttribute("aria-invalid")).toBe("true")
    typeInto("r0.h1.name", "content-type")
    expect(status().textContent).toContain("content-type is already set above")
    typeInto("r0.h1.name", "retry-after")
    typeInto("r0.h1.value", "5")
    expect(textDraft()).toMatchObject({
      responses: [{ headers: { "content-type": "application/json", "retry-after": "5" } }]
    })
    press("r0.h0.remove")
    expect(focused()).toBe("r0.h0.remove")
    expect(textDraft()).toMatchObject({ responses: [{ headers: { "retry-after": "5" } }] })
  })
})

describe("the stub form: delay and body switches", () => {
  it("delay: none, fixed (one input) or range (two, with its hint)", async () => {
    await mount(draftToText(STUB))
    expect(visible("r0.ms")).toBe(false)
    press("r0.delay-fixed")
    expect(focused()).toBe("r0.delay-fixed")
    expect(mustControl("r0.delay-fixed").getAttribute("aria-pressed")).toBe("true")
    expect(visible("r0.ms")).toBe(true)
    expect(textDraft()).toMatchObject({ responses: [{ delay: 500 }] })
    typeInto("r0.ms", "1200")
    expect(textDraft()).toMatchObject({ responses: [{ delay: 1200 }] })
    press("r0.delay-range")
    expect(visible("r0.ms")).toBe(false)
    expect(visible("r0.min") && visible("r0.max")).toBe(true)
    expect(element("[data-c=delay-hint]").hidden).toBe(false)
    expect(textDraft()).toMatchObject({ responses: [{ delay: { min: 1200, max: 1200 } }] })
    typeInto("r0.max", "")
    expect(status().textContent).toContain("response 1 · delay: write the longest delay in milliseconds")
    typeInto("r0.max", "2000")
    expect(textDraft()).toMatchObject({ responses: [{ delay: { min: 1200, max: 2000 } }] })
    press("r0.delay-none")
    expect(textDraft()).toEqual(STUB)
    // Back to fixed: what was typed is still there
    press("r0.delay-fixed")
    expect(mustControl<HTMLInputElement>("r0.ms").value).toBe("1200")
  })

  it("body: JSON, text or none", async () => {
    await mount(draftToText(STUB))
    press("r0.kind-text")
    expect(focused()).toBe("r0.kind-text")
    expect(textDraft()).toMatchObject({ responses: [{ body: `{ "id": "pm_81" }` }] })
    press("r0.kind-none")
    expect(visible("r0.body")).toBe(false)
    expect(textDraft()).toEqual({
      ...STUB,
      responses: [{ status: 200, headers: { "content-type": "application/json" } }]
    })
    press("r0.kind-json")
    expect(textDraft()).toEqual(STUB)
  })

  it("a body that is not JSON: its line and column under it, one thing to fix, add and JSON off", async () => {
    await mount(draftToText(STUB))
    const before = area().value
    await wait(CHECK_DELAY_MS)
    const checks = sent().length
    typeInto("r0.body", `{ "error": "service_unavailable" `)
    const error = element("#resp-0-body-err")
    expect(error.hidden).toBe(false)
    expect(error.textContent).toBe(
      "line 1, column 1: this { is never closed: add a } at its end · or switch to text to send it as written"
    )
    expect(mustControl("r0.body").getAttribute("aria-invalid")).toBe("true")
    expect(mustControl("r0.body").getAttribute("aria-describedby")).toBe("resp-0-body-err")
    expect(status().dataset.state).toBe("invalid")
    expect(status().textContent).toContain("✗ 1 thing to fix")
    expect(status().textContent).toContain("response 1 · body: line 1, column 1: this { is never closed")
    expect(submit().disabled).toBe(true)
    expect(tab("json").getAttribute("aria-disabled")).toBe("true")
    expect(note().textContent).toContain("the JSON opens once the problems below are fixed")
    // The draft waits for a body it can hold, and nothing is checked meanwhile
    expect(area().value).toBe(before)
    await wait(CHECK_DELAY_MS)
    expect(sent()).toHaveLength(checks)
    // The JSON tab stays shut
    tab("json").click()
    expect(formView().hidden).toBe(false)
    // The problem's link focuses the body
    element<HTMLAnchorElement>("[data-goto-key='r0.body']").click()
    expect(focused()).toBe("r0.body")
    // Sent as text instead, it goes in as written
    press("r0.kind-text")
    expect(element("#resp-0-body-err").hidden).toBe(true)
    expect(textDraft()).toMatchObject({ responses: [{ body: `{ "error": "service_unavailable" ` }] })
    expect(submit().disabled).toBe(false)
  })

  it("a JSON body closes its brackets as it is typed", async () => {
    await mount(draftToText(STUB))
    const body = mustControl<HTMLTextAreaElement>("r0.body")
    body.value = ""
    body.setSelectionRange(0, 0)
    body.dispatchEvent(new KeyboardEvent("keydown", { key: "[", bubbles: true, cancelable: true }))
    expect(body.value).toBe("[]")
    expect(textDraft()).toMatchObject({ responses: [{ body: [] }] })
  })
})

describe("the stub form: the tabs", () => {
  it("JSON shows the draft as text; the form opens again only on JSON it can show", async () => {
    await mount(draftToText(STUB))
    press("c0.case")
    tab("json").click()
    expect(jsonView().hidden).toBe(false)
    expect(formView().hidden).toBe(true)
    expect(area().value).toBe(draftToText({
      ...STUB,
      predicates: [{ field: "method", operator: "equals", value: "GET", caseSensitive: false }, STUB.predicates[1]]
    }))
    // Text that is not JSON: the form tab is off once it is checked, and says why
    setText(`{ "responses": [`)
    await wait(CHECK_DELAY_MS)
    expect(tab("form").getAttribute("aria-disabled")).toBe("true")
    expect(note().textContent).toBe("the form opens once the JSON is valid")
    tab("form").click()
    expect(formView().hidden).toBe(true)
    // Fixed: the form opens on the new draft
    setText(draftToText({ responses: [{ status: 418 }] }))
    tab("form").click()
    expect(formView().hidden).toBe(false)
    expect(note().hidden).toBe(true)
    expect(mustControl<HTMLInputElement>("r0.status").value).toBe("418")
    expect(element("[data-c=reason]").textContent).toBe("I'm a teapot")
  })

  it("the arrow keys move between the tabs, opening each", async () => {
    await mount(draftToText(STUB))
    tab("form").focus()
    tab("form").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(tab("json"))
    expect(jsonView().hidden).toBe(false)
    expect(tab("json").tabIndex).toBe(0)
    expect(tab("form").tabIndex).toBe(-1)
  })
})

describe("the stub form: the check", () => {
  it("marks the control a problem is about, and its link focuses it", async () => {
    await mount(draftToText(STUB))
    typeInto("r0.status", "700")
    await wait(CHECK_DELAY_MS)
    expect(inFlight()).toHaveLength(1)
    const path = JSON.stringify(["responses", 0, "status"])
    answerWith(
      0,
      `<span class="status-head" data-check="invalid">✗</span><ul><li data-problem-path='${path}'><span class="in-json"><a href="#stub-json" data-line="4">line 4</a>: …</span><span class="in-form"><a href="#editor-form" data-goto='${path}'>response 1 · status</a> must be …</span></li></ul>`
    )
    await flush()
    expect(mustControl("r0.status").getAttribute("aria-invalid")).toBe("true")
    element<HTMLAnchorElement>("[data-goto]").click()
    expect(focused()).toBe("r0.status")
    // An edit clears the marks until the next answer
    typeInto("r0.status", "200")
    expect(mustControl("r0.status").hasAttribute("aria-invalid")).toBe(false)
  })

  it("in the JSON view, a problem's line puts the caret on that line", async () => {
    await mount(draftToText(STUB))
    tab("json").click()
    setText(draftToText(STUB))
    await wait(CHECK_DELAY_MS)
    answerWith(
      0,
      `<span data-check="invalid">✗</span><ul><li><span class="in-json"><a href="#stub-json" data-line="3">line 3</a>: …</span></li></ul>`
    )
    await flush()
    element<HTMLAnchorElement>("[data-line]").click()
    expect(document.activeElement).toBe(area())
    const lines = area().value.split("\n")
    expect(area().selectionStart).toBe((lines[0]?.length ?? 0) + (lines[1]?.length ?? 0) + 2)
  })
})

describe("the stub form: server and browser draw the same rows", () => {
  it("a state's rows as the server renders them, and as the runtime draws them from the templates", () => {
    const draft = {
      predicates: [
        { field: "headers", operator: "exists", value: { authorization: "" }, caseSensitive: false },
        { field: "path", operator: "matches", value: "^/a" }
      ],
      responses: [
        { status: 503, headers: { "retry-after": "5" }, body: { error: "busy" }, delay: { min: 100, max: 800 } },
        { body: "plain", delay: 20 }
      ],
      responseMode: "repeat"
    }
    const read = readForm(draft)
    if (!read.ok) throw new Error(read.reasons.join("; "))
    const markup = stubFormView(read.form, "repeat").value
    const host = document.createElement("div")
    host.innerHTML = markup
    const within = (root: ParentNode): HTMLElement => {
      const el = root.querySelector<HTMLElement>("[data-form-view]")
      if (el === null) throw new Error("no form view")
      return el
    }
    const server = within(host)
    const copy = document.createElement("div")
    copy.innerHTML = markup
    const drawn = within(copy)
    startForm(drawn, () => undefined).show(read.form)
    const canonical = (root: Element): string =>
      Array.from(root.querySelectorAll("[data-conditions] *, [data-responses] *")).map((el) => {
        const attributes = Array.from(el.attributes)
          .filter((a) => a.name !== "value" && a.name !== "selected")
          .map((a) => `${a.name}=${a.value}`)
          .sort()
          .join(" ")
        // A select by its option's selected attribute, which both write (happy-dom's select value
        // does not always follow a parsed one)
        const value = el instanceof HTMLSelectElement
          ? ` selected=${el.querySelector("option[selected]")?.getAttribute("value") ?? ""}`
          : el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? ` value=${el.value}`
          : ""
        const text = el.children.length === 0 ? ` text=${el.textContent ?? ""}` : ""
        return `<${el.tagName} ${attributes}${value}${text}>`
      }).join("\n")
    expect(canonical(drawn)).toBe(canonical(server))
  })
})
