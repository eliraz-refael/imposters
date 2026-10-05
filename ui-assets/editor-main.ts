/**
 * editor.js: the stubs page's own script, loaded after ui.js on that page only (so the other
 * pages never download the editor). It starts every `[data-stub-editor]` on the page, and each
 * one an action swaps in later: ui.js dispatches `ui:init` on whatever it swaps in.
 */
import { startEditor } from "./editor"

const started = new WeakSet<Element>()

const startIn = (scope: Element): void => {
  const found = Array.from(scope.querySelectorAll<HTMLElement>("[data-stub-editor]"))
  if (scope instanceof HTMLElement && scope.matches("[data-stub-editor]")) found.unshift(scope)
  for (const el of found) {
    if (started.has(el)) continue
    started.add(el)
    startEditor(el)
  }
}

document.addEventListener("ui:init", (event) => {
  if (event.target instanceof Element) startIn(event.target)
})

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => startIn(document.documentElement))
} else {
  startIn(document.documentElement)
}
