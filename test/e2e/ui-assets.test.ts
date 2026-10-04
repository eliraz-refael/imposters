import * as Layer from "effect/Layer"
import { HttpRouter } from "effect/unstable/http"
import { ApiLayer } from "imposters/layers/ApiLayer"
import { MainLayer } from "imposters/layers/MainLayer"
import { makeAdminUiRouter } from "imposters/ui/admin/AdminUiRouter"
import { assets, favicon, uiCss } from "imposters/ui/assets/generated"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// Ports 9661-9669 belong to this file
const FullLayer = ApiLayer.pipe(Layer.provide(MainLayer))
const IMMUTABLE = "public, max-age=31536000, immutable"

let apiHandler: (request: Request) => Promise<Response>
let adminUiHandler: (request: Request) => Promise<Response | null>
let dispose: () => void

beforeAll(() => {
  const result = HttpRouter.toWebHandler(FullLayer)
  apiHandler = result.handler
  dispose = result.dispose
  adminUiHandler = makeAdminUiRouter({ apiHandler, adminPort: 2525 })
})

afterAll(() => {
  dispose()
})

const api = (path: string, init?: RequestInit) => apiHandler(new Request(`http://localhost:2525${path}`, init))

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
})

const withRunningImposter = async (port: number, body: (id: string) => Promise<void>) => {
  const created: { id: string } = await (await api("/imposters", json("POST", { port }))).json()
  await api(`/imposters/${created.id}`, json("PATCH", { status: "running" }))
  try {
    await body(created.id)
  } finally {
    await api(`/imposters/${created.id}`, json("PATCH", { status: "stopped" }))
  }
}

const iconHref = (page: string): string | undefined => /<link rel="icon"[^>]* href="([^"]+)"/.exec(page)?.[1]

// One UI's asset contract, whichever prefix and transport it is reached through
const expectAssetsServed = async (prefix: string, get: (path: string, init?: RequestInit) => Promise<Response>) => {
  const page = await (await get(prefix)).text()
  expect(iconHref(page)).toBe(`${prefix}/assets/${favicon.name}`)

  for (const asset of assets) {
    const resp = await get(`${prefix}/assets/${asset.name}`)
    expect(resp.status).toBe(200)
    expect(resp.headers.get("content-type")).toBe(asset.contentType)
    expect(resp.headers.get("cache-control")).toBe(IMMUTABLE)
    expect(resp.headers.get("etag")).toBe(`"${asset.hash}"`)
    const bytes = Buffer.from(await resp.arrayBuffer())
    expect(bytes.length).toBe(Buffer.from(asset.body, asset.encoding === "base64" ? "base64" : "utf8").length)
  }

  const revalidated = await get(`${prefix}/assets/${uiCss.name}`, { headers: { "if-none-match": `"${uiCss.hash}"` } })
  expect(revalidated.status).toBe(304)
  expect(await revalidated.text()).toBe("")

  expect((await get(`${prefix}/assets/ui.0000000000.css`)).status).toBe(404)
  expect((await get(`${prefix}/assets/`)).status).toBe(404)
}

describe("E2E: UI assets", () => {
  it("the admin UI serves them under /_ui/assets", async () => {
    await expectAssetsServed("/_ui", async (path, init) => {
      const resp = await adminUiHandler(new Request(`http://localhost:2525${path}`, init))
      return resp ?? new Response("Not found", { status: 404 })
    })
  })

  it("an imposter serves them under /_admin/assets, and none of it is logged as traffic", async () => {
    await withRunningImposter(9661, async (id) => {
      await expectAssetsServed("/_admin", (path, init) => fetch(`http://localhost:9661${path}`, init))
      const entries: ReadonlyArray<unknown> = await (await api(`/imposters/${id}/requests`)).json()
      expect(entries).toEqual([])
    })
  }, 10000)

  it("an imposter's own /assets/... path still goes to its stubs", async () => {
    await withRunningImposter(9662, async (id) => {
      await api(
        `/imposters/${id}/stubs`,
        json("POST", {
          predicates: [{ field: "path", operator: "equals", value: `/assets/${uiCss.name}` }],
          responses: [{ status: 200, body: "mine" }]
        })
      )
      const resp = await fetch(`http://localhost:9662/assets/${uiCss.name}`)
      expect(await resp.text()).toBe("mine")
    })
  }, 10000)
})
