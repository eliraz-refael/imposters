import { assets, type UiAsset } from "./generated.js"

// The UI prefixes that mount the assets: the admin UI and every imposter's own UI
export type UiPrefix = "/_ui" | "/_admin"

// A name carries its content hash, so a changed asset is a new URL and a cached one never goes stale
const IMMUTABLE = "public, max-age=31536000, immutable"

const byName: ReadonlyMap<string, UiAsset> = new Map(assets.map((asset) => [asset.name, asset]))

const decodeBase64 = (body: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// Fonts are decoded on first request, then kept
const decoded = new Map<string, Uint8Array<ArrayBuffer>>()

const bodyOf = (asset: UiAsset): string | Uint8Array<ArrayBuffer> => {
  if (asset.encoding === "utf8") return asset.body
  const cached = decoded.get(asset.name) ?? decodeBase64(asset.body)
  decoded.set(asset.name, cached)
  // A copy per response, so no consumer of one body can affect the next
  return cached.slice()
}

const etagOf = (asset: UiAsset): string => `"${asset.hash}"`

// If-None-Match is a list of entity tags (weak ones prefixed W/), or *
const matchesEtag = (ifNoneMatch: string | null, etag: string): boolean =>
  ifNoneMatch !== null &&
  ifNoneMatch.split(",").some((candidate) => {
    const tag = candidate.trim()
    return tag === "*" || tag === etag || tag === `W/${etag}`
  })

/**
 * Answers a GET for `<prefix>/assets/<subpath>`, or null when no asset has that name. Pure: the
 * assets are compiled in (src/ui/assets/generated.ts), so nothing is read from disk.
 */
export const serveAsset = (subpath: string, ifNoneMatch: string | null = null): Response | null => {
  const asset = byName.get(subpath)
  if (asset === undefined) return null
  const etag = etagOf(asset)
  const caching = { "cache-control": IMMUTABLE, etag }
  if (matchesEtag(ifNoneMatch, etag)) return new Response(null, { status: 304, headers: caching })
  return new Response(bodyOf(asset), {
    status: 200,
    headers: { ...caching, "content-type": asset.contentType, "x-content-type-options": "nosniff" }
  })
}

const ASSETS_DIR = "/assets/"

/**
 * The asset answer for a UI router's request, given the path after its prefix: the asset, a 304,
 * or a 404 for an unknown name. null when the path is not under /assets/ at all.
 */
export const assetRoute = (request: Request, path: string): Response | null => {
  if (!path.startsWith(ASSETS_DIR)) return null
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } })
  }
  return serveAsset(path.slice(ASSETS_DIR.length), request.headers.get("if-none-match")) ??
    new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })
}

// The URL a page links an asset by, under its own UI's prefix
export const assetUrl = (prefix: UiPrefix, asset: UiAsset): string => `${prefix}${ASSETS_DIR}${asset.name}`
