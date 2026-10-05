/**
 * The web UIs' browser runtime (`/_ui` and every imposter's `/_admin`). scripts/gen-ui-assets.ts
 * minifies it to an IIFE; pages load it with `<script defer>`. Everything is driven by data
 * attributes, so pages stay plain server-rendered HTML and work without it:
 *
 * - `data-action="METHOD url"` on a button or link, or on a form (method and url default to the
 *   form's). The request carries `x-imposters-fragment: 1`, so the server answers with HTML for
 *   `data-target` (a selector, `this`, or `closest <selector>`), swapped per `data-swap`
 *   (`inner`, the default, `outer` or `none`). With no target the page follows a redirect or
 *   reloads. `data-confirm` asks first. Any element in an answer with `data-oob` and an id
 *   replaces the page's element with that id. A failed answer's HTML goes into the action's own
 *   `[data-error-slot]` (one inside its form), else the page's first; a new action clears them all.
 * - `data-poll="ms"` with `data-url`: re-fetch into the element while the tab is visible.
 *   `data-poll-throttle="ms"` also refreshes on each SSE arrival, at most that often; an arrival
 *   during a refresh gets one more once it completes, since that answer may predate it.
 * - `data-sse="url"`: prepend each event's HTML (`data-sse-event`, default `message`), newest
 *   first, highlighted with `.fresh`; keep `data-sse-max` rows (default 100). A button with
 *   `data-sse-pause="<selector>"` pauses it; events are buffered (and counted in its
 *   `[data-sse-count]`) and flushed on resume. On reconnect, and on a page restored from the
 *   back-forward cache, the rows are re-fetched from `data-sse-reload`. The stream is closed on
 *   `pagehide`, and for good once a swap takes the element off the page, since browsers allow
 *   about six connections per host.
 * - `data-copy="text"` or `data-copy-from="<selector>"`: copy to the clipboard.
 * - `data-theme-toggle`: switch between dark and light, remembered in the `imposters-theme`
 *   cookie. Cookies ignore the port, so the choice holds for the admin UI and every imposter;
 *   it is scoped to /_ui and /_admin, so it is never sent with stub traffic.
 */

type Theme = "dark" | "light"

const THEME_COOKIE = "imposters-theme"
const COOKIE_PATHS = ["/_ui", "/_admin"]
const ONE_YEAR_S = 31536000
const FRAGMENT_HEADERS = { "x-imposters-fragment": "1" }

const root = document.documentElement
const started = new WeakSet<Element>()
// One per running data-sse element: closes its stream once a swap has taken the element off the page
const reapers = new Set<() => void>()
const reap = (): void => reapers.forEach((reaper) => reaper())

// ---------------------------------------------------------------- theme

const lightQuery = matchMedia("(prefers-color-scheme: light)")

const currentTheme = (): Theme => {
  const theme = root.dataset.theme
  if (theme === "light" || theme === "dark") return theme
  return lightQuery.matches ? "light" : "dark"
}

const syncThemeToggles = (): void => {
  const next = currentTheme() === "dark" ? "light" : "dark"
  for (const toggle of document.querySelectorAll("[data-theme-toggle]")) {
    toggle.setAttribute("aria-label", `Switch to ${next} theme`)
  }
}

const setTheme = (theme: Theme): void => {
  root.dataset.theme = theme
  // One cookie per UI prefix; each write on its own, since a blocked cookie must not stop the other
  for (const path of COOKIE_PATHS) {
    try {
      document.cookie = `${THEME_COOKIE}=${theme}; Path=${path}; Max-Age=${ONE_YEAR_S}; SameSite=Lax`
    } catch {
      // Cookies are blocked: the theme still applies to this page
    }
  }
  syncThemeToggles()
}

// ---------------------------------------------------------------- swapping

const parse = (text: string): DocumentFragment => {
  const template = document.createElement("template")
  template.innerHTML = text
  return template.content
}

const resolveTarget = (el: Element, spec: string | undefined): Element | null => {
  if (spec === undefined || spec === "") return null
  if (spec === "this") return el
  if (spec.startsWith("closest ")) return el.closest(spec.slice("closest ".length))
  return document.querySelector(spec)
}

const swap = (target: Element | null, text: string, mode: string): void => {
  const fragment = parse(text)
  for (const oob of Array.from(fragment.querySelectorAll("[data-oob][id]"))) {
    oob.remove()
    const current = document.getElementById(oob.id)
    if (current !== null) {
      current.replaceWith(oob)
      init(oob)
    }
  }
  if (target !== null && mode !== "none") {
    if (mode === "outer") {
      const added = Array.from(fragment.children)
      target.replaceWith(fragment)
      added.forEach(init)
    } else {
      target.replaceChildren(fragment)
      init(target)
    }
  }
  // A swap is how a live list leaves the page: close its stream now, not on some later event
  reap()
}

const ERROR_SLOT = "[data-error-slot]"

// The action's own slot (one inside its form), else the page's first
const errorSlot = (el: Element): Element | null => el.querySelector(ERROR_SLOT) ?? document.querySelector(ERROR_SLOT)

const clearErrors = (): void => document.querySelectorAll(ERROR_SLOT).forEach((slot) => slot.replaceChildren())

const showError = (el: Element, text: string): void => {
  const slot = errorSlot(el)
  if (slot !== null) slot.replaceChildren(parse(text))
  else alert(parse(text).textContent?.trim() || "The request failed.")
}

// ---------------------------------------------------------------- actions

interface ActionSpec {
  readonly method: string
  readonly url: string
}

const actionSpec = (el: Element, form: HTMLFormElement | null): ActionSpec => {
  const [method, url] = (el.getAttribute("data-action") ?? "").trim().split(/\s+/)
  // getAttribute, not form.action / form.method: a field named "action" or "method" shadows those
  const fallbackUrl = form !== null
    ? form.getAttribute("action") ?? location.href
    : el instanceof HTMLAnchorElement
    ? el.href
    : location.href
  const fallbackMethod = form?.getAttribute("method") ?? "GET"
  return {
    method: (method !== undefined && method !== "" ? method : fallbackMethod).toUpperCase(),
    url: url !== undefined && url !== "" ? url : fallbackUrl
  }
}

const formBody = (form: HTMLFormElement, submitter: HTMLElement | null): URLSearchParams => {
  const body = new URLSearchParams()
  for (const [name, value] of new FormData(form, submitter)) {
    if (typeof value === "string") body.append(name, value)
  }
  return body
}

const runAction = async (el: HTMLElement, form: HTMLFormElement | null, submitter: HTMLElement | null) => {
  if (el.getAttribute("aria-busy") === "true") return
  const confirmText = el.dataset.confirm
  if (confirmText !== undefined && !confirm(confirmText)) return

  const { method, url } = actionSpec(el, form)
  const body = form !== null ? formBody(form, submitter) : null
  const target = resolveTarget(el, el.dataset.target)
  const requestUrl = new URL(url, location.href)
  if (body !== null && (method === "GET" || method === "HEAD")) {
    body.forEach((value, name) => requestUrl.searchParams.append(name, value))
  }

  clearErrors()
  el.setAttribute("aria-busy", "true")
  try {
    const response = await fetch(requestUrl, {
      method,
      headers: FRAGMENT_HEADERS,
      ...(body !== null && method !== "GET" && method !== "HEAD" ? { body } : {})
    })
    const text = await response.text()
    if (!response.ok) {
      showError(el, text)
      return
    }
    if (target === null && el.dataset.swap !== "none") {
      if (response.redirected) location.assign(response.url)
      else location.reload()
      return
    }
    swap(target, text, el.dataset.swap ?? "inner")
    if (form !== null && el.dataset.reset !== undefined) form.reset()
  } catch {
    showError(el, "Could not reach the server.")
  } finally {
    el.removeAttribute("aria-busy")
  }
}

// ---------------------------------------------------------------- clipboard

const copyText = async (text: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // No Clipboard API outside a secure context (a remote host over plain http)
    const area = document.createElement("textarea")
    area.value = text
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.opacity = "0"
    document.body.append(area)
    area.select()
    document.execCommand("copy")
    area.remove()
  }
}

const copyFrom = async (el: HTMLElement): Promise<void> => {
  const source = el.dataset.copyFrom !== undefined ? document.querySelector(el.dataset.copyFrom) : null
  const text = source instanceof HTMLInputElement || source instanceof HTMLTextAreaElement
    ? source.value
    : source !== null
    ? source.textContent ?? ""
    : el.dataset.copy ?? ""
  await copyText(text)
  el.setAttribute("data-copied", "")
  setTimeout(() => el.removeAttribute("data-copied"), 1500)
}

// ---------------------------------------------------------------- polling

const fetchInto = async (el: Element, url: string, mode: string): Promise<void> => {
  try {
    const response = await fetch(url, { headers: FRAGMENT_HEADERS, cache: "no-store" })
    if (response.ok) swap(el, await response.text(), mode)
  } catch {
    // Offline or restarting: the next tick tries again
  }
}

const startPoll = (el: HTMLElement): void => {
  const every = Number(el.dataset.poll)
  const throttle = Number(el.dataset.pollThrottle)
  const url = el.dataset.url
  if (url === undefined || !(every > 0)) return

  const stop = new AbortController()
  let last = Date.now()
  let inflight = false
  // An arrival came in during a refresh, whose answer may predate it: refresh once more after
  let dirty = false
  let pending: ReturnType<typeof setTimeout> | undefined

  const refresh = async (): Promise<void> => {
    if (!el.isConnected) {
      stop.abort()
      return
    }
    if (inflight) return
    inflight = true
    last = Date.now()
    await fetchInto(el, url, el.dataset.swap ?? "inner")
    inflight = false
    if (dirty) {
      dirty = false
      schedule()
    }
  }

  // The next throttled refresh: at most one per `throttle` ms, however many arrivals ask
  const schedule = (): void => {
    if (inflight) {
      dirty = true
      return
    }
    if (pending !== undefined) return
    const wait = Math.max(0, throttle - (Date.now() - last))
    pending = setTimeout(() => {
      pending = undefined
      if (inflight) dirty = true
      else void refresh()
    }, wait)
  }

  const timer = setInterval(() => {
    if (document.visibilityState === "visible" && Date.now() - last >= every) void refresh()
  }, every)
  stop.signal.addEventListener("abort", () => {
    clearInterval(timer)
    clearTimeout(pending)
  })

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - last >= every) void refresh()
  }, { signal: stop.signal })

  if (throttle > 0) document.addEventListener("ui:arrival", schedule, { signal: stop.signal })
}

// ---------------------------------------------------------------- server-sent events

const pauseButtonsFor = (el: Element): Array<HTMLElement> =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-sse-pause]")).filter((button) =>
    resolveTarget(button, button.dataset.ssePause) === el
  )

const startSse = (el: HTMLElement): void => {
  const url = el.dataset.sse
  if (url === undefined || url === "") return
  const max = Number(el.dataset.sseMax) > 0 ? Number(el.dataset.sseMax) : 100
  const eventName = el.dataset.sseEvent ?? "message"

  let source: EventSource | null = null
  let reloadOnOpen = false
  let paused = false
  let dropped = false
  const buffer: Array<string> = []

  const reload = (): void => {
    const reloadUrl = el.dataset.sseReload
    if (reloadUrl !== undefined) void fetchInto(el, reloadUrl, "inner")
  }

  const insert = (text: string): void => {
    const fragment = parse(text)
    const added = Array.from(fragment.children)
    el.prepend(fragment)
    for (const row of added) {
      row.classList.add("fresh")
      row.addEventListener("animationend", () => row.classList.remove("fresh"), { once: true })
      init(row)
    }
    while (el.children.length > max) el.lastElementChild?.remove()
  }

  const renderPause = (): void => {
    const scope = el.closest(".panel") ?? el
    scope.classList.toggle("is-paused", paused)
    for (const button of pauseButtonsFor(el)) {
      button.setAttribute("aria-pressed", String(paused))
      for (const count of button.querySelectorAll("[data-sse-count]")) count.textContent = String(buffer.length)
    }
  }

  const onEvent = (event: MessageEvent): void => {
    // Swapped out of the page: a live EventSource would hold one of the host's ~six connections
    if (!el.isConnected) {
      detach()
      return
    }
    if (typeof event.data !== "string") return
    if (paused) {
      buffer.push(event.data)
      if (buffer.length > max) {
        buffer.shift()
        dropped = true
      }
      renderPause()
    } else {
      insert(event.data)
    }
    document.dispatchEvent(new CustomEvent("ui:arrival"))
  }

  const open = (): void => {
    if (source !== null) return
    source = new EventSource(url)
    source.addEventListener(eventName, onEvent)
    source.addEventListener("open", () => {
      if (reloadOnOpen && !paused) reload()
      reloadOnOpen = false
    })
    // EventSource reconnects by itself; rows sent meanwhile are lost, so re-fetch on the next open
    source.addEventListener("error", () => {
      reloadOnOpen = true
    })
  }

  const close = (): void => {
    source?.close()
    source = null
  }

  el.addEventListener("ui:pause-toggle", () => {
    paused = !paused
    if (!paused) {
      if (dropped) reload()
      else buffer.forEach(insert)
      buffer.length = 0
      dropped = false
    }
    renderPause()
  })

  const lifetime = new AbortController()
  const detach = (): void => {
    close()
    lifetime.abort()
    reapers.delete(reaper)
  }
  const reaper = (): void => {
    if (!el.isConnected) detach()
  }
  reapers.add(reaper)

  addEventListener("pagehide", close, { signal: lifetime.signal })
  addEventListener("pageshow", (event) => {
    if (!el.isConnected) {
      detach()
      return
    }
    if (event.persisted) {
      reloadOnOpen = true
      open()
    }
  }, { signal: lifetime.signal })
  open()
}

// ---------------------------------------------------------------- wiring

const init = (scope: Element): void => {
  const each = (selector: string, start: (el: HTMLElement) => void): void => {
    const found = Array.from(scope.querySelectorAll<HTMLElement>(selector))
    if (scope instanceof HTMLElement && scope.matches(selector)) found.unshift(scope)
    for (const el of found) {
      if (started.has(el)) continue
      started.add(el)
      start(el)
    }
  }
  each("[data-poll]", startPoll)
  each("[data-sse]", startSse)
}

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return
  const el = event.target.closest<HTMLElement>(
    "[data-action], [data-copy], [data-copy-from], [data-theme-toggle], [data-sse-pause]"
  )
  if (el === null || el instanceof HTMLFormElement) return
  // Let the browser open a link in a new tab or window
  if (el instanceof HTMLAnchorElement && (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)) {
    return
  }

  if (el.hasAttribute("data-theme-toggle")) {
    setTheme(currentTheme() === "dark" ? "light" : "dark")
  } else if (el.hasAttribute("data-sse-pause")) {
    resolveTarget(el, el.dataset.ssePause)?.dispatchEvent(new CustomEvent("ui:pause-toggle"))
  } else if (el.hasAttribute("data-copy") || el.hasAttribute("data-copy-from")) {
    void copyFrom(el)
  } else {
    void runAction(el, null, null)
  }
  event.preventDefault()
})

document.addEventListener("submit", (event) => {
  const form = event.target
  if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-action")) return
  event.preventDefault()
  const submitter = event.submitter instanceof HTMLElement ? event.submitter : null
  void runAction(form, form, submitter)
})

lightQuery.addEventListener("change", syncThemeToggles)

const boot = (): void => {
  syncThemeToggles()
  init(document.documentElement)
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot)
else boot()
