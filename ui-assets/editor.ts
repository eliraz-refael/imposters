/**
 * The stub editor (`data-stub-editor` on the stubs page): a form view and a JSON view of one
 * draft, and a debounced check while editing. A syntax error shows at once (draftText.ts runs
 * here too); valid JSON is posted to `data-preview-url`, which answers with the status box's
 * HTML: "✓ valid stub" with what it would answer, or every problem in plain English.
 *
 * The model is the draft, and the JSON textarea always holds it: it is what the form posts,
 * with JS or without. The form (form.ts) is the other view: it is read from the draft when it
 * opens, and every edit in it writes the draft back as text (draftToText). An edit the draft
 * cannot hold yet (a body that is not JSON, a header with no name) leaves the draft as it was:
 * the form lists the problem in the status box, marks the control, keeps "add stub" off and the
 * JSON tab closed until it is fixed. The JSON tab opens the form again only for JSON the form
 * can show; otherwise the note under the tabs says why.
 *
 * A check's answer is shown only while it is for the text as it is now: each edit bumps
 * `version` and marks the status pending, and an answer for an older version is dropped, so a
 * slow answer for old text can never land over a newer one.
 */
import { type DraftPath, draftToText, parseDraftText, type SyntaxProblem } from "../src/ui/editor/draftText.js"
import { type FormProblem, type FormState, readForm, writeForm } from "../src/ui/editor/formModel.js"
import { applyEdit } from "./applyEdit"
import { type FormView, startForm } from "./form"
import { editForKey } from "./textEdit"

// Typing pauses this long before the text is checked
export const CHECK_DELAY_MS = 250

const FRAGMENT_HEADERS = { "x-imposters-fragment": "1" }

type StatusState = "pending" | "valid" | "invalid"
type View = "form" | "json"

// A call, so TypeScript does not narrow `view` below to its first value: handlers change it
const firstView = (): View => "json"

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

// The form's own problems, each a link to the control it is about
const formStatus = (problems: ReadonlyArray<FormProblem>): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  const count = problems.length === 1 ? "1 thing to fix" : `${String(problems.length)} things to fix`
  const list = element("ul", "status-problems", "")
  for (const problem of problems) {
    const item = element("li", "", "")
    const link = element("a", "", problem.label)
    link.setAttribute("href", "#editor-form")
    link.setAttribute("data-goto-key", problem.key)
    item.append(link, `: ${problem.message}`)
    list.append(item)
  }
  fragment.append(element("span", "status-head c-error", `✗ ${count}`), list)
  return fragment
}

const isPath = (value: unknown): value is DraftPath =>
  Array.isArray(value) && value.every((segment) => typeof segment === "string" || typeof segment === "number")

const pathIn = (text: string | null): DraftPath | undefined => {
  if (text === null) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return isPath(value) ? value : undefined
  } catch {
    return undefined
  }
}

// Where line `line` (from 1) starts in the text
const lineOffset = (text: string, line: number): number => {
  let offset = 0
  for (let n = 1; n < line; n++) {
    const next = text.indexOf("\n", offset)
    if (next === -1) return text.length
    offset = next + 1
  }
  return offset
}

export const startEditor = (el: HTMLElement): void => {
  const area = el.querySelector<HTMLTextAreaElement>("[data-editor-text]")
  const status = el.querySelector<HTMLElement>("[data-editor-status]")
  const url = el.dataset.previewUrl
  if (area === null || status === null || url === undefined) return
  const editing = el.dataset.editing ?? ""
  const tabs = el.querySelector<HTMLElement>("[data-editor-tabs]")
  const tabButtons = tabs === null ? [] : Array.from(tabs.querySelectorAll<HTMLButtonElement>("[data-tab]"))
  const note = el.querySelector<HTMLElement>("[data-editor-note]")
  const jsonView = el.querySelector<HTMLElement>("[data-json-view]")
  const formRoot = el.querySelector<HTMLElement>("[data-form-view]")
  const submit = el.querySelector<HTMLButtonElement>("button[type=submit]")

  // Bumped by every edit; an answer for an older one is stale
  let version = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let inflight: AbortController | undefined
  // Esc, then Tab, moves the focus on instead of indenting
  let leaving = false
  let view: View = firstView()
  // What the form holds that the draft cannot, yet
  let formProblems: ReadonlyArray<FormProblem> = []

  const show = (state: StatusState, content?: DocumentFragment): void => {
    status.dataset.state = state
    if (content !== undefined) status.replaceChildren(content)
  }

  // The schema paths the status's problems are about, for the form to mark
  const markChecked = (): void => {
    const paths = Array.from(status.querySelectorAll("[data-problem-path]"))
      .map((item) => pathIn(item.getAttribute("data-problem-path")))
      .filter(isPath)
    form?.markPaths(paths)
  }

  // Why the other view will not open, if it will not: under the tabs, and read with the tab
  const syncTabs = (): void => {
    let reason = ""
    if (view === "json") {
      const parsed = parseDraftText(area.value)
      const read = parsed.ok ? readForm(parsed.draft) : undefined
      if (!parsed.ok) reason = "the form opens once the JSON is valid"
      else if (read !== undefined && !read.ok) {
        reason = `the form can't show this stub, so edit it here: ${read.reasons.join("; ")}`
      }
    } else if (formProblems.length > 0) {
      reason = "the JSON opens once the problems below are fixed: it can't hold them yet"
    }
    for (const button of tabButtons) {
      if (reason !== "" && button.dataset.tab !== view) button.setAttribute("aria-disabled", "true")
      else button.removeAttribute("aria-disabled")
    }
    if (note !== null) {
      note.textContent = reason
      note.hidden = reason === ""
    }
    if (submit !== null) submit.disabled = view === "form" && formProblems.length > 0
  }

  const check = async (asOf: number): Promise<void> => {
    if (!el.isConnected || asOf !== version) return
    syncTabs()
    const text = area.value
    const parsed = parseDraftText(text)
    if (!parsed.ok) {
      show("invalid", syntaxStatus(parsed.problem))
      form?.markPaths([])
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
      markChecked()
    } catch {
      if (asOf === version) show("invalid", unreachable())
    }
  }

  // The text changed (typed, or written by the form): check it once typing pauses
  const changed = (): void => {
    version++
    const asOf = version
    show("pending")
    clearTimeout(timer)
    timer = setTimeout(() => void check(asOf), CHECK_DELAY_MS)
  }

  // Every form edit: the draft it makes goes into the text, or its problems into the status
  const formEdited = (state: FormState): void => {
    const written = writeForm(state)
    formProblems = written.ok ? [] : written.problems
    form?.showProblems(formProblems)
    // The check's marks are for the form as it was: the next answer marks it again
    form?.markPaths([])
    if (written.ok) {
      area.value = draftToText(written.draft)
      changed()
    } else {
      // No check is wanted for a draft the form is not showing, and none in flight is shown
      version++
      clearTimeout(timer)
      inflight?.abort()
      show("invalid", formStatus(formProblems))
    }
    syncTabs()
  }

  const form: FormView | undefined = formRoot === null ? undefined : startForm(formRoot, formEdited)

  const setView = (next: View): void => {
    view = next
    el.dataset.view = next
    if (jsonView !== null) jsonView.hidden = next !== "json"
    form?.setActive(next === "form")
    for (const button of tabButtons) {
      const selected = button.dataset.tab === next
      button.setAttribute("aria-selected", String(selected))
      button.tabIndex = selected ? 0 : -1
    }
    syncTabs()
  }

  // The form, read from the draft; false (and the JSON view stays) when the draft is not one it can show
  const openForm = (): boolean => {
    if (form === undefined) return false
    const parsed = parseDraftText(area.value)
    const read = parsed.ok ? readForm(parsed.draft) : undefined
    if (read === undefined || !read.ok) return false
    formProblems = []
    form.showProblems([])
    form.show(read.form)
    setView("form")
    markChecked()
    return true
  }

  const openJson = (): boolean => {
    if (formProblems.length > 0) return false
    setView("json")
    return true
  }

  const pick = (tab: string | undefined): void => {
    const opened = tab === "form" ? view === "form" || openForm() : view === "json" || openJson()
    if (!opened) syncTabs()
  }

  area.addEventListener("input", () => {
    changed()
    // Changed while the form is showing (by a script, not by typing: the textarea is hidden),
    // so the form shows the new draft, or gives way to the JSON view
    if (view === "form" && !openForm()) setView("json")
  })
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

  for (const button of tabButtons) {
    button.addEventListener("click", () => pick(button.dataset.tab))
    // Left and right move between the tabs, opening the one they land on
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return
      event.preventDefault()
      const other = tabButtons.find((b) => b !== button)
      if (other === undefined) return
      other.focus()
      pick(other.dataset.tab)
    })
  }

  // A problem's link: "line 8" puts the caret on that line, "response 1 · status" focuses it
  status.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a") : null
    if (link === null) return
    const line = Number(link.getAttribute("data-line") ?? Number.NaN)
    const path = pathIn(link.getAttribute("data-goto"))
    const key = link.getAttribute("data-goto-key")
    if (Number.isInteger(line) && line > 0) {
      event.preventDefault()
      const offset = lineOffset(area.value, line)
      area.focus()
      area.setSelectionRange(offset, offset)
    } else if (path !== undefined) {
      event.preventDefault()
      form?.focusPath(path)
    } else if (key !== null) {
      event.preventDefault()
      form?.focusKey(key)
    }
  })

  if (formRoot !== null && jsonView !== null && tabs !== null) {
    tabs.hidden = false
    formRoot.setAttribute("role", "tabpanel")
    formRoot.setAttribute("aria-labelledby", "editor-tab-form")
    jsonView.setAttribute("role", "tabpanel")
    jsonView.setAttribute("aria-labelledby", "editor-tab-json")
    if (!openForm()) setView("json")
  }
  // Opened for an edit or a draft: bring the whole panel (its heading too) into view, then edit
  if (el.hasAttribute("data-focus")) {
    el.scrollIntoView({ block: "nearest" })
    if (view === "form") form?.focusFirst()
    else area.focus({ preventScroll: true })
  }
}
