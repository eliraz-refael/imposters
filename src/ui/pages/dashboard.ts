import type { ImposterConfig } from "../../domain/imposter.js"
import type { RequestLogEntry } from "../../schemas/RequestLogSchema.js"
import { html } from "../html.js"
import { layout } from "../layout.js"

export interface DashboardData {
  readonly config: ImposterConfig
  readonly stubCount: number
  readonly requestCount: number
  readonly recentRequests: ReadonlyArray<RequestLogEntry>
}

const statCard = (label: string, value: string, color: string) =>
  html`<div class="bg-white rounded-lg shadow p-4">
    <div class="text-sm text-gray-500">${label}</div>
    <div class="text-2xl font-bold ${color}">${value}</div>
  </div>`

const extractOrigin = (headers: Record<string, string>): string => {
  const referer = headers["referer"] ?? headers["Referer"]
  if (referer) return referer
  const origin = headers["origin"] ?? headers["Origin"]
  if (origin) return origin
  const ua = headers["user-agent"] ?? headers["User-Agent"]
  if (ua) {
    if (ua.length > 50) return ua.slice(0, 47) + "..."
    return ua
  }
  return "-"
}

const formatBody = (body: unknown): string => {
  if (body === undefined || body === null) return ""
  if (typeof body === "string") {
    if (body.length > 80) return body.slice(0, 77) + "..."
    return body
  }
  const json = JSON.stringify(body)
  if (json.length > 80) return json.slice(0, 77) + "..."
  return json
}

const requestRow = (entry: RequestLogEntry) => {
  const origin = extractOrigin(entry.request.headers as Record<string, string>)
  const body = formatBody(entry.request.body)
  return html`<tr class="border-t align-top">
    <td class="py-2 px-3 font-mono text-sm">${entry.request.method}</td>
    <td class="py-2 px-3 font-mono text-sm">${entry.request.path}</td>
    <td class="py-2 px-3 text-sm">${String(entry.response.status)}</td>
    <td class="py-2 px-3 text-xs text-gray-500 max-w-48 truncate" title="${origin}">${origin}</td>
    <td class="py-2 px-3 text-xs font-mono text-gray-500 max-w-48 truncate" title="${body}">${body}</td>
    <td class="py-2 px-3 text-sm text-gray-500">${String(entry.duration)}ms</td>
  </tr>`
}

export const dashboardPage = (data: DashboardData) => {
  const statusColor = data.config.status === "running" ? "text-green-600" : "text-gray-500"
  const recentRows = data.recentRequests.map(requestRow)

  const content = html`
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      ${statCard("Status", data.config.status, statusColor)}
      ${statCard("Port", String(data.config.port), "text-gray-800")}
      ${statCard("Stubs", String(data.stubCount), "text-indigo-600")}
      ${statCard("Requests", String(data.requestCount), "text-indigo-600")}
    </div>

    <div class="bg-white rounded-lg shadow">
      <h2 class="text-lg font-semibold px-4 pt-4 pb-2">Recent Requests</h2>
      ${data.recentRequests.length === 0
        ? html`<p class="px-4 pb-4 text-gray-400">No requests yet.</p>`
        : html`<table class="w-full text-left">
            <thead>
              <tr class="text-xs text-gray-500 uppercase border-b">
                <th class="py-2 px-3">Method</th>
                <th class="py-2 px-3">Path</th>
                <th class="py-2 px-3">Status</th>
                <th class="py-2 px-3">Origin</th>
                <th class="py-2 px-3">Body</th>
                <th class="py-2 px-3">Duration</th>
              </tr>
            </thead>
            <tbody>${recentRows.reduce((acc, r) => html`${acc}${r}`, html``)}</tbody>
          </table>`}
    </div>`

  return layout(
    { title: `${data.config.name} — Dashboard`, imposterName: data.config.name, port: data.config.port, activeTab: "dashboard" },
    content
  )
}
