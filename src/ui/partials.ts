import type { ResponseConfig, Stub } from "../schemas/StubSchema.js"
import { html } from "./html.js"
import type { SafeHtml } from "./html.js"

const predicateSummary = (stub: Stub): string => {
  if (stub.predicates.length === 0) return "catch-all (no predicates)"
  return stub.predicates
    .map((p) => `${p.field} ${p.operator} ${JSON.stringify(p.value)}`)
    .join(" AND ")
}

const formatJson = (value: unknown): string =>
  JSON.stringify(value, null, 2)

const responseDetail = (r: ResponseConfig, index: number, total: number): SafeHtml => {
  const label = total > 1 ? `Response ${String(index + 1)}/${String(total)}` : "Response"
  const headers = r.headers
    ? Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join(", ")
    : null
  return html`<div class="bg-gray-50 rounded p-3 mb-2 text-sm">
    <div class="flex items-center gap-2 mb-1">
      <span class="font-medium text-gray-700">${label}</span>
      <span class="px-1.5 py-0.5 rounded text-xs font-mono bg-indigo-100 text-indigo-700">${String(r.status)}</span>
      ${r.delay !== undefined ? html`<span class="text-xs text-gray-400">delay ${String(r.delay)}ms</span>` : html``}
    </div>
    ${headers !== null ? html`<div class="text-xs text-gray-500 mb-1">Headers: ${headers}</div>` : html``}
    ${r.body !== undefined
      ? html`<pre class="mt-1 bg-white border rounded p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap">${formatJson(r.body)}</pre>`
      : html`<div class="text-xs text-gray-400 italic">no body</div>`}
  </div>`
}

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
      <div class="flex gap-2">
        <button
          hx-delete="/_admin/stubs/${stub.id}"
          hx-target="#stub-list"
          hx-swap="innerHTML"
          hx-confirm="Delete this stub?"
          class="text-red-500 hover:text-red-700 text-sm">Delete</button>
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

export const stubListPartial = (stubs: ReadonlyArray<Stub>): SafeHtml => {
  if (stubs.length === 0) {
    return emptyStubMessage()
  }
  return stubs.reduce(
    (acc, stub) => html`${acc}${stubCardPartial(stub)}`,
    html``
  )
}

export const emptyStubMessage = (): SafeHtml =>
  html`<p class="text-gray-400 text-center py-8">No stubs configured. Add one above.</p>`

export const errorPartial = (message: string): SafeHtml =>
  html`<div class="bg-red-50 border border-red-200 text-red-700 rounded p-3 mb-3">${message}</div>`
