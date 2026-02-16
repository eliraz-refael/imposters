import type { ImposterConfig } from "../../domain/imposter.js"
import type { RequestLogEntry } from "../../schemas/RequestLogSchema.js"
import type { Stub } from "../../schemas/StubSchema.js"
import { html, raw } from "../html.js"
import type { SafeHtml } from "../html.js"
import { layout } from "../layout.js"
import { methodBadge, statusBadge, stubCardPartial } from "../partials.js"

export interface RequestDetailData {
  readonly config: ImposterConfig
  readonly entry: RequestLogEntry
  readonly matchedStub: Stub | null
}

const formatTimestamp = (ts: unknown): string => {
  try {
    const d = typeof (ts as { epochMillis: bigint }).epochMillis === "bigint"
      ? new Date(Number((ts as { epochMillis: bigint }).epochMillis))
      : new Date(String(ts))
    return d.toISOString()
  } catch {
    return String(ts)
  }
}

const formatBody = (body: unknown): string => {
  if (body === undefined || body === null) return "(empty)"
  if (typeof body === "string") {
    try {
      return JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      return body
    }
  }
  return JSON.stringify(body, null, 2)
}

const headersTable = (headers: Record<string, string>): SafeHtml => {
  const entries = Object.entries(headers)
  if (entries.length === 0) return html`<p class="text-gray-400 text-sm italic">No headers</p>`
  const rows = entries.map(([k, v]) =>
    html`<tr class="border-t"><td class="py-1 px-2 text-xs font-mono font-semibold text-gray-600">${k}</td><td class="py-1 px-2 text-xs font-mono">${v}</td></tr>`
  )
  return html`<table class="w-full"><tbody>${rows.reduce((a, r) => html`${a}${r}`, html``)}</tbody></table>`
}

const queryTable = (query: Record<string, string>): SafeHtml => {
  const entries = Object.entries(query)
  if (entries.length === 0) return html`<p class="text-gray-400 text-sm italic">No query parameters</p>`
  const rows = entries.map(([k, v]) =>
    html`<tr class="border-t"><td class="py-1 px-2 text-xs font-mono font-semibold text-gray-600">${k}</td><td class="py-1 px-2 text-xs font-mono">${v}</td></tr>`
  )
  return html`<table class="w-full"><tbody>${rows.reduce((a, r) => html`${a}${r}`, html``)}</tbody></table>`
}

export const requestDetailPage = (data: RequestDetailData): SafeHtml => {
  const { entry, matchedStub } = data
  const timestamp = formatTimestamp(entry.timestamp)
  const reqBody = formatBody(entry.request.body)
  const respBody = formatBody(entry.response.body)
  const respHeaders = entry.response.headers ?? {}

  const content = html`
    <div class="mb-4">
      <a href="/_admin/requests" class="text-indigo-600 hover:underline text-sm">&larr; Back to Requests</a>
      <span class="text-gray-400 mx-2">/</span>
      <span class="text-sm text-gray-500">Request ${entry.id}</span>
    </div>

    <div class="bg-white rounded-lg shadow p-4 mb-6">
      <div class="flex items-center gap-3 mb-3">
        ${methodBadge(entry.request.method)}
        <span class="font-mono text-lg">${entry.request.path}</span>
        ${statusBadge(entry.response.status)}
        <span class="text-sm text-gray-500">${String(entry.duration)}ms</span>
      </div>
      <div class="text-sm text-gray-500">
        <span>Timestamp: ${timestamp}</span>
        ${
    entry.response.matchedStubId
      ? html`<span class="ml-4">Matched Stub: <span class="font-mono text-indigo-600">${entry.response.matchedStubId}</span></span>`
      : html`<span class="ml-4 text-orange-500">No matching stub</span>`
  }
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
      <div>
        <h3 class="text-lg font-semibold mb-3">Request</h3>
        <div class="bg-white rounded-lg shadow p-4 space-y-3">
          <div>
            <h4 class="text-sm font-medium text-gray-700 mb-1">Headers</h4>
            ${headersTable(entry.request.headers as Record<string, string>)}
          </div>
          <div>
            <h4 class="text-sm font-medium text-gray-700 mb-1">Query Parameters</h4>
            ${queryTable(entry.request.query as Record<string, string>)}
          </div>
          <div>
            <h4 class="text-sm font-medium text-gray-700 mb-1">Body</h4>
            <pre class="bg-gray-50 border rounded p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">${reqBody}</pre>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-lg font-semibold mb-3">Response</h3>
        <div class="bg-white rounded-lg shadow p-4 space-y-3">
          <div class="flex items-center gap-2">
            ${statusBadge(entry.response.status)}
          </div>
          <div>
            <h4 class="text-sm font-medium text-gray-700 mb-1">Headers</h4>
            ${headersTable(respHeaders as Record<string, string>)}
          </div>
          <div>
            <h4 class="text-sm font-medium text-gray-700 mb-1">Body</h4>
            <pre class="bg-gray-50 border rounded p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">${respBody}</pre>
          </div>
        </div>
      </div>
    </div>

    ${
    matchedStub !== null
      ? html`<div>
          <h3 class="text-lg font-semibold mb-3">Matched Stub</h3>
          ${raw(stubCardPartial(matchedStub).value)}
        </div>`
      : html``
  }`

  return layout(
    {
      title: `${data.config.name} — Request ${entry.id}`,
      imposterName: data.config.name,
      port: data.config.port,
      activeTab: "requests"
    },
    content
  )
}
