import { favicon } from "./assets/generated.js"

// The site's brace-face mark (site/public/favicon.svg), compiled into the assets because site/ is
// not shipped in the package. test/ui/favicon.test.ts keeps the two identical. Layouts link the
// hashed asset (assetUrl(prefix, favicon)); this unhashed copy stays at /_admin/favicon.svg and
// /_ui/favicon.svg for anything that still asks for it there.
export const faviconSvg = favicon.body

// Under each UI's prefix, so the browser never asks an imposter's port for /favicon.ico, which
// would land in that imposter's request log as traffic
export const faviconResponse = (): Response =>
  new Response(faviconSvg, {
    status: 200,
    headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }
  })
