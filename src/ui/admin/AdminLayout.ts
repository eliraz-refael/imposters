import { html, raw } from "../html.js"
import type { SafeHtml } from "../html.js"

export interface AdminLayoutOpts {
  readonly title: string
  readonly activeTab?: "dashboard"
}

export const adminLayout = (opts: AdminLayoutOpts, content: SafeHtml): SafeHtml =>
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
  <nav class="bg-gray-800 text-white shadow-md">
    <div class="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <span class="text-lg font-bold">Imposters</span>
        <span class="text-gray-400 text-sm">Admin</span>
      </div>
      <div class="flex gap-3 items-center">
        <a href="/_ui" class="px-3 py-1.5 bg-gray-700 text-white rounded text-sm font-medium hover:bg-gray-600">Dashboard</a>
        <a href="/docs" class="text-gray-400 hover:text-white text-sm">API Docs</a>
      </div>
    </div>
  </nav>
  <main class="max-w-6xl mx-auto px-4 py-6">
    ${raw(content.value)}
  </main>
</body>
</html>`
