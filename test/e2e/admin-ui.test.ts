import * as Layer from "effect/Layer"
import { HttpRouter } from "effect/unstable/http"
import { ApiLayer } from "imposters/layers/ApiLayer"
import { MainLayer } from "imposters/layers/MainLayer"
import { httpGet, occupyPort, probeConnect } from "imposters/test/helpers/net"
import { makeAdminUiRouter } from "imposters/ui/admin/AdminUiRouter"
import { favicon, uiCss, uiJs } from "imposters/ui/assets/generated"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// Ports 9901-9929 belong to this file.

const FullLayer = ApiLayer.pipe(Layer.provide(MainLayer))

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

interface ImposterJson {
  readonly id: string
  readonly name: string
  readonly port: number
  readonly status: string
  readonly protocol: string
}

const adminApi = (path: string, init?: RequestInit) => apiHandler(new Request(`http://localhost:2525${path}`, init))

const sendJson = (method: string, path: string, body: unknown) =>
  adminApi(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

const adminUi = async (path: string, init?: RequestInit): Promise<Response> => {
  const resp = await adminUiHandler(new Request(`http://localhost:2525${path}`, init))
  return resp ?? new Response("Not found", { status: 404 })
}

const pageText = async (headers?: Record<string, string>): Promise<string> =>
  (await adminUi("/_ui", headers === undefined ? undefined : { headers })).text()

// A form post as a browser without JS sends it
const formPost = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString()
})

// The same post as ui.js sends it, asking for a fragment
const fragmentPost = (fields: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "x-imposters-fragment": "1" },
  body: new URLSearchParams(fields).toString()
})

const createImposter = async (body: Record<string, unknown>): Promise<ImposterJson> => {
  const resp = await sendJson("POST", "/imposters", body)
  expect(resp.status).toBe(201)
  return resp.json()
}

const findImposter = async (name: string): Promise<ImposterJson | undefined> => {
  const body: { imposters: ReadonlyArray<ImposterJson> } = await (await adminApi("/imposters?limit=1000")).json()
  return body.imposters.find((i) => i.name === name)
}

const remove = (id: string) => adminApi(`/imposters/${id}?force=true`, { method: "DELETE" })

// The markup of one imposter's row in a page or fragment
const rowOf = (page: string, id: string): string => {
  const idAt = page.indexOf(`id="imposter-${id}"`)
  expect(idAt).toBeGreaterThan(-1)
  const start = page.lastIndexOf("<div class=\"row", idAt)
  const next = page.indexOf("id=\"imposter-", idAt + 1)
  return page.slice(start, next === -1 ? page.indexOf("</section>", start) : next)
}

const expectSeeOther = (resp: Response) => {
  expect(resp.status).toBe(303)
  expect(resp.headers.get("location")).toBe("/_ui")
}

describe("E2E: /_ui overview page", () => {
  it("is a self-contained HTML page: hashed self-hosted assets, no CDN, not cached", async () => {
    const resp = await adminUi("/_ui")
    expect(resp.status).toBe(200)
    expect(resp.headers.get("content-type")).toContain("text/html")
    expect(resp.headers.get("cache-control")).toBe("no-store")

    const html = await resp.text()
    expect(html).toContain("<!DOCTYPE html>")
    expect(html).toContain(`href="/_ui/assets/${uiCss.name}"`)
    expect(html).toContain(`src="/_ui/assets/${uiJs.name}"`)
    expect(html).toContain(`href="/_ui/assets/${favicon.name}"`)
    expect(html).not.toMatch(/unpkg|cdn\.|tailwind|htmx|googleapis/i)
    expect(html).not.toMatch(/(src|href)="https?:\/\//)
  })

  it("renders the theme from the imposters-theme cookie, and follows the system without one", async () => {
    expect(await pageText({ cookie: "imposters-theme=light" })).toContain("<html lang=\"en\" data-theme=\"light\">")
    expect(await pageText({ cookie: "other=1; imposters-theme=dark" })).toContain(
      "<html lang=\"en\" data-theme=\"dark\">"
    )
    const system = await pageText()
    expect(system).toContain("<html lang=\"en\">")
    expect(await pageText({ cookie: "imposters-theme=\"><script>" })).toContain("<html lang=\"en\">")
    // The toggle that writes the cookie
    expect(system).toContain("data-theme-toggle")
  })

  it("has the summary strip, the live region it polls, and a create form with the protocols", async () => {
    const html = await pageText()
    expect(html).toContain("aria-label=\"Traffic, last 15 minutes\"")
    for (const label of ["requests · last 15 min", "5xx rate", "slowest p95", "no stub matched"]) {
      expect(html).toContain(label)
    }
    expect(html).toContain("id=\"overview\" data-poll=\"5000\" data-url=\"/_ui/fragments/overview\"")
    expect(html).toContain("<form class=\"new-form\" method=\"post\" action=\"/_ui/imposters\" data-action")
    expect(html).toContain("<option value=\"HTTP\" selected>HTTP</option>")
    expect(html).toContain("placeholder=\"auto (3000–4000)\"")
    expect(html).toContain("binds 127.0.0.1")
    expect(html).toContain("admin · 127.0.0.1:2525")
  })

  it("serves the live region as a fragment, with the headline out of band", async () => {
    const resp = await adminUi("/_ui/fragments/overview", { headers: { "x-imposters-fragment": "1" } })
    expect(resp.status).toBe(200)
    expect(resp.headers.get("cache-control")).toBe("no-store")
    const html = await resp.text()
    expect(html).not.toContain("<!DOCTYPE")
    expect(html).toContain("aria-label=\"Traffic, last 15 minutes\"")
    expect(html).toContain("id=\"overview-headline\" data-oob")
  })

  it("escapes a hostile imposter name everywhere it is shown", async () => {
    const hostile = "<img src=x onerror=alert(1)>\"'"
    const imp = await createImposter({ port: 9901, name: hostile })
    try {
      const html = await pageText()
      expect(html).not.toContain("<img src=x")
      const row = rowOf(html, imp.id)
      expect(row).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;")
      expect(row).toContain("data-confirm=\"Delete &lt;img src=x onerror=alert(1)&gt;&quot;&#39;?")
    } finally {
      await remove(imp.id)
    }
  })

  it("lists every imposter, not just the API's default page of 50", async () => {
    const created: Array<ImposterJson> = []
    for (let i = 0; i < 60; i++) created.push(await createImposter({ name: `bulk-${String(i)}` }))
    try {
      const html = await pageText()
      expect(html).toContain(">bulk-0<")
      expect(html).toContain(">bulk-59<")
    } finally {
      for (const imp of created) await remove(imp.id)
    }
  })

  it("non-/_ui paths return null (pass through to the API)", async () => {
    expect(await adminUiHandler(new Request("http://localhost:2525/imposters"))).toBeNull()
  })
})

describe("E2E: /_ui traffic numbers", () => {
  it("a running imposter's row and the strip show its last 15 minutes: requests, 5xx and unmatched", async () => {
    const imp = await createImposter({ port: 9902, name: "numbers" })
    await sendJson("POST", `/imposters/${imp.id}/stubs`, {
      predicates: [{ field: "path", operator: "equals", value: "/boom" }],
      responses: [{ status: 503 }]
    })
    await sendJson("POST", `/imposters/${imp.id}/stubs`, {
      predicates: [{ field: "path", operator: "equals", value: "/ok" }],
      responses: [{ status: 200 }]
    })
    await sendJson("PATCH", `/imposters/${imp.id}`, { status: "running" })
    try {
      await httpGet(9902, "/ok")
      await httpGet(9902, "/ok")
      await httpGet(9902, "/boom")
      await httpGet(9902, "/nothing-here")

      const html = await pageText()
      const row = rowOf(html, imp.id)
      expect(row).toContain("dot-on")
      expect(row).toContain("running · last req")
      // 4 requests, 1 of them a 5xx (25%: hot), 1 unmatched
      expect(row).toContain("<span class=\"num c-warn\" role=\"cell\">25.0%</span>")
      expect(row).toContain("<span class=\"num\" role=\"cell\">1</span>")
      expect(row).toContain("spark spark-warn")
      expect(row).toContain("href=\"http://localhost:9902/_admin\"")
      expect(html).toContain("mostly <a href=\"http://localhost:9902/_admin\">numbers</a>")
      expect(html).toContain("see them on numbers →")
    } finally {
      await remove(imp.id)
    }
  })

  it("a stopped imposter's row shows dashes and offers start; its stubs are counted", async () => {
    const imp = await createImposter({ port: 9903, name: "parked" })
    await sendJson("POST", `/imposters/${imp.id}/stubs`, { predicates: [], responses: [{ status: 200 }] })
    try {
      const row = rowOf(await pageText(), imp.id)
      expect(row).toContain("row-off")
      expect(row).toContain("stopped · 1 stub ready")
      expect(row).toContain(`action="/_ui/imposters/${imp.id}/start"`)
      expect(row).toContain("aria-disabled=\"true\"")
      expect(row).toContain("spark spark-off")
      expect(row).toContain("data-confirm=\"Delete parked and its 1 stub?\"")
      expect(row.match(/role="cell">—<\/span>/g)).toHaveLength(4)
    } finally {
      await remove(imp.id)
    }
  })

  it("links to an imposter's UI use the host the admin UI was reached through", async () => {
    const imp = await createImposter({ port: 9904, name: "open-ui" })
    await sendJson("PATCH", `/imposters/${imp.id}`, { status: "running" })
    try {
      const viaLan = await adminUiHandler(
        new Request("http://localhost:2525/_ui", { headers: { host: "10.1.2.3:2525" } })
      )
      expect(rowOf((await viaLan?.text()) ?? "", imp.id)).toContain("href=\"http://10.1.2.3:9904/_admin\"")
    } finally {
      await remove(imp.id)
    }
  })
})

describe("E2E: /_ui create form", () => {
  it("without JS: a POST creates and starts the imposter, then 303s back to the page", async () => {
    const resp = await adminUi(
      "/_ui/imposters",
      formPost({ name: "made-by-form", port: "9910", protocol: "HTTP", start: "on" })
    )
    expectSeeOther(resp)
    const created = await findImposter("made-by-form")
    try {
      expect(created?.port).toBe(9910)
      expect(created?.status).toBe("running")
      expect(await probeConnect(9910)).toBe("connected")
    } finally {
      if (created !== undefined) await remove(created.id)
    }
  })

  it("without JS: leaving start unticked creates it stopped", async () => {
    expectSeeOther(await adminUi("/_ui/imposters", formPost({ name: "made-stopped", port: "9911", protocol: "HTTP" })))
    const created = await findImposter("made-stopped")
    expect(created?.status).toBe("stopped")
    if (created !== undefined) await remove(created.id)
  })

  it("with JS: answers with the refreshed live region, which lists the new imposter", async () => {
    const resp = await adminUi("/_ui/imposters", fragmentPost({ name: "made-by-js", port: "9912", protocol: "HTTP" }))
    expect(resp.status).toBe(200)
    const html = await resp.text()
    expect(html).not.toContain("<!DOCTYPE")
    const created = await findImposter("made-by-js")
    expect(created).toBeDefined()
    if (created !== undefined) {
      expect(rowOf(html, created.id)).toContain("made-by-js")
      await remove(created.id)
    }
  })

  it("a port that is not a whole number in range is a plain-English 400, and the form keeps what was typed", async () => {
    for (const port of ["12ab", "80", "70000", "3000.5"]) {
      const resp = await adminUi("/_ui/imposters", formPost({ name: "bad-port", port, protocol: "HTTP", start: "on" }))
      expect(resp.status).toBe(400)
      const html = await resp.text()
      expect(html).toContain("<!DOCTYPE html>")
      expect(html).toContain("The port must be a whole number from 1024 to 65535, like 3000.")
      expect(html).toContain("value=\"bad-port\"")
      expect(html).toContain(`value="${port}"`)
    }
    expect(await findImposter("bad-port")).toBeUndefined()
  })

  it("with JS, a validation error is the message alone, for the form's error slot", async () => {
    const resp = await adminUi("/_ui/imposters", fragmentPost({ name: "bad-js", port: "nope", protocol: "HTTP" }))
    expect(resp.status).toBe(400)
    expect(await resp.text()).toBe(
      "The port must be a whole number from 1024 to 65535, like 3000. Leave it blank to pick a free one."
    )
  })

  it("a protocol no extension provides is a 400 naming the ones there are", async () => {
    const resp = await adminUi("/_ui/imposters", fragmentPost({ name: "bad-proto", protocol: "GOPHER" }))
    expect(resp.status).toBe(400)
    expect(await resp.text()).toBe("There is no &quot;GOPHER&quot; protocol here. Choose one of: HTTP.")
    expect(await findImposter("bad-proto")).toBeUndefined()
  })

  it("an API rejection reads as a sentence, not raw JSON", async () => {
    const taken = await createImposter({ port: 9913, name: "taken" })
    try {
      const resp = await adminUi("/_ui/imposters", formPost({ name: "dupe", port: "9913", protocol: "HTTP" }))
      expect(resp.status).toBe(409)
      const html = await resp.text()
      expect(html).toContain("Could not create the imposter: Port 9913 is already allocated.")
      expect(html).not.toContain("_tag")
      expect(await findImposter("dupe")).toBeUndefined()
    } finally {
      await remove(taken.id)
    }
  })

  it("a failed auto-start is reported, and the created imposter is listed as stopped", async () => {
    const release = await occupyPort(9914)
    try {
      const resp = await adminUi(
        "/_ui/imposters",
        formPost({ name: "autostart-fails", port: "9914", protocol: "HTTP", start: "on" })
      )
      expect(resp.status).toBe(409)
      const html = await resp.text()
      expect(html).toContain("Created autostart-fails, but it could not start: Failed to bind port 9914")
      const created = await findImposter("autostart-fails")
      expect(created?.status).toBe("stopped")
      if (created !== undefined) {
        expect(rowOf(html, created.id)).toContain("stopped")
        // The form starts over: offering to create it again would only fail
        expect(html).not.toContain("value=\"autostart-fails\"")
        await remove(created.id)
      }
    } finally {
      await release()
    }
  })
})

describe("E2E: /_ui start, stop and delete", () => {
  it("without JS: start, stop and delete each 303 back to the page", async () => {
    const imp = await createImposter({ port: 9920, name: "lifecycle" })
    try {
      expectSeeOther(await adminUi(`/_ui/imposters/${imp.id}/start`, formPost({})))
      expect(await probeConnect(9920)).toBe("connected")
      expect(rowOf(await pageText(), imp.id)).toContain(`action="/_ui/imposters/${imp.id}/stop"`)

      expectSeeOther(await adminUi(`/_ui/imposters/${imp.id}/stop`, formPost({})))
      expect(await probeConnect(9920)).toBe("refused")

      expectSeeOther(await adminUi(`/_ui/imposters/${imp.id}/delete`, formPost({})))
      expect(await findImposter("lifecycle")).toBeUndefined()
    } finally {
      await remove(imp.id)
    }
  })

  it("with JS: each answers with the live region, showing the change", async () => {
    const imp = await createImposter({ port: 9921, name: "lifecycle-js" })
    try {
      const started = await adminUi(`/_ui/imposters/${imp.id}/start`, fragmentPost())
      expect(started.status).toBe(200)
      expect(rowOf(await started.text(), imp.id)).toContain("dot-on")

      const stopped = await adminUi(`/_ui/imposters/${imp.id}/stop`, fragmentPost())
      expect(rowOf(await stopped.text(), imp.id)).toContain("dot-off")

      // Deleting a running imposter stops it and frees its port
      await adminUi(`/_ui/imposters/${imp.id}/start`, fragmentPost())
      const deleted = await adminUi(`/_ui/imposters/${imp.id}/delete`, fragmentPost())
      expect(deleted.status).toBe(200)
      expect(await deleted.text()).not.toContain(`id="imposter-${imp.id}"`)
      expect(await probeConnect(9921)).toBe("refused")
    } finally {
      await remove(imp.id)
    }
  })

  it("a start that cannot bind is reported in plain English", async () => {
    const imp = await createImposter({ port: 9922, name: "start-fails" })
    const release = await occupyPort(9922)
    try {
      const resp = await adminUi(`/_ui/imposters/${imp.id}/start`, fragmentPost())
      expect(resp.status).toBe(409)
      expect(await resp.text()).toContain("Could not start the imposter: Failed to bind port 9922")

      // Without JS, the page again, with the message above the table
      const page = await adminUi(`/_ui/imposters/${imp.id}/start`, formPost({}))
      expect(page.status).toBe(409)
      expect(await page.text()).toMatch(/<div class="alert" data-error-slot role="alert">Could not start the imposter/)
    } finally {
      await release()
      await remove(imp.id)
    }
  })

  it("refuses a form post a browser marks cross-site, and creates nothing", async () => {
    const crossSite = (path: string, fields: Record<string, string>) =>
      adminUi(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" },
        body: new URLSearchParams(fields).toString()
      })
    const resp = await crossSite("/_ui/imposters", { name: "drive-by", protocol: "HTTP" })
    expect(resp.status).toBe(403)
    expect(await findImposter("drive-by")).toBeUndefined()

    const imp = await createImposter({ port: 9924, name: "keep-me" })
    try {
      expect((await crossSite(`/_ui/imposters/${imp.id}/delete`, {})).status).toBe(403)
      expect(await findImposter("keep-me")).toBeDefined()
      // The dashboard's own posts are same-origin
      const own = await adminUi(`/_ui/imposters/${imp.id}/delete`, {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" }
      })
      expectSeeOther(own)
    } finally {
      await remove(imp.id)
    }
  })

  it("an imposter that no longer exists is a 404 that says so", async () => {
    for (const action of ["start", "stop", "delete"]) {
      const resp = await adminUi(`/_ui/imposters/nope/${action}`, fragmentPost())
      expect(resp.status).toBe(404)
      expect(await resp.text()).toBe("That imposter no longer exists; it may have been deleted elsewhere.")
    }
  })

  it("the delete button asks first", async () => {
    const imp = await createImposter({ port: 9923, name: "confirm-me" })
    try {
      const row = rowOf(await pageText(), imp.id)
      expect(row).toContain(`action="/_ui/imposters/${imp.id}/delete" data-action data-target="#overview"`)
      expect(row).toContain("data-confirm=\"Delete confirm-me?\"")
    } finally {
      await remove(imp.id)
    }
  })
})
