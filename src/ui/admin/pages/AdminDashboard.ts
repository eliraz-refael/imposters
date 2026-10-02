import { html, raw } from "../../html.js"
import type { SafeHtml } from "../../html.js"
import { adminLayout } from "../AdminLayout.js"
import type { AdminImposterData } from "../partials.js"
import { createFormPartial, imposterListPartial, summaryBarPartial } from "../partials.js"

export interface AdminDashboardData {
  readonly imposters: ReadonlyArray<AdminImposterData>
}

export const adminDashboardPage = (data: AdminDashboardData): SafeHtml => {
  const content = html`
    ${summaryBarPartial(data.imposters)}
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
