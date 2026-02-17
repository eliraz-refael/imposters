import { html, raw, type SafeHtml } from "./html"

export interface LayoutOpts {
  readonly title: string
  readonly imposterName: string
  readonly port: number
  readonly activeTab: "dashboard" | "stubs" | "requests"
}

const navTab = (label: string, href: string, active: boolean): SafeHtml =>
  active
    ? html`<a href="${href}" class="px-4 py-2 bg-white text-indigo-700 rounded-t font-semibold border-b-2 border-indigo-600">${label}</a>`
    : html`<a href="${href}" class="px-4 py-2 text-gray-300 hover:text-white hover:bg-indigo-500 rounded-t">${label}</a>`

export const layout = (opts: LayoutOpts, content: SafeHtml): SafeHtml =>
  html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${opts.title}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
</head>
<body class="bg-gray-50 min-h-screen">
  <nav class="bg-indigo-700 text-white shadow-md">
    <div class="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
      <div>
        <span class="text-indigo-200 text-sm font-medium mr-2">Imposters</span>
        <span class="text-lg font-bold">${opts.imposterName}</span>
        <span class="ml-2 text-indigo-200 text-sm">port ${String(opts.port)}</span>
      </div>
      <div class="flex gap-1">
        ${navTab("Dashboard", "/_admin", opts.activeTab === "dashboard")}
        ${navTab("Stubs", "/_admin/stubs", opts.activeTab === "stubs")}
        ${navTab("Requests", "/_admin/requests", opts.activeTab === "requests")}
      </div>
    </div>
  </nav>
  <main class="max-w-5xl mx-auto px-4 py-6">
    ${raw(content.value)}
  </main>
</body>
</html>`
