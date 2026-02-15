import type { ImposterConfig } from "../../domain/imposter.js"
import type { RequestLogEntry } from "../../schemas/RequestLogSchema.js"
import { html, raw } from "../html.js"
import { layout } from "../layout.js"
import { requestTablePartial } from "../partials.js"

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

export const dashboardPage = (data: DashboardData) => {
  const statusColor = data.config.status === "running" ? "text-green-600" : "text-gray-500"

  const content = html`
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      ${statCard("Status", data.config.status, statusColor)}
      ${statCard("Port", String(data.config.port), "text-gray-800")}
      ${statCard("Stubs", String(data.stubCount), "text-indigo-600")}
      ${statCard("Requests", String(data.requestCount), "text-indigo-600")}
    </div>

    <div class="bg-white rounded-lg shadow">
      <h2 class="text-lg font-semibold px-4 pt-4 pb-2">
        <a href="/_admin/requests" class="hover:text-indigo-600">Recent Requests &rarr;</a>
      </h2>
      ${data.recentRequests.length === 0
        ? html`<p class="px-4 pb-4 text-gray-400">No requests yet.</p>`
        : html`<table class="w-full text-left">
            <thead>
              <tr class="text-xs text-gray-500 uppercase border-b">
                <th class="py-2 px-3">Time</th>
                <th class="py-2 px-3">Method</th>
                <th class="py-2 px-3">Path</th>
                <th class="py-2 px-3">Status</th>
                <th class="py-2 px-3">Stub</th>
                <th class="py-2 px-3">Duration</th>
                <th class="py-2 px-3"></th>
              </tr>
            </thead>
            <tbody>${raw(requestTablePartial(data.recentRequests).value)}</tbody>
          </table>`}
    </div>`

  return layout(
    { title: `${data.config.name} — Dashboard`, imposterName: data.config.name, port: data.config.port, activeTab: "dashboard" },
    content
  )
}
