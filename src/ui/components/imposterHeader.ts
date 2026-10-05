import { html, type SafeHtml } from "../html.js"
import { mark, themeToggle, topBar } from "./header.js"
import { pill, protocolPill, tab } from "./primitives.js"

/**
 * The header of an imposter's own pages (`/_admin` on its port): the mark back to the admin UI,
 * the imposter's name, port and state, and the page tabs.
 */

export type ImposterTab = "live" | "stubs" | "requests"

// The stubs tab's count, which the live page's poll keeps current
export const STUB_COUNT_ID = "tab-stubs-count"

export interface ImposterHeaderOpts {
  readonly name: string
  readonly port: number
  readonly protocol: string
  readonly running: boolean
  readonly proxyMode?: string
  readonly stubCount: number
  readonly current: ImposterTab
  // The admin UI (/_ui on the admin port), when this imposter knows where it is
  readonly adminUiUrl?: string
}

export const imposterHeader = (opts: ImposterHeaderOpts): SafeHtml =>
  topBar({
    navLabel: "Imposter",
    start: html`${
      mark(opts.adminUiUrl, "All imposters")
    }<span class="crumb" aria-hidden="true">/</span><h1 class="crumb-name">${opts.name}</h1>${
      pill(`:${String(opts.port)}`)
    }${opts.protocol === "HTTP" ? html`` : protocolPill(opts.protocol)}${
      opts.proxyMode === undefined ? html`` : pill(`proxy · ${opts.proxyMode}`, "info")
    }${opts.running ? pill(html`<span class="live"></span>running`, "on") : pill("stopped")}`,
    end: html`${tab({ label: "live", href: "/_admin", current: opts.current === "live" })}${
      tab({
        label: "stubs",
        href: "/_admin/stubs",
        current: opts.current === "stubs",
        count: opts.stubCount,
        countId: STUB_COUNT_ID
      })
    }${
      tab({ label: "requests", href: "/_admin/requests", current: opts.current === "requests" })
    }<span class="vsep" aria-hidden="true"></span>${themeToggle}`
  })
