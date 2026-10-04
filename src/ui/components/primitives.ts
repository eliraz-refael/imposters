import { html, raw, type SafeHtml } from "../html.js"

/**
 * The UIs' small building blocks, on the classes in ui-assets/ui.css. Every interpolation goes
 * through `html`, so names and paths from user config are escaped wherever these render.
 */

export type PillTone = "on" | "info" | "warn" | "caution" | "error"

export const pill = (content: SafeHtml | string, tone?: PillTone): SafeHtml =>
  html`<span class="pill${tone === undefined ? "" : ` pill-${tone}`}">${content}</span>`

// HTTP is the default and stays neutral; an extension's protocol stands out
export const protocolPill = (protocol: string): SafeHtml => pill(protocol, protocol === "HTTP" ? undefined : "info")

// ---------------------------------------------------------------- icons

const svgIcon = (size: number, paths: string): SafeHtml =>
  raw(
    `<svg width="${String(size)}" height="${
      String(size)
    }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
  )

export const icons = {
  trash: svgIcon(15, `<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"></path>`),
  sun: svgIcon(
    16,
    `<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path>`
  ),
  moon: svgIcon(16, `<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"></path>`)
}

// ---------------------------------------------------------------- buttons

export type ButtonVariant = "accent" | "danger" | "icon" | "icon-danger"

const variantClass: Record<ButtonVariant, string> = {
  accent: "btn btn-accent",
  danger: "btn btn-danger",
  icon: "btn btn-icon",
  "icon-danger": "btn btn-icon btn-danger"
}

const buttonClass = (variant: ButtonVariant | undefined): string =>
  variant === undefined ? "btn" : variantClass[variant]

export interface LinkButtonOpts {
  readonly href: string
  readonly label: SafeHtml | string
  readonly variant?: ButtonVariant
  readonly ariaLabel?: string
}

export const linkButton = (opts: LinkButtonOpts): SafeHtml =>
  html`<a class="${buttonClass(opts.variant)}" href="${opts.href}"${
    opts.ariaLabel === undefined ? html`` : html` aria-label="${opts.ariaLabel}"`
  }>${opts.label}</a>`

export interface PostButtonOpts {
  // The URL the form posts to
  readonly action: string
  readonly label: SafeHtml | string
  readonly variant?: ButtonVariant
  readonly ariaLabel?: string
  // With JS: the element the answer replaces (data-target), and how (data-swap)
  readonly target?: string
  readonly swap?: "inner" | "outer"
  // Asked before the request is sent (needs JS; without it the form posts straight away)
  readonly confirm?: string
}

/**
 * A button that changes state. It is a one-button form, so it works without JS (a POST, answered
 * with a 303 back to the page); ui.js intercepts the submit through `data-action` and swaps the
 * answer into `target` instead.
 */
export const postButton = (opts: PostButtonOpts): SafeHtml =>
  html`<form class="inline-form" method="post" action="${opts.action}" data-action${
    opts.target === undefined ? html`` : html` data-target="${opts.target}"`
  }${opts.swap === undefined ? html`` : html` data-swap="${opts.swap}"`}${
    opts.confirm === undefined ? html`` : html` data-confirm="${opts.confirm}"`
  }><button class="${buttonClass(opts.variant)}" type="submit"${
    opts.ariaLabel === undefined ? html`` : html` aria-label="${opts.ariaLabel}"`
  }>${opts.label}</button></form>`

// ---------------------------------------------------------------- stat tiles

export type ValueTone = "warn" | "error" | "muted"

export interface StatTileOpts {
  readonly label: string
  readonly value: string
  // Printed smaller after the value: "ms"
  readonly unit?: string
  readonly tone?: ValueTone
  // The line under the value
  readonly note: SafeHtml | string
  // Drawn level with the value, at the right: a sparkline
  readonly aside?: SafeHtml
}

/** One cell of a summary strip: a label, a big number, and a line of context */
export const statTile = (opts: StatTileOpts): SafeHtml => {
  const value = html`<span class="tile-value${opts.tone === undefined ? "" : ` c-${opts.tone}`}">${opts.value}${
    opts.unit === undefined ? html`` : html` <span class="tile-unit">${opts.unit}</span>`
  }</span>`
  return html`<div class="tile">
    <span class="label">${opts.label}</span>
    ${opts.aside === undefined ? value : html`<div class="tile-line">${value}${opts.aside}</div>`}
    <span class="label">${opts.note}</span>
  </div>`
}
