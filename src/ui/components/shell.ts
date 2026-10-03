import { favicon, geistFont, martianMonoFont, uiCss, uiJs } from "../assets/generated.js"
import { assetUrl, type UiPrefix } from "../assets/serve.js"
import { html, type SafeHtml } from "../html.js"
import type { Theme } from "../theme.js"

export interface ShellOpts {
  readonly title: string
  // The UI the page belongs to: its assets are served under this prefix
  readonly prefix: UiPrefix
  // From the theme cookie (themeFromCookie); null follows the system setting
  readonly theme: Theme | null
}

/**
 * A redesigned page's document: the self-hosted stylesheet, fonts, script and icon, and the
 * theme rendered on <html> so the first paint is already in it. No CDN.
 */
export const shell = (opts: ShellOpts, body: SafeHtml): SafeHtml =>
  html`<!DOCTYPE html>
<html lang="en"${opts.theme === null ? html`` : html` data-theme="${opts.theme}"`}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="${opts.theme ?? "dark light"}">
  <title>${opts.title}</title>
  <link rel="icon" type="image/svg+xml" href="${assetUrl(opts.prefix, favicon)}">
  <link rel="preload" href="${assetUrl(opts.prefix, martianMonoFont)}" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="${assetUrl(opts.prefix, geistFont)}" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="${assetUrl(opts.prefix, uiCss)}">
  <script defer src="${assetUrl(opts.prefix, uiJs)}"></script>
</head>
<body>
<div class="page">
${body}
</div>
</body>
</html>`
