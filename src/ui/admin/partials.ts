import { html } from "../html.js"
import type { SafeHtml } from "../html.js"

export interface AdminImposterData {
  readonly id: string
  readonly name: string
  readonly port: number
  readonly status: string
  readonly protocol: string
  readonly stubCount: number
}

const statusBadge = (status: string): SafeHtml => {
  if (status === "running") {
    return html`<span class="px-2 py-0.5 rounded text-xs font-semibold bg-green-100 text-green-700">running</span>`
  }
  if (status === "stopped") {
    return html`<span class="px-2 py-0.5 rounded text-xs font-semibold bg-gray-100 text-gray-600">stopped</span>`
  }
  return html`<span class="px-2 py-0.5 rounded text-xs font-semibold bg-yellow-100 text-yellow-700">${status}</span>`
}

export const imposterRowPartial = (imp: AdminImposterData): SafeHtml => {
  const isRunning = imp.status === "running"
  return html`<tr id="row-${imp.id}" class="border-t hover:bg-gray-50">
    <td class="py-3 px-4 font-medium">${imp.name}</td>
    <td class="py-3 px-4 font-mono text-sm">${String(imp.port)}</td>
    <td class="py-3 px-4">${statusBadge(imp.status)}</td>
    <td class="py-3 px-4 text-sm text-gray-600">${imp.protocol}</td>
    <td class="py-3 px-4 text-sm">${String(imp.stubCount)}</td>
    <td class="py-3 px-4">
      <div class="flex gap-2 items-center">
        ${isRunning
          ? html`<button hx-post="/_ui/imposters/${imp.id}/stop" hx-target="#row-${imp.id}" hx-swap="outerHTML" class="text-orange-600 hover:text-orange-800 text-sm font-medium">Stop</button>`
          : html`<button hx-post="/_ui/imposters/${imp.id}/start" hx-target="#row-${imp.id}" hx-swap="outerHTML" class="text-green-600 hover:text-green-800 text-sm font-medium">Start</button>`}
        <button hx-delete="/_ui/imposters/${imp.id}" hx-target="#imposter-list" hx-swap="innerHTML" hx-confirm="Delete this imposter?" class="text-red-500 hover:text-red-700 text-sm">Delete</button>
        ${isRunning
          ? html`<a href="http://localhost:${String(imp.port)}/_admin" target="_blank" class="text-indigo-600 hover:text-indigo-800 text-sm">Open UI</a>`
          : html``}
      </div>
    </td>
  </tr>`
}

export const imposterListPartial = (imposters: ReadonlyArray<AdminImposterData>): SafeHtml => {
  if (imposters.length === 0) {
    return html`<tr><td colspan="6" class="text-center py-8 text-gray-400">No imposters. Create one above.</td></tr>`
  }
  return imposters.reduce(
    (acc, imp) => html`${acc}${imposterRowPartial(imp)}`,
    html``
  )
}

export const createFormPartial = (error?: string): SafeHtml =>
  html`<div class="bg-white rounded-lg shadow p-4 mb-6">
    <h2 class="text-lg font-semibold mb-3">Create Imposter</h2>
    ${error ? html`<div class="bg-red-50 border border-red-200 text-red-700 rounded p-3 mb-3">${error}</div>` : html``}
    <form hx-post="/_ui/imposters" hx-target="#imposter-list" hx-swap="innerHTML" class="flex flex-wrap gap-3 items-end">
      <div>
        <label class="block text-xs text-gray-500 mb-1">Name (optional)</label>
        <input name="name" type="text" class="border rounded p-2 text-sm w-40" placeholder="My Service" />
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">Port (optional)</label>
        <input name="port" type="number" class="border rounded p-2 text-sm w-24" placeholder="auto" />
      </div>
      <div class="flex items-center gap-2">
        <input name="autoStart" type="checkbox" checked class="rounded" id="auto-start" />
        <label for="auto-start" class="text-sm text-gray-700">Auto-start</label>
      </div>
      <button type="submit" class="bg-gray-800 text-white px-4 py-2 rounded hover:bg-gray-700 text-sm">Create</button>
    </form>
  </div>`

export const adminErrorPartial = (message: string): SafeHtml =>
  html`<div class="bg-red-50 border border-red-200 text-red-700 rounded p-3 mb-3">${message}</div>`
