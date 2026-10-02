import * as Layer from "effect/Layer"
import { HttpRouter } from "effect/unstable/http"
import { ApiLayer } from "imposters/layers/ApiLayer"
import { MainLayer } from "imposters/layers/MainLayer"
import { occupyPort, probeConnect } from "imposters/test/helpers/net"
import { makeAdminUiRouter } from "imposters/ui/admin/AdminUiRouter"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

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

const adminApi = (path: string, init?: RequestInit) => apiHandler(new Request(`http://localhost:2525${path}`, init))

const adminUi = async (path: string, init?: RequestInit): Promise<Response> => {
  const resp = await adminUiHandler(new Request(`http://localhost:2525${path}`, init))
  return resp ?? new Response("Not found", { status: 404 })
}

describe("E2E: Admin UI", () => {
  it("GET /_ui returns HTML admin dashboard", async () => {
    const resp = await adminUi("/_ui")
    expect(resp.status).toBe(200)
    expect(resp.headers.get("content-type")).toContain("text/html")

    const html = await resp.text()
    expect(html).toContain("<!DOCTYPE html>")
    expect(html).toContain("Imposters")
    expect(html).toContain("Admin")
    expect(html).toContain("Create Imposter")
    expect(html).toContain("Total Imposters")
  })

  it("POST /_ui/imposters creates an imposter and returns updated list", async () => {
    const formData = new URLSearchParams()
    formData.set("name", "Test Service")
    formData.set("port", "")
    formData.set("autoStart", "")

    const resp = await adminUi("/_ui/imposters", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formData.toString()
    })
    expect(resp.status).toBe(200)
    const html = await resp.text()
    expect(html).toContain("Test Service")
  })

  it("shows imposters in the dashboard", async () => {
    // Create an imposter via API
    await adminApi("/imposters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 9901, name: "Dashboard Test" })
    })

    const resp = await adminUi("/_ui")
    const html = await resp.text()
    expect(html).toContain("Dashboard Test")
    expect(html).toContain("9901")
  })

  it("GET /_ui/imposters returns HTMX partial with imposter list", async () => {
    const resp = await adminUi("/_ui/imposters")
    expect(resp.status).toBe(200)
    const html = await resp.text()
    // Should be partial HTML (no DOCTYPE)
    expect(html).not.toContain("<!DOCTYPE")
  })

  it("DELETE /_ui/imposters/:id deletes imposter and returns updated list", async () => {
    // Create
    const createResp = await adminApi("/imposters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 9902, name: "To Delete" })
    })
    const imp = await createResp.json()

    // Delete via UI
    const resp = await adminUi(`/_ui/imposters/${imp.id}`, { method: "DELETE" })
    expect(resp.status).toBe(200)
    const html = await resp.text()
    expect(html).not.toContain("To Delete")
  })

  it("non-/_ui paths return null (pass through to API)", async () => {
    const resp = await adminUiHandler(new Request("http://localhost:2525/imposters"))
    expect(resp).toBeNull()
  })
})

// Regression tests for the UI audit. Ports 9910-9929 belong to this block.
const uiForm = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "hx-request": "true" },
  body: new URLSearchParams(fields).toString()
})

const findImposter = async (name: string): Promise<{ id: string; status: string } | undefined> => {
  const resp = await adminApi("/imposters?limit=1000")
  const body: { imposters: Array<{ id: string; name: string; status: string }> } = await resp.json()
  return body.imposters.find((i) => i.name === name)
}

const expectUiError = async (resp: Response, status: number, message: string) => {
  expect(resp.status).toBe(status)
  expect(resp.headers.get("hx-retarget")).toBe("#ui-error")
  expect(resp.headers.get("hx-reswap")).toBe("innerHTML")
  const body = await resp.text()
  expect(body).toContain(message)
  // The table and the counts are refreshed out of band, wrapped so they parse beside rows
  expect(body).toContain("<template><tbody id=\"imposter-list\" hx-swap-oob=\"innerHTML\">")
  expect(body).toContain("<template><div id=\"admin-summary\" hx-swap-oob=\"true\"")
  return body
}

describe("E2E: Admin UI fixes", () => {
  it("serves its favicon under /_ui and links it from the page", async () => {
    const page = await (await adminUi("/_ui")).text()
    expect(page).toContain("href=\"/_ui/favicon.svg\"")
    const icon = await adminUi("/_ui/favicon.svg")
    expect(icon.status).toBe(200)
    expect(icon.headers.get("content-type")).toBe("image/svg+xml")
  })

  it("a create that the API rejects is a visible error with the API's message, not raw JSON", async () => {
    await adminApi("/imposters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 9910, name: "taken" })
    })
    const resp = await adminUi("/_ui/imposters", uiForm({ name: "dupe", port: "9910" }))
    const body = await expectUiError(resp, 409, "Failed to create imposter: Port 9910 is already allocated")
    expect(body).not.toContain("_tag")
  })

  it("a port that is not a whole number is a 400 before anything is created", async () => {
    const resp = await adminUi("/_ui/imposters", uiForm({ name: "badport", port: "12ab" }))
    await expectUiError(resp, 400, "Port must be a whole number")
    expect(await findImposter("badport")).toBeUndefined()
  })

  it("auto-start failure is reported, and the created imposter is listed as stopped", async () => {
    const release = await occupyPort(9911)
    try {
      const resp = await adminUi("/_ui/imposters", uiForm({ name: "autostart-fails", port: "9911", autoStart: "on" }))
      const body = await expectUiError(resp, 409, "Created the imposter, but it could not start")
      expect(body).toContain("autostart-fails")
      expect((await findImposter("autostart-fails"))?.status).toBe("stopped")
    } finally {
      await release()
    }
  })

  it("start failure is reported instead of silently re-rendering the row", async () => {
    const created = await adminApi("/imposters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 9912, name: "start-fails" })
    })
    const imp: { id: string } = await created.json()
    const release = await occupyPort(9912)
    try {
      const resp = await adminUi(`/_ui/imposters/${imp.id}/start`, { method: "POST" })
      await expectUiError(resp, 409, "Failed to start imposter")
    } finally {
      await release()
    }
  })

  it("start, stop and delete of an unknown imposter are visible 404s", async () => {
    await expectUiError(await adminUi("/_ui/imposters/nope/start", { method: "POST" }), 404, "Imposter not found")
    await expectUiError(await adminUi("/_ui/imposters/nope/stop", { method: "POST" }), 404, "Imposter not found")
    await expectUiError(await adminUi("/_ui/imposters/nope", { method: "DELETE" }), 404, "Imposter not found")
  })

  it("start and stop return the row with the summary counts refreshed out of band", async () => {
    const created = await adminApi("/imposters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 9913, name: "start-stop" })
    })
    const imp: { id: string } = await created.json()
    try {
      const started = await adminUi(`/_ui/imposters/${imp.id}/start`, { method: "POST" })
      expect(started.status).toBe(200)
      const startedBody = await started.text()
      expect(startedBody).toMatch(new RegExp(`^<tr id="row-${imp.id}"`))
      expect(startedBody).toContain("/stop\"")
      expect(startedBody).toContain("<template><div id=\"admin-summary\" hx-swap-oob=\"true\"")

      // Deleting a running imposter stops it and frees its port
      const deleted = await adminUi(`/_ui/imposters/${imp.id}`, { method: "DELETE" })
      expect(deleted.status).toBe(200)
      expect(await deleted.text()).not.toContain("start-stop")
      expect(await probeConnect(9913)).toBe("refused")
    } finally {
      await adminApi(`/imposters/${imp.id}?force=true`, { method: "DELETE" })
    }
  })

  it("Open UI links use the host the admin UI was reached through and the API's admin path", async () => {
    const created = await adminApi("/imposters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 9914, name: "open-ui" })
    })
    const imp: { id: string } = await created.json()
    try {
      const row = await (await adminUi(`/_ui/imposters/${imp.id}/start`, { method: "POST" })).text()
      expect(row).toContain("href=\"http://localhost:9914/_admin\"")

      const viaLan = await adminUiHandler(
        new Request("http://localhost:2525/_ui", { headers: { host: "10.1.2.3:2525" } })
      )
      expect(await viaLan?.text()).toContain("href=\"http://10.1.2.3:9914/_admin\"")
    } finally {
      await adminApi(`/imposters/${imp.id}?force=true`, { method: "DELETE" })
    }
  })

  it("the dashboard lists every imposter, not just the API's first page of 50", async () => {
    for (let i = 0; i < 55; i++) {
      await adminApi("/imposters", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `bulk-${String(i)}` })
      })
    }
    const page = await (await adminUi("/_ui")).text()
    expect(page).toContain(">bulk-0<")
    expect(page).toContain(">bulk-54<")
    const total = (await (await adminApi("/imposters?limit=1000")).json()).imposters.length
    expect(page).toMatch(new RegExp(`Total Imposters</div>\\s*<div[^>]*>${String(total)}<`))
  })
})
