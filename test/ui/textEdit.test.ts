import { describe, expect, it } from "vitest"
import { applyToState, editForKey, type TextState } from "../../ui-assets/textEdit"

// The editor's typing helpers. In these strings one `|` is the caret; two mark a selection.

const state = (marked: string): TextState => {
  const start = marked.indexOf("|")
  const second = marked.indexOf("|", start + 1)
  const text = marked.replaceAll("|", "")
  return { text, start, end: second === -1 ? start : second - 1 }
}

const marked = ({ end, start, text }: TextState): string =>
  start === end ?
    `${text.slice(0, start)}|${text.slice(start)}` :
    `${text.slice(0, start)}|${text.slice(start, end)}|${text.slice(end)}`

// What typing `key` does: the result with its caret, or null where the browser types as usual
const press = (before: string, key: string, shift = false): string | null => {
  const s = state(before)
  const edit = editForKey(s, key, shift)
  return edit === null ? null : marked(applyToState(s, edit))
}

describe("auto-close", () => {
  it("closes brackets and braces, and wraps a selection", () => {
    expect(press("|", "{")).toBe("{|}")
    expect(press("x: |", "[")).toBe("x: [|]")
    expect(press("|abc|", "[")).toBe("[|abc|]")
  })

  it("steps over the closer it put there, and leaves others alone", () => {
    expect(press("{|}", "}")).toBe("{}|")
    expect(press("[|]", "]")).toBe("[]|")
    expect(press("{|", "}")).toBeNull()
    expect(press("{|]", "}")).toBeNull()
  })

  it("closes a quote, steps over a closing one, and types a plain one after a word or a backslash", () => {
    expect(press(": |", "\"")).toBe(": \"|\"")
    expect(press("\"abc|\"", "\"")).toBe("\"abc\"|")
    expect(press("don|", "\"")).toBe("don\"|")
    expect(press("\"a\\|", "\"")).toBe("\"a\\\"|")
    expect(press("|word|", "\"")).toBe("\"|word|\"")
  })

  it("Backspace between an empty pair removes both", () => {
    expect(press("{|}", "Backspace")).toBe("|")
    expect(press("\"|\"", "Backspace")).toBe("|")
    expect(press("{a|}", "Backspace")).toBeNull()
    expect(press("|x|", "Backspace")).toBeNull()
  })
})

describe("indent", () => {
  it("Tab inserts two spaces at a caret", () => {
    expect(press("a|b", "Tab")).toBe("a  |b")
  })

  it("Tab and Shift-Tab indent and outdent every line a selection touches", () => {
    expect(press("|a\nb|\nc", "Tab")).toBe("|  a\n  b|\nc")
    expect(press("|  a\n  b|\nc", "Tab", true)).toBe("|a\nb|\nc")
    // A selection ending at the start of a line leaves that line alone
    expect(press("|a\n|b", "Tab")).toBe("|  a|\nb")
  })

  it("Shift-Tab at a caret outdents its line and keeps the caret in place", () => {
    expect(press("x\n    a|b", "Tab", true)).toBe("x\n  a|b")
    expect(press(" |a", "Tab", true)).toBe("|a")
    expect(press("a|", "Tab", true)).toBe("a|")
  })
})

describe("Enter", () => {
  it("keeps the line's indent", () => {
    expect(press("  \"a\": 1,|", "Enter")).toBe("  \"a\": 1,\n  |")
  })

  it("indents after an opener, and puts its closer on its own line", () => {
    expect(press("  \"a\": {|}", "Enter")).toBe("  \"a\": {\n    |\n  }")
    expect(press("[|", "Enter")).toBe("[\n  |")
  })

  it("Shift-Enter is left to the browser", () => {
    expect(press("a|", "Enter", true)).toBeNull()
  })
})

it("other keys are left to the browser", () => {
  expect(press("a|", "a")).toBeNull()
  expect(press("a|", "ArrowLeft")).toBeNull()
})
