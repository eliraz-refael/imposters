import type { ImposterConfig } from "../../domain/imposter.js"
import type { Stub } from "../../schemas/StubSchema.js"
import { html, raw } from "../html.js"
import { layout } from "../layout.js"
import { stubListPartial } from "../partials.js"

export interface StubsPageData {
  readonly config: ImposterConfig
  readonly stubs: ReadonlyArray<Stub>
}

const addStubForm = () =>
  html`<div class="bg-white rounded-lg shadow p-4 mb-6">
    <h2 class="text-lg font-semibold mb-3">Add Stub</h2>
    <form hx-post="/_admin/stubs" hx-target="#stub-list" hx-swap="innerHTML" hx-on::after-request="if(event.detail.successful) this.reset()">
      <div class="mb-3">
        <label class="block text-sm font-medium text-gray-700 mb-1">Predicates (JSON array)</label>
        <textarea name="predicates" rows="3" class="w-full border rounded p-2 font-mono text-sm" placeholder="[]">[]</textarea>
      </div>
      <div class="mb-3">
        <label class="block text-sm font-medium text-gray-700 mb-1">Responses (JSON array, at least 1)</label>
        <textarea name="responses" rows="4" class="w-full border rounded p-2 font-mono text-sm" placeholder='[{"status": 200, "body": {}}]'></textarea>
      </div>
      <div class="mb-3">
        <label class="block text-sm font-medium text-gray-700 mb-1">Response Mode</label>
        <select name="responseMode" class="border rounded p-2 text-sm">
          <option value="sequential">sequential</option>
          <option value="random">random</option>
          <option value="repeat">repeat</option>
        </select>
      </div>
      <button type="submit" class="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700 text-sm">Add Stub</button>
    </form>
  </div>`

export const stubsPage = (data: StubsPageData) => {
  const content = html`
    ${addStubForm()}
    <div id="stub-list">
      ${raw(stubListPartial(data.stubs).value)}
    </div>`

  return layout(
    { title: `${data.config.name} — Stubs`, imposterName: data.config.name, port: data.config.port, activeTab: "stubs" },
    content
  )
}
