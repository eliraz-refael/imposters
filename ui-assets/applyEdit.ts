import type { TextEdit } from "./textEdit"

/**
 * Applies a typing helper's edit to a textarea: replaces [from, to) the way typing would, so the
 * browser's undo still works; where that is not available, sets the text and announces it as an
 * input. Either way the textarea gets an input event.
 */
export const applyEdit = (area: HTMLTextAreaElement, edit: TextEdit): void => {
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
