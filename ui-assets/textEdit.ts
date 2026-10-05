/**
 * The stub editor's typing helpers, as pure functions over a textarea's text and selection:
 * brackets and quotes close themselves, Tab and Shift-Tab indent, Enter keeps the indent, and
 * Backspace between a pair removes both. editor.ts applies the edit to the textarea.
 */

/** A textarea's text and selection (start === end is a caret) */
export interface TextState {
  readonly text: string
  readonly start: number
  readonly end: number
}

/** Replace [from, to) with `insert`, then select [selectStart, selectEnd) */
export interface TextEdit {
  readonly from: number
  readonly to: number
  readonly insert: string
  readonly selectStart: number
  readonly selectEnd: number
}

const INDENT = "  "
const PAIRS: Readonly<Record<string, string>> = { "{": "}", "[": "]", "\"": "\"" }

const caret = (from: number, to: number, insert: string, at: number): TextEdit => ({
  from,
  to,
  insert,
  selectStart: at,
  selectEnd: at
})

const lineStart = (text: string, at: number): number => text.lastIndexOf("\n", at - 1) + 1

const indentOf = (text: string, at: number): string => {
  const start = lineStart(text, at)
  return /^[ \t]*/.exec(text.slice(start))?.[0] ?? ""
}

// The whole lines a selection touches; a selection ending at a line's start leaves that line out
const blockOf = (state: TextState): { readonly from: number; readonly to: number } => {
  const lastAt = state.end > state.start && state.text[state.end - 1] === "\n" ? state.end - 1 : state.end
  const end = state.text.indexOf("\n", lastAt)
  return { from: lineStart(state.text, state.start), to: end === -1 ? state.text.length : end }
}

const reindent = (state: TextState, outdent: boolean): TextEdit => {
  const block = blockOf(state)
  const lines = state.text.slice(block.from, block.to).split("\n")
  const changed = lines.map((line) => outdent ? line.replace(/^ {1,2}|^\t/, "") : INDENT + line)
  const insert = changed.join("\n")
  // A caret stays where it was in its line; a selection grows to the whole lines
  if (state.start === state.end) {
    const shift = (changed[0]?.length ?? 0) - (lines[0]?.length ?? 0)
    return caret(block.from, block.to, insert, Math.max(block.from, state.start + shift))
  }
  return { from: block.from, to: block.to, insert, selectStart: block.from, selectEnd: block.from + insert.length }
}

const openPair = (state: TextState, open: string, close: string): TextEdit => {
  const selected = state.text.slice(state.start, state.end)
  if (selected !== "") {
    return {
      from: state.start,
      to: state.end,
      insert: open + selected + close,
      selectStart: state.start + 1,
      selectEnd: state.end + 1
    }
  }
  return caret(state.start, state.end, open + close, state.start + 1)
}

const quote = (state: TextState): TextEdit => {
  const before = state.text[state.start - 1]
  const after = state.text[state.start]
  if (state.start === state.end) {
    // Typing the closing quote of a string steps over the one already there
    if (after === "\"" && before !== "\\") return caret(state.start, state.start, "", state.start + 1)
    // Inside a word or after a backslash, a quote is just a quote
    if (before === "\\" || (before !== undefined && /\w/.test(before))) {
      return caret(state.start, state.end, "\"", state.start + 1)
    }
  }
  return openPair(state, "\"", "\"")
}

const newline = (state: TextState): TextEdit => {
  const indent = indentOf(state.text, state.start)
  const before = state.text[state.start - 1]
  const after = state.text[state.end]
  if (before === "{" || before === "[") {
    const inner = `\n${indent}${INDENT}`
    // Between a pair the closer goes on its own line, back at the outer indent
    const closes = after === PAIRS[before]
    return caret(state.start, state.end, closes ? `${inner}\n${indent}` : inner, state.start + inner.length)
  }
  return caret(state.start, state.end, `\n${indent}`, state.start + 1 + indent.length)
}

/** What a key does to the text, or null to let the browser do its own thing */
export const editForKey = (state: TextState, key: string, shift: boolean): TextEdit | null => {
  const { end, start, text } = state
  switch (key) {
    case "Tab":
      if (shift || start !== end) return reindent(state, shift)
      return caret(start, end, INDENT, start + INDENT.length)
    case "Enter":
      return shift ? null : newline(state)
    case "{":
    case "[":
      return openPair(state, key, PAIRS[key] ?? key)
    case "\"":
      return quote(state)
    case "}":
    case "]":
      // Typing the closer that auto-close already put there steps over it
      return start === end && text[start] === key ? caret(start, start, "", start + 1) : null
    case "Backspace": {
      const before = text[start - 1]
      if (start !== end || before === undefined || !(before in PAIRS)) return null
      return text[start] === PAIRS[before] ? caret(start - 1, start + 1, "", start - 1) : null
    }
    default:
      return null
  }
}

/** The text and selection after an edit */
export const applyToState = (state: TextState, edit: TextEdit): TextState => ({
  text: state.text.slice(0, edit.from) + edit.insert + state.text.slice(edit.to),
  start: edit.selectStart,
  end: edit.selectEnd
})
