import type { ImposterConfig } from "../../domain/imposter.js"
import type { RequestLogEntry } from "../../schemas/RequestLogSchema.js"
import { html, raw } from "../html.js"
import type { SafeHtml } from "../html.js"
import { layout } from "../layout.js"
import { requestTablePartial, statusBadge } from "../partials.js"

export interface RequestsPageData {
  readonly config: ImposterConfig
  readonly entries: ReadonlyArray<RequestLogEntry>
}

const testRequestForm = (_port: number): SafeHtml =>
  html`<details class="bg-white rounded-lg shadow p-4 mb-6">
    <summary class="text-lg font-semibold cursor-pointer">Send Test Request</summary>
    <form hx-post="/_admin/requests/test" hx-target="#test-result" hx-swap="innerHTML" class="mt-3 space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Method</label>
          <select name="method" class="w-full border rounded p-2 text-sm">
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
            <option value="DELETE">DELETE</option>
            <option value="HEAD">HEAD</option>
            <option value="OPTIONS">OPTIONS</option>
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Path</label>
          <input name="path" type="text" value="/" class="w-full border rounded p-2 text-sm font-mono" placeholder="/api/test" />
        </div>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Content-Type</label>
        <select name="contentType" class="w-full border rounded p-2 text-sm">
          <option value="application/json">application/json</option>
          <option value="text/plain">text/plain</option>
          <option value="application/x-www-form-urlencoded">application/x-www-form-urlencoded</option>
          <option value="application/xml">application/xml</option>
        </select>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Headers (one per line: Key: Value)</label>
        <textarea name="headers" rows="2" class="w-full border rounded p-2 text-sm font-mono" placeholder="Authorization: Bearer token123"></textarea>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Body</label>
        <textarea name="body" rows="3" class="w-full border rounded p-2 text-sm font-mono" placeholder='{"key": "value"}'></textarea>
      </div>
      <button type="submit" class="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700 text-sm">Send Request</button>
    </form>
    <div id="test-result" class="mt-3"></div>
  </details>`

const filterBar = (): SafeHtml =>
  html`<div class="bg-white rounded-lg shadow p-4 mb-6">
    <form hx-get="/_admin/requests/list" hx-target="#request-table-body" hx-swap="innerHTML" class="flex flex-wrap gap-3 items-end">
      <div>
        <label class="block text-xs text-gray-500 mb-1">Method</label>
        <select name="method" class="border rounded p-1.5 text-sm">
          <option value="">All</option>
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="PATCH">PATCH</option>
          <option value="DELETE">DELETE</option>
        </select>
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">Path</label>
        <input name="path" type="text" class="border rounded p-1.5 text-sm font-mono w-40" placeholder="/api/..." />
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">Status</label>
        <input name="status" type="text" class="border rounded p-1.5 text-sm font-mono w-20" placeholder="200" />
      </div>
      <button type="submit" class="bg-indigo-600 text-white px-3 py-1.5 rounded hover:bg-indigo-700 text-sm">Filter</button>
      <button type="button" hx-delete="/_admin/requests" hx-target="#request-table-body" hx-swap="innerHTML" hx-confirm="Clear all request logs?" class="bg-red-50 text-red-600 border border-red-200 px-3 py-1.5 rounded hover:bg-red-100 text-sm ml-auto">Clear Log</button>
    </form>
  </div>`

export const requestsPage = (data: RequestsPageData): SafeHtml => {
  const content = html`
    ${testRequestForm(data.config.port)}
    ${filterBar()}
    <div class="bg-white rounded-lg shadow overflow-x-auto">
      <table class="w-full text-left">
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
        <tbody id="request-table-body">
          ${raw(requestTablePartial(data.entries.slice().reverse()).value)}
        </tbody>
      </table>
    </div>`

  return layout(
    { title: `${data.config.name} — Requests`, imposterName: data.config.name, port: data.config.port, activeTab: "requests" },
    content
  )
}

export const testResultPartial = (result: { status: number; headers: Record<string, string>; body: string; duration: number }): SafeHtml => {
  const headerRows = Object.entries(result.headers).map(([k, v]) =>
    html`<tr class="border-t"><td class="py-1 px-2 text-xs font-mono text-gray-600">${k}</td><td class="py-1 px-2 text-xs font-mono">${v}</td></tr>`
  )
  return html`<div class="bg-gray-50 rounded p-3 border">
    <div class="flex items-center gap-3 mb-2">
      <span class="font-semibold text-sm">Response</span>
      ${statusBadge(result.status)}
      <span class="text-xs text-gray-500">${String(result.duration)}ms</span>
    </div>
    ${headerRows.length > 0
      ? html`<table class="w-full mb-2"><thead><tr class="text-xs text-gray-500"><th class="text-left px-2">Header</th><th class="text-left px-2">Value</th></tr></thead><tbody>${headerRows.reduce((a, r) => html`${a}${r}`, html``)}</tbody></table>`
      : html``}
    <pre class="bg-white border rounded p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">${result.body || "(empty body)"}</pre>
  </div>`
}
