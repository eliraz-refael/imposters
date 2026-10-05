import * as DateTime from "effect/DateTime"
import type { RequestLogEntry } from "../schemas/RequestLogSchema.js"
import type { Delay, ResponseConfig, Stub } from "../schemas/StubSchema.js"
import { html } from "./html.js"
import type { SafeHtml } from "./html.js"

const predicateSummary = (stub: Stub): string => {
  if (stub.predicates.length === 0) return "catch-all (no predicates)"
  return stub.predicates
    .map((p) => `${p.field} ${p.operator} ${JSON.stringify(p.value)}`)
    .join(" AND ")
}

// A string body is sent as-is, so show it as-is rather than as a JSON string literal
const formatBody = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value, null, 2)

const pad2 = (n: number): string => String(n).padStart(2, "0")

// Times render in UTC, labelled, so they read the same whatever the server's time zone
export const formatTimeUtc = (timestamp: DateTime.DateTime): string => {
  const parts = DateTime.toPartsUtc(timestamp)
  return `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)} UTC`
}

// The full instant in ISO 8601, e.g. 2026-10-02T09:57:56.645Z
export const formatTimestampUtc = (timestamp: DateTime.DateTime): string => DateTime.formatIso(timestamp)

// "250ms", or "100–500ms" for a range
const formatDelay = (delay: Delay): string =>
  typeof delay === "number" ? `${String(delay)}ms` : `${String(delay.min)}–${String(delay.max)}ms`

const responseDetail = (r: ResponseConfig, index: number, total: number): SafeHtml => {
  const label = total > 1 ? `Response ${String(index + 1)}/${String(total)}` : "Response"
  const headers = r.headers
    ? Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join(", ")
    : null
  return html`<div class="bg-gray-50 rounded p-3 mb-2 text-sm">
    <div class="flex items-center gap-2 mb-1">
      <span class="font-medium text-gray-700">${label}</span>
      <span class="px-1.5 py-0.5 rounded text-xs font-mono bg-indigo-100 text-indigo-700">${String(r.status)}</span>
      ${r.delay !== undefined ? html`<span class="text-xs text-gray-400">delay ${formatDelay(r.delay)}</span>` : html``}
    </div>
    ${headers !== null ? html`<div class="text-xs text-gray-500 mb-1">Headers: ${headers}</div>` : html``}
    ${
    r.body !== undefined
      ? html`<pre class="mt-1 bg-white border rounded p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap">${
        formatBody(r.body)
      }</pre>`
      : html`<div class="text-xs text-gray-400 italic">no body</div>`
  }
  </div>`
}

// The request detail page's matched stub (it has no actions: stubs are changed on the stubs page)
export const stubCardPartial = (stub: Stub): SafeHtml => {
  const responsesHtml = stub.responses
    .map((r, i) => responseDetail(r, i, stub.responses.length))
    .reduce((acc, r) => html`${acc}${r}`, html``)

  return html`<div class="bg-white rounded-lg shadow p-4 mb-3" id="stub-${stub.id}">
    <div class="flex items-center justify-between mb-2">
      <div>
        <span class="font-mono text-sm text-indigo-600 font-semibold">${stub.id}</span>
        <span class="ml-2 text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">${stub.responseMode}</span>
      </div>
    </div>
    <div class="text-sm text-gray-600 mb-2">
      <span class="font-medium">Predicates:</span> ${predicateSummary(stub)}
    </div>
    <div>
      ${responsesHtml}
    </div>
  </div>`
}

export const methodBadge = (method: string): SafeHtml => {
  const colors: Record<string, string> = {
    GET: "bg-green-100 text-green-700",
    POST: "bg-blue-100 text-blue-700",
    PUT: "bg-orange-100 text-orange-700",
    PATCH: "bg-yellow-100 text-yellow-700",
    DELETE: "bg-red-100 text-red-700",
    HEAD: "bg-gray-100 text-gray-700",
    OPTIONS: "bg-purple-100 text-purple-700"
  }
  const color = colors[method.toUpperCase()] ?? "bg-gray-100 text-gray-600"
  return html`<span class="px-1.5 py-0.5 rounded text-xs font-mono font-semibold ${color}">${method.toUpperCase()}</span>`
}

export const statusBadge = (status: number): SafeHtml => {
  let color: string
  if (status < 300) color = "bg-green-100 text-green-700"
  else if (status < 400) color = "bg-yellow-100 text-yellow-700"
  else if (status < 500) color = "bg-orange-100 text-orange-700"
  else color = "bg-red-100 text-red-700"
  return html`<span class="px-1.5 py-0.5 rounded text-xs font-mono font-semibold ${color}">${String(status)}</span>`
}

export const requestTablePartial = (
  entries: ReadonlyArray<RequestLogEntry>,
  opts?: { linkToDetail?: boolean }
): SafeHtml => {
  if (entries.length === 0) {
    return html`<tr><td colspan="7" class="text-center py-4 text-gray-400">No requests recorded.</td></tr>`
  }
  const rows = entries.map((entry) => {
    const stubId = entry.response.matchedStubId ?? "-"
    const rowContent = html`
      <td class="py-2 px-3 text-xs text-gray-500" title="${formatTimestampUtc(entry.timestamp)}">${
      formatTimeUtc(entry.timestamp)
    }</td>
      <td class="py-2 px-3">${methodBadge(entry.request.method)}</td>
      <td class="py-2 px-3 font-mono text-sm">${entry.request.path}</td>
      <td class="py-2 px-3">${statusBadge(entry.response.status)}</td>
      <td class="py-2 px-3 text-xs text-gray-500 font-mono">${stubId}</td>
      <td class="py-2 px-3 text-sm text-gray-500">${String(entry.duration)}ms</td>
      <td class="py-2 px-3">${
      opts?.linkToDetail !== false
        ? html`<a href="/_admin/requests/${entry.id}" class="text-indigo-600 hover:underline text-sm">detail</a>`
        : html``
    }</td>`
    return html`<tr class="border-t hover:bg-gray-50">${rowContent}</tr>`
  })
  return rows.reduce((acc, r) => html`${acc}${r}`, html``)
}
