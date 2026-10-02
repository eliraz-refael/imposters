import { html, raw, type SafeHtml } from "./html.js"

// htmx swaps only 2xx answers by default, so an error partial sent with a 4xx would be
// dropped and the action would look like a silent no-op. This config swaps 4xx/5xx too
// and marks them failed, so `event.detail.successful` is false (a form is not reset).
export const htmxConfigMeta: SafeHtml = raw(
  `<meta name="htmx-config" content='{"responseHandling":[{"code":"204","swap":false},{"code":"[23]..","swap":true},{"code":"[45]..","swap":true,"error":true}]}'>`
)

// Every layout has this (empty) element; error answers are retargeted into it
export const uiErrorId = "ui-error"

export const uiErrorSlot: SafeHtml = raw(`<div id="${uiErrorId}"></div>`)

// Put on <body>: a new request clears the previous error
export const clearErrorOnRequest: SafeHtml = raw(
  `hx-on::before-request="var e = document.getElementById('${uiErrorId}'); if (e) e.replaceChildren()"`
)

export const errorBox = (message: string): SafeHtml =>
  html`<div class="bg-red-50 border border-red-200 text-red-700 rounded p-3 mb-3">${message}</div>`

const htmlHeaders = { "content-type": "text/html; charset=utf-8" }

export const htmlResponse = (body: SafeHtml, status = 200): Response =>
  new Response(body.value, { status, headers: htmlHeaders })

// An error for an htmx action: the real status, and the message swapped into the
// layout's error slot instead of the action's own target (a list or a row). `extra`
// is appended after the message, for out-of-band swaps that refresh other parts.
export const errorResponse = (message: string, status: number, extra: SafeHtml = html``): Response =>
  new Response(html`${errorBox(message)}${extra}`.value, {
    status,
    headers: { ...htmlHeaders, "HX-Retarget": `#${uiErrorId}`, "HX-Reswap": "innerHTML" }
  })

// A form field as a string; a file upload or an absent field is undefined
export const formString = (form: FormData, name: string): string | undefined => {
  const value = form.get(name)
  return typeof value === "string" ? value : undefined
}
