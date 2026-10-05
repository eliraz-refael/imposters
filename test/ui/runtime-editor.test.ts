// @vitest-environment happy-dom
import {
  answer,
  area,
  element,
  flush,
  inFlight,
  mount,
  runCase,
  sent,
  setText,
  shown,
  status,
  TEXTS,
  useEditorHarness
} from "imposters/test/helpers/stubEditor"
import { describe, expect, it, vi } from "vitest"
import { CHECK_DELAY_MS } from "../../ui-assets/editor"

// The stub editor in the browser runtime (ui-assets/editor.ts, started by ui.ts), on the real
// editor markup: the debounced check, the mode control, and the typing helpers. The property is
// in runtime-editor.prop.test.ts; the examples it found are pinned here.

useEditorHarness()

const wait = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
  await flush()
}

const radio = (mode: string): HTMLInputElement => element<HTMLInputElement>(`[data-editor-mode] input[value="${mode}"]`)

const key = (name: string, shift = false): void => {
  area().dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey: shift, bubbles: true, cancelable: true }))
}

describe("ui.ts stub editor: the check", () => {
  it("marks the status pending at once, and checks once typing pauses", async () => {
    await mount(TEXTS.VALID)
    setText(`${TEXTS.VALID} `)
    expect(status().dataset.state).toBe("pending")
    await wait(CHECK_DELAY_MS - 50)
    setText(TEXTS.VALID)
    await wait(CHECK_DELAY_MS - 50)
    expect(sent()).toEqual([])
    await wait(50)
    expect(sent()).toEqual([TEXTS.VALID])
    answer(0)
    await flush()
    expect(status().dataset.state).toBe("valid")
    expect(shown()).toBe("current")
  })

  it("shows a syntax error without asking the server, with its line and column", async () => {
    await mount(TEXTS.VALID)
    setText(TEXTS.SYNTAX)
    await wait(CHECK_DELAY_MS)
    expect(sent()).toEqual([])
    expect(status().dataset.state).toBe("invalid")
    expect(status().textContent).toContain("line 3, column 1: unexpected \"}\"")
  })

  it("drops an answer for text edited since (found by the property)", async () => {
    await runCase({
      start: "VALID",
      steps: [{ _tag: "Replace", text: "OTHER_VALID" }, { _tag: "Advance", ms: 1000 }, { _tag: "Delete" }]
    })
  })

  it("drops an older answer that lands after a newer one", async () => {
    await mount(TEXTS.SYNTAX)
    setText(TEXTS.VALID)
    await wait(CHECK_DELAY_MS)
    setText(TEXTS.OTHER_VALID)
    await wait(CHECK_DELAY_MS)
    expect(inFlight().map((r) => r.text)).toEqual([TEXTS.VALID, TEXTS.OTHER_VALID])
    answer(1)
    await flush()
    expect(shown()).toBe("current")
    answer(0)
    await flush()
    expect(shown()).toBe("current")
    expect(status().querySelector("[data-text]")?.getAttribute("data-text")).toBe(TEXTS.OTHER_VALID)
  })

  it("says so when the server cannot be reached, for the current text only", async () => {
    await mount(TEXTS.SYNTAX)
    setText(TEXTS.VALID)
    await wait(CHECK_DELAY_MS)
    answer(0, false)
    await flush()
    expect(status().textContent).toContain("could not reach the server")
  })
})

describe("ui.ts stub editor: the mode control", () => {
  it("is shown by the script, follows the JSON, and is off while the text is not JSON", async () => {
    await mount(TEXTS.VALID)
    expect(element("[data-editor-mode]").hidden).toBe(false)
    expect(radio("sequential").checked).toBe(true)
    setText(TEXTS.OTHER_VALID)
    expect(radio("random").checked).toBe(true)
    setText(TEXTS.SYNTAX)
    expect(radio("random").disabled).toBe(true)
    expect(radio("random").checked).toBe(false)
  })

  it("rewrites the JSON from the draft when clicked, and that is checked too", async () => {
    await mount(TEXTS.VALID)
    radio("repeat").click()
    await flush()
    expect(area().value).toContain(`"responseMode": "repeat"`)
    expect(area().value).toContain(`{ "field": "path", "operator": "equals", "value": "/orders" }`)
    expect(status().dataset.state).toBe("pending")
    await wait(CHECK_DELAY_MS)
    expect(sent()).toEqual([area().value])
  })
})

describe("ui.ts stub editor: focus", () => {
  it("an editor opened for an edit or a draft takes the focus", async () => {
    await mount(TEXTS.VALID, { focus: true })
    expect(document.activeElement).toBe(area())
  })
})

describe("ui.ts stub editor: typing helpers", () => {
  it("closes a brace and steps over its closer", async () => {
    await mount("")
    area().setSelectionRange(0, 0)
    key("{")
    expect(area().value).toBe("{}")
    expect(area().selectionStart).toBe(1)
    key("}")
    expect(area().value).toBe("{}")
    expect(area().selectionStart).toBe(2)
  })

  it("Enter between braces opens an indented line, and the edit is checked", async () => {
    await mount("{}")
    area().setSelectionRange(1, 1)
    key("Enter")
    expect(area().value).toBe("{\n  \n}")
    expect(area().selectionStart).toBe(4)
    expect(status().dataset.state).toBe("pending")
  })

  it("Tab indents, and after Esc it is left to the browser (to move the focus on)", async () => {
    await mount("a")
    area().setSelectionRange(0, 0)
    key("Tab")
    expect(area().value).toBe("  a")
    key("Escape")
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    area().dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
    expect(area().value).toBe("  a")
  })
})
