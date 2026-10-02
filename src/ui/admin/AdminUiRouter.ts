import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { faviconResponse } from "../favicon.js"
import { html, type SafeHtml } from "../html.js"
import { errorResponse, formString, htmlResponse } from "../htmx.js"
import { adminDashboardPage } from "./pages/AdminDashboard.js"
import type { AdminImposterData } from "./partials.js"
import { imposterListOob, imposterListPartial, imposterRowPartial, summaryBarPartial } from "./partials.js"

export interface AdminUiDeps {
  readonly apiHandler: (request: Request) => Promise<Response>
  readonly adminPort: number
}

const UI_PREFIX = "/_ui"
const PAGE_SIZE = 100

// The fields of the admin API's imposter JSON that the dashboard shows
const ImposterJson = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  port: Schema.Number,
  status: Schema.String,
  protocol: Schema.String,
  endpointCount: Schema.Number,
  adminPath: Schema.String
})
type ImposterJson = Schema.Schema.Type<typeof ImposterJson>
const decodeImposter = Schema.decodeUnknownOption(ImposterJson)
const decodeImposterPage = Schema.decodeUnknownOption(
  Schema.Struct({ imposters: Schema.Array(ImposterJson), pagination: Schema.Struct({ hasMore: Schema.Boolean }) })
)
const decodeCreated = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }))
const decodeApiError = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))

const readJson = async (resp: Response): Promise<unknown> => {
  try {
    const body: unknown = await resp.json()
    return body
  } catch {
    return undefined
  }
}

// The message of an admin API error answer, e.g. "Port 3000 is already allocated"
const apiErrorMessage = async (resp: Response): Promise<string> => {
  const text = await resp.text()
  const parsed = ((): unknown => {
    try {
      const body: unknown = JSON.parse(text)
      return body
    } catch {
      return undefined
    }
  })()
  return Option.match(decodeApiError(parsed), {
    onNone: () => text.trim() || `HTTP ${String(resp.status)}`,
    onSome: (err) => err.message
  })
}

// The host the browser reached the admin UI through, so "Open UI" links work from
// another machine too (the Node server rewrites request.url to localhost)
const browserHost = (request: Request): string => {
  const header = request.headers.get("host")
  if (header !== null && URL.canParse(`http://${header}`)) return new URL(`http://${header}`).hostname
  return new URL(request.url).hostname
}

const toAdminData = (imp: ImposterJson, host: string): AdminImposterData => ({
  id: imp.id,
  name: imp.name,
  port: imp.port,
  status: imp.status,
  protocol: imp.protocol,
  stubCount: imp.endpointCount,
  uiUrl: `http://${host}:${String(imp.port)}${imp.adminPath}`
})

export const makeAdminUiRouter = (deps: AdminUiDeps) => {
  const api = (path: string, init?: RequestInit): Promise<Response> =>
    deps.apiHandler(new Request(`http://localhost${path}`, init))

  const patchStatus = (id: string, status: "running" | "stopped"): Promise<Response> =>
    api(`/imposters/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status })
    })

  // Every page of the list: the dashboard shows all imposters, not the API's first page
  const fetchImposters = async (host: string, offset = 0): Promise<ReadonlyArray<AdminImposterData>> => {
    const resp = await api(`/imposters?limit=${String(PAGE_SIZE)}&offset=${String(offset)}`)
    if (!resp.ok) return []
    const page = decodeImposterPage(await readJson(resp))
    if (Option.isNone(page)) return []
    const here = page.value.imposters.map((imp) => toAdminData(imp, host))
    if (!page.value.pagination.hasMore || here.length === 0) return here
    return [...here, ...await fetchImposters(host, offset + PAGE_SIZE)]
  }

  const fetchImposter = async (id: string, host: string): Promise<AdminImposterData | null> => {
    const resp = await api(`/imposters/${id}`)
    if (!resp.ok) return null
    return Option.match(decodeImposter(await readJson(resp)), {
      onNone: () => null,
      onSome: (imp) => toAdminData(imp, host)
    })
  }

  // A successful action: its main content, plus the summary counts out of band
  const withSummary = async (main: SafeHtml, host: string, imposters?: ReadonlyArray<AdminImposterData>) => {
    const list = imposters ?? await fetchImposters(host)
    return htmlResponse(html`${main}${summaryBarPartial(list, { oob: true })}`)
  }

  // A failed action: the message in the error slot, and the table and counts refreshed,
  // since the failure may come from a change made elsewhere (deleted, restarted)
  const failure = async (message: string, status: number, host: string): Promise<Response> => {
    const list = await fetchImposters(host)
    return errorResponse(message, status, html`${imposterListOob(list)}${summaryBarPartial(list, { oob: true })}`)
  }

  const listResponse = async (host: string): Promise<Response> => {
    const list = await fetchImposters(host)
    return withSummary(imposterListPartial(list), host, list)
  }

  const create = async (request: Request, host: string): Promise<Response> => {
    const form = await request.formData().catch(() => null)
    if (form === null) return failure("Expected a form submission.", 400, host)

    const name = formString(form, "name")?.trim() ?? ""
    const portText = formString(form, "port")?.trim() ?? ""
    const autoStart = formString(form, "autoStart") === "on"
    if (portText !== "" && !/^\d+$/.test(portText)) {
      return failure(`Port must be a whole number, got "${portText}".`, 400, host)
    }

    // No protocol: the API defaults it to HTTP
    const payload: Record<string, unknown> = {}
    if (name !== "") payload.name = name
    if (portText !== "") payload.port = Number(portText)

    const createResp = await api("/imposters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    })
    if (!createResp.ok) {
      return failure(`Failed to create imposter: ${await apiErrorMessage(createResp)}`, createResp.status, host)
    }

    const created = decodeCreated(await readJson(createResp))
    if (autoStart && Option.isSome(created)) {
      const startResp = await patchStatus(created.value.id, "running")
      if (!startResp.ok) {
        const reason = await apiErrorMessage(startResp)
        return failure(`Created the imposter, but it could not start: ${reason}`, startResp.status, host)
      }
    }
    return listResponse(host)
  }

  // Start and stop resolve once the port is bound or released, so the row read after is current
  const setStatus = async (id: string, status: "running" | "stopped", host: string): Promise<Response> => {
    const resp = await patchStatus(id, status)
    if (!resp.ok) {
      const verb = status === "running" ? "start" : "stop"
      return failure(`Failed to ${verb} imposter: ${await apiErrorMessage(resp)}`, resp.status, host)
    }
    const imp = await fetchImposter(id, host)
    if (imp === null) return failure("Imposter not found.", 404, host)
    return withSummary(imposterRowPartial(imp), host)
  }

  const remove = async (id: string, host: string): Promise<Response> => {
    const resp = await api(`/imposters/${id}?force=true`, { method: "DELETE" })
    if (!resp.ok) return failure(`Failed to delete imposter: ${await apiErrorMessage(resp)}`, resp.status, host)
    return listResponse(host)
  }

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    if (url.pathname !== UI_PREFIX && !url.pathname.startsWith(`${UI_PREFIX}/`)) return null

    const path = url.pathname.slice(UI_PREFIX.length) || "/"
    const method = request.method.toUpperCase()
    const host = browserHost(request)

    if (method === "GET" && path === "/favicon.svg") return faviconResponse()

    if (method === "GET" && path === "/") {
      return htmlResponse(adminDashboardPage({ imposters: await fetchImposters(host) }))
    }

    // HTMX partial (imposter list)
    if (method === "GET" && path === "/imposters") return listResponse(host)

    if (method === "POST" && path === "/imposters") return create(request, host)

    const action = /^\/imposters\/([^/]+)\/(start|stop)$/.exec(path)
    if (method === "POST" && action?.[1] !== undefined) {
      return setStatus(action[1], action[2] === "start" ? "running" : "stopped", host)
    }

    const target = /^\/imposters\/([^/]+)$/.exec(path)
    if (method === "DELETE" && target?.[1] !== undefined) return remove(target[1], host)

    return null
  }
}
