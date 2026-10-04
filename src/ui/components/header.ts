/**
 * The page header's pieces: the mark, the wordmark, the theme toggle and the live label.
 */
import { html, raw, type SafeHtml } from "../html.js"
import { icons } from "./primitives.js"

// The brace-face mark (site/public/favicon.svg) without its tile, coloured by the theme's tokens
const markSvg = raw(
  `<svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><path class="brace" d="M20 12c-6 0-7 4-7 9s0 8-6 11c6 3 6 6 6 11s1 9 7 9M44 12c6 0 7 4 7 9s0 8 6 11c-6 3-6 6-6 11s-1 9-7 9" fill="none" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"></path><ellipse class="eyes" cx="26" cy="30" rx="4.5" ry="3"></ellipse><ellipse class="eyes" cx="38" cy="30" rx="4.5" ry="3"></ellipse></svg>`
)

/** The mark, as a link home when given an `href` */
export const mark = (href?: string, label = "All imposters"): SafeHtml =>
  href === undefined ? markSvg : html`<a class="mark-link" href="${href}" aria-label="${label}">${markSvg}</a>`

/** "imposters", set like the site's wordmark */
export const brand: SafeHtml = html`<span class="brand">imposters</span>`

/**
 * Switches between dark and light (ui.js, `data-theme-toggle`). It shows the icon of the theme it
 * switches to; ui.js keeps the label in step once it knows the system theme.
 */
export const themeToggle: SafeHtml =
  html`<button class="btn btn-icon" type="button" data-theme-toggle aria-label="Switch theme"><span class="theme-to-light">${icons.sun}</span><span class="theme-to-dark">${icons.moon}</span></button>`

/** A pulsing dot and a word: the page refreshes itself */
export const liveLabel = (text = "live"): SafeHtml =>
  html`<span class="label live-label"><span class="live"></span>${text}</span>`

export interface TopBarOpts {
  // Mark, wordmark or breadcrumb, pills
  readonly start: SafeHtml
  // Links, actions, the theme toggle
  readonly end: SafeHtml
  readonly navLabel: string
}

/** The page header: a full-width bar with a centred row */
export const topBar = (opts: TopBarOpts): SafeHtml =>
  html`<header class="top">
  <div class="top-in">
    <div class="cluster">${opts.start}</div>
    <nav class="cluster cluster-tight" aria-label="${opts.navLabel}">${opts.end}</nav>
  </div>
</header>`
