/**
 * The stub editor (`data-stub-editor` on the stubs page): typing helpers in the JSON textarea,
 * the response-mode control kept in step with the JSON, and a debounced check while typing. A
 * syntax error shows at once (draftText.ts runs here too); valid JSON is posted to
 * `data-preview-url`, which answers with the status box's HTML: "✓ valid stub" with what it
 * would answer, or every problem in plain English.
 *
 * The model is the draft: the parsed JSON of the text, when it parses. The textarea is one view
 * of it. A form view would be another, reading `draft` and writing through `setDraft`, which
 * prints it back as text (draftToText), so both stay one model.
 *
 * A check's answer is shown only while it is for the text as it is now: each edit bumps
 * `version` and marks the status pending, and an answer for an older version is dropped, so a
 * slow answer for old text can never land over a newer one.
 */
import { draftToText, parseDraftText, type SyntaxProblem } from "../src/ui/editor/draftText.js"
import { editForKey, type TextEdit } from "./textEdit"

// Typing pauses this long before the text is checked
export const CHECK_DELAY_MS = 250

const FRAGMENT_HEADERS = { "x-imposters-fragment": "1" }

type StatusState = "pending" | "valid" | "invalid"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseHtml = (text: string): DocumentFragment => {
  const template = document.createElement("template")
  template.innerHTML = text
  return template.content
}

const element = (tag: string, className: string, text: string): HTMLElement => {
  const el = document.createElement(tag)
  el.className = className
  el.textContent = text
  return el
}

// Built from text nodes, so nothing in the problem is ever read as HTML
const syntaxStatus = (problem: SyntaxProblem): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  const head = element("span", "status-head c-error", "✗ not JSON yet")
  head.setAttribute("data-syntax", "")
  const list = element("ul", "status-problems", "")
  list.append(element("li", "", `line ${String(problem.line)}, column ${String(problem.column)}: ${problem.message}`))
  fragment.append(head, list)
  return fragment
}

const unreachable = (): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  fragment.append(element("span", "status-head c-error", "✗ could not reach the server to check it"))
  return fragment
}

// Replaces [from, to) the way typing would, so the browser's undo still works; where that is not
// available, sets the text and announces it as an input
const applyEdit = (area: HTMLTextAreaElement, edit: TextEdit): void => {
  area.focus()
  if (edit.insert !== "" || edit.from !== edit.to) {
    area.setSelectionRange(edit.from, edit.to)
    const typed = typeof document.execCommand === "function" &&
      document.execCommand(edit.insert === "" ? "delete" : "insertText", false, edit.insert)
    if (!typed) {
      area.setRangeText(edit.insert, edit.from, edit.to, "end")
      area.dispatchEvent(new Event("input", { bubbles: true }))
    }
  }
  area.setSelectionRange(edit.selectStart, edit.selectEnd)
}

export const startEditor = (el: HTMLElement): void => {
  const area = el.querySelector<HTMLTextAreaElement>("[data-editor-text]")
  const status = el.querySelector<HTMLElement>("[data-editor-status]")
  const url = el.dataset.previewUrl
  if (area === null || status === null || url === undefined) return
  const modes = el.querySelector<HTMLElement>("[data-editor-mode]")
  const radios = modes === null ? [] : Array.from(modes.querySelectorAll<HTMLInputElement>("input[type=radio]"))
  const editing = el.dataset.editing ?? ""

  // The model: the draft the text holds, undefined while the text is not JSON
  let draft: unknown
  // Bumped by every edit; an answer for an older one is stale
  let version = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let inflight: AbortController | undefined
  // Esc, then Tab, moves the focus on instead of indenting
  let leaving = false

  const show = (state: StatusState, content?: DocumentFragment): void => {
    status.dataset.state = state
    if (content !== undefined) status.replaceChildren(content)
  }

  // The mode control follows the draft: off while the text is not a JSON object
  const syncModes = (): void => {
    const mode = isRecord(draft) ? (draft.responseMode ?? "sequential") : undefined
    for (const radio of radios) {
      radio.disabled = !isRecord(draft)
      radio.checked = radio.value === mode
    }
  }

  const readDraft = (): void => {
    const parsed = parseDraftText(area.value)
    draft = parsed.ok ? parsed.draft : undefined
    syncModes()
  }

  const check = async (asOf: number): Promise<void> => {
    if (!el.isConnected || asOf !== version) return
    const text = area.value
    const parsed = parseDraftText(text)
    if (!parsed.ok) {
      show("invalid", syntaxStatus(parsed.problem))
      return
    }
    inflight?.abort()
    const controller = new AbortController()
    inflight = controller
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: FRAGMENT_HEADERS,
        body: new URLSearchParams({ stub: text, editing }),
        signal: controller.signal
      })
      const html = await response.text()
      // Edited since it was sent: this answer is about text that is gone
      if (asOf !== version) return
      if (!response.ok) {
        show("invalid", unreachable())
        return
      }
      const content = parseHtml(html)
      const valid = content.querySelector("[data-check]")?.getAttribute("data-check") === "valid"
      show(valid ? "valid" : "invalid", content)
    } catch {
      if (asOf === version) show("invalid", unreachable())
    }
  }

  const changed = (): void => {
    version++
    const asOf = version
    readDraft()
    show("pending")
    clearTimeout(timer)
    timer = setTimeout(() => void check(asOf), CHECK_DELAY_MS)
  }

  /** Sets the model, and the text from it */
  const setDraft = (next: unknown): void => {
    applyEdit(area, {
      from: 0,
      to: area.value.length,
      insert: draftToText(next),
      selectStart: 0,
      selectEnd: 0
    })
    // applyEdit announced the change as an input, which re-read the draft and queued a check
  }

  area.addEventListener("input", changed)
  area.addEventListener("keydown", (event) => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === "Escape") {
      leaving = true
      return
    }
    if (event.key === "Tab" && leaving) {
      leaving = false
      return
    }
    leaving = false
    const edit = editForKey(
      { text: area.value, start: area.selectionStart, end: area.selectionEnd },
      event.key,
      event.shiftKey
    )
    if (edit === null) return
    event.preventDefault()
    applyEdit(area, edit)
  })

  for (const radio of radios) {
    radio.addEventListener("change", () => {
      if (radio.checked && isRecord(draft)) setDraft({ ...draft, responseMode: radio.value })
    })
  }

  if (modes !== null) modes.hidden = false
  readDraft()
  // Opened for an edit or a draft: bring the whole panel (its heading too) into view, then type
  if (el.hasAttribute("data-focus")) {
    el.scrollIntoView({ block: "nearest" })
    area.focus({ preventScroll: true })
  }
}
