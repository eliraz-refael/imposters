import { html, raw } from "../../html.js"
import type { SafeHtml } from "../../html.js"
import { adminLayout } from "../AdminLayout.js"
import type { AdminImposterData } from "../partials.js"
import { createFormPartial, imposterListPartial } from "../partials.js"

export interface AdminDashboardData {
  readonly imposters: ReadonlyArray<AdminImposterData>
}

const summaryBar = (data: AdminDashboardData): SafeHtml => {
  const total = data.imposters.length
  const running = data.imposters.filter((i) => i.status === "running").length
  const stopped = total - running
  return html`<div class="grid grid-cols-3 gap-4 mb-6">
    <div class="bg-white rounded-lg shadow p-4">
      <div class="text-sm text-gray-500">Total Imposters</div>
      <div class="text-2xl font-bold text-gray-800">${String(total)}</div>
    </div>
    <div class="bg-white rounded-lg shadow p-4">
      <div class="text-sm text-gray-500">Running</div>
      <div class="text-2xl font-bold text-green-600">${String(running)}</div>
    </div>
    <div class="bg-white rounded-lg shadow p-4">
      <div class="text-sm text-gray-500">Stopped</div>
      <div class="text-2xl font-bold text-gray-500">${String(stopped)}</div>
    </div>
  </div>`
}

export const adminDashboardPage = (data: AdminDashboardData): SafeHtml => {
  const content = html`
    ${summaryBar(data)}
    ${createFormPartial()}
    <div class="bg-white rounded-lg shadow overflow-x-auto">
      <table class="w-full text-left">
        <thead>
          <tr class="text-xs text-gray-500 uppercase border-b">
            <th class="py-3 px-4">Name</th>
            <th class="py-3 px-4">Port</th>
            <th class="py-3 px-4">Status</th>
            <th class="py-3 px-4">Protocol</th>
            <th class="py-3 px-4">Stubs</th>
            <th class="py-3 px-4">Actions</th>
          </tr>
        </thead>
        <tbody id="imposter-list">
          ${raw(imposterListPartial(data.imposters).value)}
        </tbody>
      </table>
    </div>`

  return adminLayout({ title: "Imposters — Admin Dashboard" }, content)
}
