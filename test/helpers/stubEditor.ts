import * as Schema from "effect/Schema"
import { draftToText, parseDraftText } from "imposters/ui/editor/draftText"
import { stubEditor } from "imposters/ui/pages/stubs"
import { draftStubFrom } from "imposters/ui/stubDraft"
import { afterAll, beforeAll, vi } from "vitest"
import { CHECK_DELAY_MS } from "../../ui-assets/editor"

/**
 * A harness for the stub editor's debounced check: the real ui-assets/ui.ts on the real editor
 * markup (in the calling test's happy-dom), against a fake preview endpoint whose answers stay in
 * flight until a step answers them, in any order. Each answer names the text it was asked about
 * (`data-text`), so the invariant can tell whose answer is on show: whatever the status shows
 * belongs to the text as it is now, or the status is pending. test/ui/runtime-editor.prop.test.ts
 * generates the cases; runtime-editor.test.ts has the examples.
 */

// ---------------------------------------------------------------- the steps

const VALID = draftToText(draftStubFrom("GET", "/orders"))
const OTHER_VALID = draftToText({ responses: [{ status: 503 }], responseMode: "random" })
const INVALID = draftToText({ responses: [{ status: "ok" }] })
const SYNTAX = "{\n  \"responses\": [\n}"

type TextName = "VALID" | "OTHER_VALID" | "INVALID" | "SYNTAX"

export const TEXTS: Readonly<Record<TextName, string>> = { VALID, OTHER_VALID, INVALID, SYNTAX }

export const Step = Schema.Union([
  // The whole text is replaced (a paste, a select-all and type)
  Schema.TaggedStruct("Replace", { text: Schema.Literals(["VALID", "OTHER_VALID", "INVALID", "SYNTAX"]) }),
  // One character is typed at the end
  Schema.TaggedStruct("Type", { char: Schema.Literals([" ", "}", "x", "\n"]) }),
  // The last character is deleted
  Schema.TaggedStruct("Delete", {}),
  // The response-mode control is clicked (it rewrites the text from the draft)
  Schema.TaggedStruct("PickMode", { mode: Schema.Literals(["sequential", "random", "repeat"]) }),
  Schema.TaggedStruct("Advance", { ms: Schema.Literals([50, 100, CHECK_DELAY_MS, 1000]) }),
  // An in-flight check is answered, not necessarily the oldest: `pick` chooses which
  Schema.TaggedStruct("Answer", {
    pick: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 })),
    ok: Schema.Boolean
  })
])
export type Step = typeof Step.Type

export const Case = Schema.Struct({
  start: Schema.Literals(["VALID", "SYNTAX"]),
  steps: Schema.Array(Step).check(Schema.isMaxLength(40))
})
export type Case = typeof Case.Type

// ---------------------------------------------------------------- the fakes

interface InFlight {
  readonly text: string
  readonly answer: (response: Response) => void
}

interface World {
  readonly inFlight: Array<InFlight>
  // Texts whose check was answered with an error
  readonly failed: Set<string>
  // Every check sent, in order
  readonly sent: Array<string>
}

let world: World = { inFlight: [], failed: new Set(), sent: [] }

const escapeAttr = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

let editorMarkup = ""

const fakeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  if (url.endsWith("/page")) return Promise.resolve(new Response(editorMarkup))
  if (url.endsWith("/_admin/stubs/preview")) {
    const body = init?.body
    const text = body instanceof URLSearchParams ? body.get("stub") ?? "" : ""
    world.sent.push(text)
    return new Promise((resolve) => world.inFlight.push({ text, answer: resolve }))
  }
  return Promise.resolve(new Response("not found", { status: 404 }))
}

const answerFor = (text: string): Response => {
  const valid = parseDraftText(text).ok && !text.includes("\"ok\"")
  return new Response(
    `<span class="status-head" data-check="${valid ? "valid" : "invalid"}" data-text="${
      escapeAttr(text)
    }">checked</span>`
  )
}

// ---------------------------------------------------------------- driving the page

// Lets every promise, timer of zero delay and body read settle
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(0)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

export const element = <E extends Element = HTMLElement>(selector: string): E => {
  const el = document.querySelector<E>(selector)
  if (el === null) throw new Error(`no ${selector}`)
  return el
}

export const area = (): HTMLTextAreaElement => element<HTMLTextAreaElement>("[data-editor-text]")
export const status = (): HTMLElement => element("[data-editor-status]")
export const inFlight = (): ReadonlyArray<InFlight> => world.inFlight
export const sent = (): ReadonlyArray<string> => world.sent

export const setText = (text: string): void => {
  const el = area()
  el.value = text
  el.dispatchEvent(new Event("input", { bubbles: true }))
}

/** Answers the in-flight check at `index` (oldest first) */
export const answer = (index: number, ok = true): void => {
  const [request] = world.inFlight.splice(index, 1)
  if (request === undefined) return
  if (!ok) world.failed.add(request.text)
  request.answer(ok ? answerFor(request.text) : new Response("down", { status: 503 }))
}

/** Swaps in a fresh editor holding `text`, as an action's answer would, so ui.js starts it */
export const mount = async (text: string): Promise<void> => {
  world = { inFlight: [], failed: new Set(), sent: [] }
  vi.clearAllTimers()
  editorMarkup = stubEditor({ text, insert: "last" }).value
  document.body.innerHTML = `<div id="host"></div><button id="load" data-action="GET /page" data-target="#host">`
  element("#load").click()
  await flush()
}

/**
 * Who the status is showing: "pending", or "current" when what it shows is for the text as it is
 * now; anything else is a description of the stale content
 */
export const shown = (): string => {
  const el = status()
  if (el.dataset.state === "pending") return "pending"
  const text = area().value
  const syntax = el.querySelector("[data-syntax]")
  if (syntax !== null) {
    const parsed = parseDraftText(text)
    const line = el.querySelector("li")?.textContent ?? ""
    return !parsed.ok &&
        line === `line ${parsed.problem.line}, column ${parsed.problem.column}: ${parsed.problem.message}`
      ? "current"
      : `a syntax error for other text: ${line}`
  }
  const answered = el.querySelector("[data-text]")
  if (answered !== null) {
    const forText = answered.getAttribute("data-text") ?? ""
    return forText === text ? "current" : `an answer for other text: ${JSON.stringify(forText)}`
  }
  if ((el.textContent ?? "").includes("could not reach")) {
    return world.failed.has(text) ? "current" : "a failure for other text"
  }
  // Nothing checked yet: the server-rendered status (none here) for the text it was rendered with
  return el.children.length === 0 ? "current" : `unknown content: ${el.innerHTML}`
}

const apply = async (step: Step): Promise<void> => {
  switch (step._tag) {
    case "Replace":
      setText(TEXTS[step.text])
      break
    case "Type":
      setText(area().value + step.char)
      break
    case "Delete":
      setText(area().value.slice(0, -1))
      break
    case "PickMode": {
      const radio = document.querySelector<HTMLInputElement>(`[data-editor-mode] input[value="${step.mode}"]`)
      if (radio !== null && !radio.disabled && !radio.checked) radio.click()
      break
    }
    case "Advance":
      await vi.advanceTimersByTimeAsync(step.ms)
      break
    case "Answer":
      if (world.inFlight.length > 0) answer(step.pick % world.inFlight.length, step.ok)
      break
  }
  await flush()
}

const fail = (message: string, at: number, steps: ReadonlyArray<Step>): never => {
  throw new Error(`${message} after step ${String(at)} of ${JSON.stringify(steps.slice(0, at + 1))}`)
}

export const runCase = async ({ start, steps }: Case): Promise<void> => {
  await mount(TEXTS[start])
  for (const [at, step] of steps.entries()) {
    await apply(step)
    const who = shown()
    if (who !== "pending" && who !== "current") fail(`the status shows ${who}`, at, steps)
  }
  // Typing stops and every check is answered: the status settles on the text as it is
  for (let round = 0; round < 3; round++) {
    await apply({ _tag: "Advance", ms: 1000 })
    while (world.inFlight.length > 0) await apply({ _tag: "Answer", pick: 0, ok: true })
  }
  const who = shown()
  if (who !== "current") fail(`did not settle: the status shows ${who}`, steps.length, steps)
}

// Registers the fakes and loads ui.ts once for the calling test file; each case mounts a fresh editor
export const useEditorHarness = (): void => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
    vi.stubGlobal("fetch", fakeFetch)
    await import("../../ui-assets/ui")
  })
  afterAll(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
}
