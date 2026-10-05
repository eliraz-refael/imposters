/**
 * The cross-site guard both web UIs (`/_ui` and every imposter's `/_admin`) put in front of the
 * requests that change state.
 */

// The host the browser reached the UI through, so links to another port work from another
// machine too (the Node server rewrites request.url to localhost)
export const browserHost = (request: Request): string => {
  const header = request.headers.get("host")
  if (header !== null && URL.canParse(`http://${header}`)) return new URL(`http://${header}`).hostname
  return new URL(request.url).hostname
}

// A form post is a "simple" request, so a page on another site could send one to a loopback
// server without a CORS preflight. Browsers mark such a request `Sec-Fetch-Site: cross-site`;
// refuse it. (An imposter's own /_admin, on another port of the same host, is same-site.)
// Browsers send Sec-Fetch-Site only to a trustworthy origin (https or loopback), so a server
// bound to a LAN address over http gets none: there, an Origin whose host is not the one the
// request was sent to (or an opaque "null" one) is refused too. `same-site` gets the same Origin
// check, since it also covers a sibling subdomain (blog.corp.example posting to
// imposters.corp.example). Tools that send neither header are unaffected.
export const isCrossSite = (request: Request): boolean => {
  const site = request.headers.get("sec-fetch-site")
  if (site === "cross-site") return true
  if (site !== null && site !== "same-site") return false
  const origin = request.headers.get("origin")
  if (origin === null) return false
  if (!URL.canParse(origin)) return true
  return new URL(origin).hostname !== browserHost(request)
}

/** The answer to a refused request: a plain 403 that no page can render as its own */
export const crossSiteRefusal = (): Response =>
  new Response("Cross-site form posts are refused.", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
  })
