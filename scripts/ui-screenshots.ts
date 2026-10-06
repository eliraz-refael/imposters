// Screenshots of the web UIs, for reviewing UI changes: starts the CLI with
// examples/ui-showcase.json, sends it realistic traffic, then captures every screen in SCREENS
// in both themes as <out>/<screen>-<theme>.png.
//
//   bun run screenshots [--out screenshots] [--port 2599] [--buckets 3]
//
// It drives the installed Google Chrome through playwright-core (`channel: "chrome"`), so no
// browser is downloaded; Chrome must be installed. The spawned server is always stopped, also
// on a failure or Ctrl-C.
import { Schema } from "effect"
import { type ChildProcess, spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { type Browser, chromium, type Page } from "playwright-core"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CONFIG = "examples/ui-showcase.json"
const HOST = "127.0.0.1"

// --- What to capture ---------------------------------------------------------

interface Target {
  /** The admin server, e.g. http://127.0.0.1:2599 */
  readonly admin: string
  /** The featured imposter (orders-api), e.g. http://127.0.0.1:3202 */
  readonly imposter: string
  /** A logged request of the featured imposter that a stub answered */
  readonly requestId: string
  /** A logged request of the featured imposter that no stub answered (long path, query and headers) */
  readonly unmatchedId: string
  /** The featured imposter's first stub (GET /orders: three responses), for the editor */
  readonly stubId: string
}

interface Screen {
  readonly name: string
  readonly url: (target: Target) => string
  /** Viewport width; the default is a 1440px desktop */
  readonly width?: number
  /** Viewport height, for a screen whose sticky editor would otherwise scroll inside itself */
  readonly height?: number
  /** Done on the loaded page before the shot (a click, some typing) */
  readonly prepare?: (page: Page) => Promise<void>
}

// orders-api has no stub for GET /v2/orders, and the traffic sends it
const DRAFT = new URLSearchParams({ draft: "GET", path: "/v2/orders" }).toString()

const editUrl = (t: Target): string => `${t.imposter}/_admin/stubs?edit=${encodeURIComponent(t.stubId)}`
const requestUrl = (t: Target): string => `${t.imposter}/_admin/requests/${encodeURIComponent(t.requestId)}`
const unmatchedUrl = (t: Target): string => `${t.imposter}/_admin/requests/${encodeURIComponent(t.unmatchedId)}`

// A request orders-api has no stub for, with a long path, query and header values, so the
// request page shows how they wrap (on a phone too)
const UNMATCHED = {
  path: "/v2/orders/ord_1001/shipments/shp_9f8e7d6c5b4a3f2e/tracking-events",
  query: "since=2026-10-01T00:00:00Z&include=carrier,location,estimated_delivery&page_size=50",
  headers: {
    accept: "application/json",
    "user-agent": "fulfilment-worker/4.12.0 (node-fetch; +https://example.com/bots/fulfilment)",
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    "x-request-id": "7f3c9a1e-5b2d-4c8e-9f10-2a6b8d4e1c37"
  }
}

// One line per screen; each is captured once per theme
const SCREENS: ReadonlyArray<Screen> = [
  { name: "ui-dashboard", url: (t) => `${t.admin}/_ui` },
  { name: "ui-dashboard-phone", url: (t) => `${t.admin}/_ui`, width: 390 },
  { name: "imposter-dashboard", url: (t) => `${t.imposter}/_admin` },
  { name: "imposter-dashboard-phone", url: (t) => `${t.imposter}/_admin`, width: 390 },
  { name: "imposter-stubs", url: (t) => `${t.imposter}/_admin/stubs` },
  // "Stub it" on a route no stub answers: the editor opens on a draft, checked and previewed
  { name: "imposter-stubs-draft", url: (t) => `${t.imposter}/_admin/stubs?${DRAFT}` },
  { name: "imposter-stubs-draft-phone", url: (t) => `${t.imposter}/_admin/stubs?${DRAFT}`, width: 390 },
  // The editor's form view on a stub with three responses, and on a phone
  { name: "imposter-stubs-form", url: editUrl, height: 2100 },
  { name: "imposter-stubs-form-phone", url: editUrl, width: 390 },
  // A body that is not JSON: its line and column under it, and one thing to fix
  {
    name: "imposter-stubs-form-error",
    url: editUrl,
    height: 2300,
    prepare: async (page) => {
      await page.click("[data-k='r2.delay-range']")
      await page.fill("[data-k='r2.body']", `{ "error": "service_unavailable" `)
    }
  },
  // The same stub in the JSON tab
  { name: "imposter-stubs-json", url: editUrl, prepare: (page) => page.click("[data-tab=json]") },
  { name: "imposter-requests", url: (t) => `${t.imposter}/_admin/requests` },
  { name: "imposter-requests-phone", url: (t) => `${t.imposter}/_admin/requests`, width: 390 },
  // A templated order a stub answered: the request, the response, why its stub matched
  { name: "imposter-request-detail", url: requestUrl },
  { name: "imposter-request-detail-phone", url: requestUrl, width: 390 },
  // A request no stub answered: every stub's verdicts, open, and "stub it"
  { name: "imposter-request-unmatched", url: unmatchedUrl },
  { name: "imposter-request-unmatched-phone", url: unmatchedUrl, width: 390 }
]

const THEMES = ["dark", "light"] as const
// The UIs read the theme from this cookie, which ui.js writes on both paths
const THEME_COOKIE = "imposters-theme"
const THEME_COOKIE_PATHS = ["/_ui", "/_admin"]

const DESKTOP = { width: 1440, height: 900 }
const SHOT_TIMEOUT_MS = 20_000

// --- Arguments ---------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    out: { type: "string", default: "screenshots" },
    port: { type: "string", default: process.env.SCREENSHOTS_PORT ?? "2599" },
    // Traffic runs until this many 30-second timeline buckets have closed, so the sparklines
    // (which leave out the bucket in progress) have points. 0 sends one burst and shoots at once.
    buckets: { type: "string", default: "3" }
  }
})

const parseCount = (name: string, value: string, min: number): number => {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}, got "${value}"`)
  return n
}

const adminPort = parseCount("port", args.port, 1)
const buckets = parseCount("buckets", args.buckets, 0)
const outDir = path.resolve(args.out)
const admin = `http://${HOST}:${adminPort}`

// --- The server --------------------------------------------------------------

// A timer that loses a race must not keep the process alive once everything else is done
const deadline = (ms: number): Promise<void> => sleep(ms, undefined, { ref: false })

let server: ChildProcess | undefined
let browser: Browser | undefined
const serverOutput: Array<string> = []

const startServer = (): ChildProcess => {
  // process.execPath is the bun running this script, so the server never depends on PATH
  const child = spawn(process.execPath, ["src/Program.ts", "start", "--config", CONFIG, "--port", String(adminPort)], {
    cwd: rootDir,
    env: { ...process.env, IMPOSTERS_HOST: HOST },
    stdio: ["ignore", "pipe", "pipe"]
  })
  const keep = (chunk: Buffer) => {
    serverOutput.push(chunk.toString())
    if (serverOutput.length > 200) serverOutput.shift()
  }
  child.stdout?.on("data", keep)
  child.stderr?.on("data", keep)
  // Without a listener a spawn failure would crash the script; waitUntilReady reports it instead
  child.on("error", (error) => keep(Buffer.from(`spawn failed: ${error.message}\n`)))
  return child
}

const exited = (child: ChildProcess): Promise<void> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", () => resolve()))

// `server` stays set until the child has exited, so the exit handler below can still SIGKILL it
// if the process exits while it is stopping
const stopServer = async (): Promise<void> => {
  const child = server
  if (child === undefined) return
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM")
    const stopped = await Promise.race([exited(child).then(() => true), deadline(5_000).then(() => false)])
    if (!stopped) {
      child.kill("SIGKILL")
      await exited(child)
    }
  }
  server = undefined
}

// One cleanup, shared: a signal during main's own cleanup waits for it rather than exiting
// half-way through
let cleaning: Promise<void> | undefined
const cleanup = (): Promise<void> =>
  cleaning ??= (async () => {
    await browser?.close().catch(() => undefined)
    browser = undefined
    await stopServer()
  })()

// A last resort if the process exits some other way: never leave the server holding its ports
process.on("exit", () => server?.kill("SIGKILL"))
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.once(signal, () => {
    console.error(`\n${signal}: stopping`)
    void cleanup().finally(() => process.exit(code))
  })
}

const isUp = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${admin}/health`, { signal: AbortSignal.timeout(1_000) })
    await res.body?.cancel()
    return res.ok
  } catch {
    return false
  }
}

// The CLI loads the whole config before the admin port binds, so a healthy admin server means
// every imposter is up
const waitUntilReady = async (child: ChildProcess): Promise<void> => {
  const giveUpAt = Date.now() + 30_000
  while (Date.now() < giveUpAt) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The server exited (${child.exitCode ?? child.signalCode}):\n${serverOutput.join("")}`)
    }
    if (await isUp()) return
    await sleep(200)
  }
  throw new Error(`The server did not answer ${admin}/health within 30s:\n${serverOutput.join("")}`)
}

// --- The admin API -----------------------------------------------------------

const ImposterList = Schema.Struct({
  imposters: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, port: Schema.Number }))
})
const RequestList = Schema.Array(Schema.Struct({ id: Schema.String }))
const StubList = Schema.Array(Schema.Struct({ id: Schema.String }))

const api = async (method: string, url: string, body?: unknown): Promise<unknown> => {
  const res = await fetch(`${admin}${url}`, {
    method,
    signal: AbortSignal.timeout(5_000),
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url} answered ${res.status}: ${text}`)
  const parsed: unknown = text === "" ? null : JSON.parse(text)
  return parsed
}

interface Imposter {
  readonly id: string
  readonly port: number
}

const findImposters = async (): Promise<ReadonlyMap<string, Imposter>> => {
  const { imposters } = Schema.decodeUnknownSync(ImposterList)(await api("GET", "/imposters?limit=100"))
  return new Map(imposters.map((imp) => [imp.name, { id: imp.id, port: imp.port }]))
}

// --- Traffic -----------------------------------------------------------------

interface Hit {
  readonly method?: string
  readonly path: string
  readonly json?: unknown
  readonly body?: string
}

const inFlight = new Set<Promise<void>>()
let sent = 0
let failed = 0

const send = (port: number, hit: Hit): void => {
  const headers = hit.json !== undefined ? { "content-type": "application/json" } : undefined
  const body = hit.json !== undefined ? JSON.stringify(hit.json) : hit.body
  const request = fetch(`http://${HOST}:${port}${hit.path}`, {
    method: hit.method ?? "GET",
    signal: AbortSignal.timeout(10_000),
    ...(headers !== undefined ? { headers } : {}),
    ...(body !== undefined ? { body } : {})
  })
    .then((res) => res.arrayBuffer())
    .then(() => undefined, () => {
      failed++
    })
  sent++
  inFlight.add(request)
  void request.finally(() => inFlight.delete(request))
}

const drain = async (): Promise<void> => {
  await Promise.race([Promise.all(inFlight), deadline(15_000)])
}

const pick = <A>(items: ReadonlyArray<A>, i: number): A => items[i % items.length]

const repeat = (count: number, hit: (i: number) => void): void => {
  for (let i = 0; i < count; i++) hit(i)
}

// A count that drifts with time, so the sparklines have a shape rather than a flat line
const wave = (base: number, t: number, phase: number): number =>
  Math.max(0, Math.round(base * (1 + 0.6 * Math.sin(t / 9 + phase)) + (Math.random() - 0.5) * base))

const chance = (p: number): boolean => Math.random() < p

const CUSTOMERS = ["acme", "globex", "initech", "umbrella"]
const SKUS = ["tee-black-m", "mug-white", "cap-navy", "hoodie-grey-l"]
const KEYS = ["photos/cat.jpg", "photos/dog.jpg", "docs/terms.pdf", "docs/invoice-1001.pdf", "avatars/alice.png"]

interface Ports {
  readonly users: number
  readonly orders: number
  readonly catalog: number
  readonly media: number
}

const seedS3 = async ({ media }: Ports): Promise<void> => {
  send(media, { method: "PUT", path: "/media" })
  await drain()
  for (const key of KEYS) send(media, { method: "PUT", path: `/media/${key}`, body: `contents of ${key}` })
  await drain()
}

// One second's worth of traffic, t seconds in
const tick = (ports: Ports, t: number): void => {
  const { catalog, media, orders, users } = ports
  // users-api: matched, templated, and a couple of routes no stub answers
  repeat(wave(6, t, 0), () => send(users, { path: "/users" }))
  repeat(wave(2, t, 1), (i) => send(users, { path: `/users/${(t + i) % 40 + 1}` }))
  if (chance(0.4)) send(users, { path: `/search?q=${pick(["alice", "bob", "admin"], t)}` })
  if (chance(0.25)) send(users, { path: `/users/${t % 9 + 1}/avatar` })
  if (chance(0.08)) send(users, { method: "DELETE", path: "/users/3" })
  // orders-api: a random 1 in 3 GET /orders is a 503; every third payment is a 500
  repeat(wave(4, t, 2), () => send(orders, { path: "/orders" }))
  if (chance(0.7)) {
    const items = SKUS.slice(0, t % 3 + 1).map((sku, i) => ({ sku, price: 9 + i * 10 }))
    send(orders, { method: "POST", path: "/orders", json: { customer: pick(CUSTOMERS, t), items } })
  }
  if (chance(0.35)) send(orders, { method: "POST", path: "/payments", json: { amount: 42.5 } })
  if (chance(0.15)) send(orders, { path: "/v2/orders" })
  if (chance(0.1)) send(orders, { path: `/orders/ord_${1000 + (t % 3)}` })
  // catalog-api: every answer is delayed, /products by 150-900 ms
  repeat(wave(2, t, 3), () => send(catalog, { path: "/products" }))
  if (chance(0.6)) send(catalog, { path: `/products/${pick(SKUS, t)}` })
  // media-s3: reads, writes and listings, one throttled key and the odd missing one
  repeat(wave(3, t, 4), (i) => send(media, { path: `/media/${pick(KEYS, t + i)}` }))
  if (chance(0.3)) send(media, { method: "PUT", path: `/media/uploads/${t}.txt`, body: `upload ${t}` })
  if (chance(0.2)) send(media, { path: "/media?list-type=2" })
  if (chance(0.15)) send(media, { path: "/media/videos/intro.mp4" })
  if (chance(0.08)) send(media, { path: "/media/photos/missing.jpg" })
}

const BUCKET_MS = 30_000

const sendTraffic = async (ports: Ports): Promise<void> => {
  await seedS3(ports)
  const start = Date.now()
  // The bucket in progress plus buckets - 1 whole ones; 0 means a single burst
  const stopAt = buckets === 0 ? start : (Math.floor(start / BUCKET_MS) + buckets) * BUCKET_MS
  if (buckets > 0) console.log(`Sending traffic for ${Math.round((stopAt - start) / 1000)}s`)
  let t = 0
  do {
    tick(ports, t++)
    if (buckets === 0) repeat(5, () => tick(ports, t++))
    else await sleep(Math.min(1_000, Math.max(0, stopAt - Date.now())))
  } while (Date.now() < stopAt)
  await drain()
  console.log(`Sent ${sent} requests (${failed} failed to connect or timed out)`)
}

// --- Screenshots -------------------------------------------------------------

const withTimeout = <A>(promise: Promise<A>, ms: number, what: string): Promise<A> =>
  Promise.race([
    promise,
    deadline(ms).then((): never => {
      throw new Error(`${what} timed out after ${ms}ms`)
    })
  ])

const shoot = async (target: Target): Promise<Array<string>> => {
  browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 30_000 })
  const written: Array<string> = []
  for (const theme of THEMES) {
    const context = await browser.newContext({ viewport: DESKTOP, colorScheme: theme })
    await context.addCookies(THEME_COOKIE_PATHS.map((cookiePath) => ({
      name: THEME_COOKIE,
      value: theme,
      domain: HOST,
      path: cookiePath
    })))
    try {
      for (const screen of SCREENS) {
        const file = path.join(outDir, `${screen.name}-${theme}.png`)
        const page = await context.newPage()
        page.setDefaultTimeout(SHOT_TIMEOUT_MS)
        try {
          if (screen.width !== undefined || screen.height !== undefined) {
            await page.setViewportSize({
              width: screen.width ?? DESKTOP.width,
              height: screen.height ?? DESKTOP.height
            })
          }
          // The pages poll or stream (SSE), so the network never goes idle
          await page.goto(screen.url(target), { waitUntil: "domcontentloaded", timeout: SHOT_TIMEOUT_MS })
          await withTimeout(page.evaluate(() => document.fonts.ready.then(() => undefined)), 10_000, "fonts")
          if (screen.prepare !== undefined) await screen.prepare(page)
          // Let scripts that style or fill the page on load finish
          await page.waitForTimeout(300)
          await page.screenshot({ path: file, animations: "disabled", fullPage: true, timeout: SHOT_TIMEOUT_MS })
          written.push(file)
          // A page wider than the window scrolls sideways, which no screen should
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
          console.log(`  ${path.basename(file)}${overflow > 0 ? `  (scrolls sideways by ${String(overflow)}px)` : ""}`)
        } finally {
          await page.close()
        }
      }
    } finally {
      await context.close()
    }
  }
  return written
}

// --- Main --------------------------------------------------------------------

const required = (imposters: ReadonlyMap<string, Imposter>, name: string): Imposter => {
  const imposter = imposters.get(name)
  if (imposter === undefined) throw new Error(`${CONFIG} has no imposter named "${name}"`)
  return imposter
}

const main = async (): Promise<void> => {
  const startedAt = Date.now()
  if (await isUp()) throw new Error(`Something already answers on ${admin}; pick another --port`)
  fs.mkdirSync(outDir, { recursive: true })

  console.log(`Starting imposters with ${CONFIG} on ${admin}`)
  server = startServer()
  await waitUntilReady(server)

  const imposters = await findImposters()
  const featured = required(imposters, "orders-api")
  const ports: Ports = {
    users: required(imposters, "users-api").port,
    orders: featured.port,
    catalog: required(imposters, "catalog-api").port,
    media: required(imposters, "media-s3").port
  }
  // The config format has no "stopped" state, so stop one here to show it
  await api("PATCH", `/imposters/${required(imposters, "payments-sandbox").id}`, { status: "stopped" })

  await sendTraffic(ports)

  // A templated order the POST /orders stub answered, for the request detail page
  const requests = Schema.decodeUnknownSync(RequestList)(
    await api("GET", `/imposters/${featured.id}/requests?method=POST&path=/orders&status=201&limit=1`)
  )
  const request = requests[0]
  if (request === undefined) throw new Error("orders-api logged no POST /orders answered with 201")

  await fetch(`http://${HOST}:${featured.port}${UNMATCHED.path}?${UNMATCHED.query}`, { headers: UNMATCHED.headers })
    .then((res) => res.arrayBuffer())
  const unmatched = Schema.decodeUnknownSync(RequestList)(
    await api("GET", `/imposters/${featured.id}/requests?method=GET&path=${encodeURIComponent(UNMATCHED.path)}&limit=1`)
  )[0]
  if (unmatched === undefined) throw new Error(`orders-api logged no GET ${UNMATCHED.path}`)

  const stub = Schema.decodeUnknownSync(StubList)(await api("GET", `/imposters/${featured.id}/stubs`))[0]
  if (stub === undefined) throw new Error("orders-api has no stubs")

  console.log(`Capturing ${SCREENS.length} screens x ${THEMES.length} themes into ${outDir}`)
  const written = await shoot({
    admin,
    imposter: `http://${HOST}:${featured.port}`,
    requestId: request.id,
    unmatchedId: unmatched.id,
    stubId: stub.id
  })
  console.log(`Wrote ${written.length} screenshots in ${Math.round((Date.now() - startedAt) / 1000)}s`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await cleanup()
}
