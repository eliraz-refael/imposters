// The site's brace-face mark (site/public/favicon.svg), inlined because site/ is not
// shipped in the package. test/ui/favicon.test.ts keeps the two identical.
export const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="14" fill="#0a0d0b"/>
  <path d="M20 12c-6 0-7 4-7 9s0 8-6 11c6 3 6 6 6 11s1 9 7 9M44 12c6 0 7 4 7 9s0 8 6 11c-6 3-6 6-6 11s-1 9-7 9" fill="none" stroke="#c6ff4d" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
  <ellipse cx="26" cy="30" rx="4.5" ry="3" fill="#d6e2d8"/>
  <ellipse cx="38" cy="30" rx="4.5" ry="3" fill="#d6e2d8"/>
</svg>
`

// Each UI serves the icon under its own prefix (/_admin/favicon.svg, /_ui/favicon.svg)
// and links it from its layout, so the browser never asks an imposter's port for
// /favicon.ico, which would land in that imposter's request log as traffic
export const faviconResponse = (): Response =>
  new Response(faviconSvg, {
    status: 200,
    headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }
  })
