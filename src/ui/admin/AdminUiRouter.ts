import type { AdminImposterData } from "./partials.js"
import { imposterRowPartial, imposterListPartial, adminErrorPartial } from "./partials.js"
import { adminDashboardPage } from "./pages/AdminDashboard.js"

export interface AdminUiDeps {
  readonly apiHandler: (request: Request) => Promise<Response>
  readonly adminPort: number
}

const htmlResponse = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" }
  })

const toAdminData = (imp: any): AdminImposterData => ({
  id: imp.id,
  name: imp.name ?? `imposter-${imp.id}`,
  port: imp.port,
  status: imp.status,
  protocol: imp.protocol ?? "HTTP",
  stubCount: imp.stubs?.length ?? imp.endpointCount ?? imp.stubCount ?? 0
})

const fetchImposters = async (apiHandler: (r: Request) => Promise<Response>): Promise<AdminImposterData[]> => {
  const resp = await apiHandler(new Request("http://localhost/imposters?limit=50", { method: "GET" }))
  if (!resp.ok) return []
  const data = await resp.json()
  const items = Array.isArray(data) ? data : (data.imposters ?? data.items ?? [])
  return items.map(toAdminData)
}

const fetchImposter = async (apiHandler: (r: Request) => Promise<Response>, id: string): Promise<AdminImposterData | null> => {
  const resp = await apiHandler(new Request(`http://localhost/imposters/${id}`, { method: "GET" }))
  if (!resp.ok) return null
  const imp = await resp.json()
  return toAdminData(imp)
}

export const makeAdminUiRouter = (deps: AdminUiDeps) =>
  async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith("/_ui")) return null

    const path = url.pathname.slice("/_ui".length) || "/"
    const method = request.method.toUpperCase()

    // GET / — dashboard
    if (method === "GET" && (path === "/" || path === "")) {
      const imposters = await fetchImposters(deps.apiHandler)
      return htmlResponse(adminDashboardPage({ imposters }).value)
    }

    // GET /imposters — HTMX partial (imposter list)
    if (method === "GET" && path === "/imposters") {
      const imposters = await fetchImposters(deps.apiHandler)
      return htmlResponse(imposterListPartial(imposters).value)
    }

    // POST /imposters — create imposter from form
    if (method === "POST" && path === "/imposters") {
      try {
        const formData = await request.formData()
        const name = formData.get("name") as string | null
        const portStr = formData.get("port") as string | null
        const autoStart = formData.get("autoStart") === "on"

        const payload: Record<string, unknown> = {
          protocol: "HTTP"
        }
        if (name && name.trim()) payload.name = name.trim()
        if (portStr && portStr.trim()) payload.port = Number(portStr.trim())

        const createResp = await deps.apiHandler(new Request("http://localhost/imposters", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        }))

        if (!createResp.ok) {
          const errBody = await createResp.text()
          const imposters = await fetchImposters(deps.apiHandler)
          return htmlResponse(
            adminErrorPartial(`Failed to create imposter: ${errBody}`).value +
            imposterListPartial(imposters).value
          )
        }

        const created = await createResp.json()

        // Auto-start if requested
        if (autoStart) {
          await deps.apiHandler(new Request(`http://localhost/imposters/${created.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "running" })
          }))
        }

        const imposters = await fetchImposters(deps.apiHandler)
        return htmlResponse(imposterListPartial(imposters).value)
      } catch (err) {
        const imposters = await fetchImposters(deps.apiHandler)
        return htmlResponse(
          adminErrorPartial(`Error: ${String(err)}`).value +
          imposterListPartial(imposters).value
        )
      }
    }

    // POST /imposters/:id/start
    const startMatch = path.match(/^\/imposters\/([^/]+)\/start$/)
    if (method === "POST" && startMatch) {
      const id = startMatch[1]!
      await deps.apiHandler(new Request(`http://localhost/imposters/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "running" })
      }))
      // Small delay for the server to start
      await new Promise((r) => setTimeout(r, 100))
      const imp = await fetchImposter(deps.apiHandler, id)
      if (!imp) {
        return htmlResponse(adminErrorPartial("Imposter not found").value, 404)
      }
      return htmlResponse(imposterRowPartial(imp).value)
    }

    // POST /imposters/:id/stop
    const stopMatch = path.match(/^\/imposters\/([^/]+)\/stop$/)
    if (method === "POST" && stopMatch) {
      const id = stopMatch[1]!
      await deps.apiHandler(new Request(`http://localhost/imposters/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "stopped" })
      }))
      await new Promise((r) => setTimeout(r, 100))
      const imp = await fetchImposter(deps.apiHandler, id)
      if (!imp) {
        return htmlResponse(adminErrorPartial("Imposter not found").value, 404)
      }
      return htmlResponse(imposterRowPartial(imp).value)
    }

    // DELETE /imposters/:id
    const deleteMatch = path.match(/^\/imposters\/([^/]+)$/)
    if (method === "DELETE" && deleteMatch) {
      const id = deleteMatch[1]!
      await deps.apiHandler(new Request(`http://localhost/imposters/${id}?force=true`, {
        method: "DELETE"
      }))
      const imposters = await fetchImposters(deps.apiHandler)
      return htmlResponse(imposterListPartial(imposters).value)
    }

    return null
  }
