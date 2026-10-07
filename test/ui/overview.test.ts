import * as Option from "effect/Option"
import {
  decodeImposterPage,
  type ImposterRow,
  isHot,
  type Overview,
  summarize,
  toRow
} from "imposters/ui/admin/OverviewData"
import { emptyCreateForm, overviewFragment, overviewPage } from "imposters/ui/admin/pages/Overview"
import { liveLabel, mark, themeToggle } from "imposters/ui/components/header"
import { linkButton, pill, postButton, protocolPill, statTile } from "imposters/ui/components/primitives"
import { html } from "imposters/ui/html"
import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { rootDir } from "../../scripts/ui-assets"

const HOSTILE = "<script>alert(\"x\")</script>'&"
const ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;&amp;"

const row = (overrides: Partial<ImposterRow> = {}): ImposterRow => ({
  id: "imp-1",
  name: "users-api",
  port: 3000,
  protocol: "HTTP",
  running: true,
  stubs: 2,
  uiUrl: "http://localhost:3000/_admin",
  timeline: [0, 1, 2],
  last15: { requests: 30, serverErrors: 0, unmatched: 0 },
  ...overrides
})

const overview = (imposters: ReadonlyArray<ImposterRow>): Overview => ({
  imposters,
  summary: summarize(imposters),
  health: Option.some({ nowMs: 1_000_000, uptime: "1h 12m 1s 234ms" }),
  protocols: ["HTTP", "S3"],
  portRange: Option.some({ min: 3000, max: 4000 }),
  bindHost: "127.0.0.1",
  adminPort: 2525,
  version: "1.2.3"
})

describe("primitives", () => {
  it("escape what they are given", () => {
    expect(pill(HOSTILE).value).toContain(ESCAPED)
    expect(protocolPill(HOSTILE).value).toContain(ESCAPED)
    expect(linkButton({ href: "\"><x", label: HOSTILE, ariaLabel: HOSTILE }).value).not.toContain("\"><x")
    const tile = statTile({ label: HOSTILE, value: HOSTILE, unit: HOSTILE, note: HOSTILE }).value
    expect(tile).not.toContain("<script>")
    expect(tile.split(ESCAPED)).toHaveLength(5)
  })

  it("a post button is a one-button form that works without JS and carries the ui.js hooks", () => {
    const button = postButton({
      action: "/_ui/imposters/a%2Fb/stop",
      label: "stop",
      target: "#overview",
      swap: "outer",
      confirm: `Stop ${HOSTILE}?`,
      ariaLabel: `Stop ${HOSTILE}`
    }).value
    expect(button).toMatch(
      /^<form class="inline-form" method="post" action="\/_ui\/imposters\/a%2Fb\/stop" data-action /
    )
    expect(button).toContain("data-target=\"#overview\"")
    expect(button).toContain("data-swap=\"outer\"")
    expect(button).toContain(`data-confirm="Stop ${ESCAPED}?"`)
    expect(button).toContain(`aria-label="Stop ${ESCAPED}"`)
    expect(button).toContain("<button class=\"btn\" type=\"submit\"")
  })

  it("protocol pills single out extensions", () => {
    expect(protocolPill("HTTP").value).toBe("<span class=\"pill\">HTTP</span>")
    expect(protocolPill("S3").value).toBe("<span class=\"pill pill-info\">S3</span>")
  })

  it("the header pieces carry their hooks", () => {
    expect(themeToggle.value).toContain("data-theme-toggle")
    expect(liveLabel().value).toContain("class=\"live\"")
    expect(mark("/_ui").value).toContain("href=\"/_ui\"")
  })
})

describe("toRow", () => {
  const counts = (requests: number) => ({ requests, serverErrors: 0, unmatched: 0 })
  const json = {
    imposters: [{
      id: "a",
      name: "users-api",
      port: 3000,
      status: "running",
      protocol: "HTTP",
      endpointCount: 1,
      adminPath: "/_admin",
      statistics: {
        lastRequestAt: "2026-10-02T09:05:07.123Z",
        p95ResponseTime: 12,
        timeline: [1, 2, 3].map((requests) => ({ start: "2026-10-02T09:04:00.000Z", ...counts(requests) })),
        last15Minutes: counts(6)
      }
    }],
    pagination: { hasMore: false }
  }

  it("reads the API's JSON; the sparkline leaves out the bucket still in progress", () => {
    const page = decodeImposterPage(json)
    expect(Option.isSome(page)).toBe(true)
    if (Option.isNone(page)) return
    const imp = page.value.imposters[0]
    if (imp === undefined) throw new Error("no imposter decoded")
    const decoded = toRow(imp, "10.0.0.2")
    expect(decoded.uiUrl).toBe("http://10.0.0.2:3000/_admin")
    expect(decoded.timeline).toEqual([1, 2])
    expect(decoded.last15.requests).toBe(6)
    expect(decoded.p95).toBe(12)
    expect(decoded.lastRequestAtMs).toBe(Date.UTC(2026, 9, 2, 9, 5, 7, 123))
    expect(decoded.running).toBe(true)
  })

  it("an imposter without statistics has no traffic", () => {
    const page = decodeImposterPage({ ...json, imposters: [{ ...json.imposters[0], statistics: undefined }] })
    if (Option.isNone(page)) throw new Error("did not decode")
    const imp = page.value.imposters[0]
    if (imp === undefined) throw new Error("no imposter decoded")
    expect(toRow(imp, "h")).toMatchObject({ timeline: [], last15: counts(0) })
  })
})

describe("summarize", () => {
  it("sums traffic over running imposters only, bucket by bucket", () => {
    const summary = summarize([
      row({ id: "a", timeline: [1, 2, 3], last15: { requests: 6, serverErrors: 1, unmatched: 2 } }),
      row({ id: "b", timeline: [10, 0, 0], last15: { requests: 10, serverErrors: 4, unmatched: 0 } }),
      row({
        id: "c",
        running: false,
        stubs: 5,
        timeline: [99, 99, 99],
        last15: { requests: 297, serverErrors: 0, unmatched: 9 }
      })
    ])
    expect(summary.total).toBe(3)
    expect(summary.running).toBe(2)
    expect(summary.stubs).toBe(9)
    expect(summary.last15).toEqual({ requests: 16, serverErrors: 5, unmatched: 2 })
    expect(summary.timeline).toEqual([11, 2, 3])
    expect(summary.mostServerErrors?.id).toBe("b")
    expect(summary.mostUnmatched?.id).toBe("a")
    expect(summary.unmatchedImposters).toBe(1)
  })

  it("names the slowest p95 by imposter, and only among running ones", () => {
    const summary = summarize([
      row({ id: "fast", p95: 4 }),
      row({ id: "slow", p95: 2004 }),
      row({ id: "stopped", running: false, p95: 9000 })
    ])
    expect(summary.slowest).toEqual({ row: expect.objectContaining({ id: "slow" }), p95: 2004 })
  })

  it("leaves out the leaders when nothing happened, and does not count an extension's requests as unmatched", () => {
    const summary = summarize([row({ protocol: "S3", last15: { requests: 3, serverErrors: 0, unmatched: 3 } })])
    expect(summary.mostServerErrors).toBeUndefined()
    expect(summary.mostUnmatched).toBeUndefined()
    expect(summary.unmatchedImposters).toBe(0)
    expect(summary.slowest).toBeUndefined()
    expect(summarize([]).timeline).toEqual([])
  })

  it("an imposter is hot at 5% server errors", () => {
    expect(isHot({ requests: 100, serverErrors: 5, unmatched: 0 })).toBe(true)
    expect(isHot({ requests: 100, serverErrors: 4, unmatched: 0 })).toBe(false)
    expect(isHot({ requests: 0, serverErrors: 0, unmatched: 0 })).toBe(false)
  })
})

describe("overview page", () => {
  it("escapes hostile names and paths in the row, the links, the strip and the confirm", () => {
    const hostile = row({
      id: "id\"><b>",
      name: HOSTILE,
      uiUrl: "http://h:1/_admin\"><b>",
      last15: { requests: 10, serverErrors: 5, unmatched: 3 },
      p95: 12
    })
    const page = overviewPage(overview([hostile]), { theme: null, form: emptyCreateForm }).value
    expect(page).not.toContain("<script>alert")
    expect(page).not.toContain("\"><b>")
    expect(page).toContain(ESCAPED)
    expect(page).toContain(`action="/_ui/imposters/id%22%3E%3Cb%3E/stop"`)
    expect(page).toContain(`data-confirm="Delete ${ESCAPED} and its 2 stubs?"`)
  })

  it("keeps a failed form's values and error, escaped", () => {
    const page = overviewPage(overview([]), {
      theme: "light",
      form: { name: HOSTILE, port: "\"12", protocol: "S3", start: false, error: `Bad ${HOSTILE}` }
    }).value
    expect(page).toContain(`value="${ESCAPED}"`)
    expect(page).toContain("value=\"&quot;12\"")
    expect(page).toContain("<option value=\"S3\" selected>S3</option>")
    expect(page).not.toContain(" checked>")
    expect(page).toContain(`data-error-slot role="alert">Bad ${ESCAPED}</div>`)
    expect(page).toContain("data-theme=\"light\"")
  })

  it("shows an empty state with no imposters, and the headline says so", () => {
    const page = overviewPage(overview([]), { theme: null, form: emptyCreateForm }).value
    expect(page).toContain("no imposters yet")
    expect(page).toContain("// no imposters yet · up 1h 12m")
    expect(page).not.toContain("role=\"table\"")
  })

  it("has the hooks the runtime drives: the poll, the actions, the theme toggle", () => {
    const page = overviewPage(overview([row()]), { theme: null, form: emptyCreateForm }).value
    expect(page).toContain("data-poll=\"5000\" data-url=\"/_ui/fragments/overview\"")
    expect(page).toContain("data-action data-target=\"#overview\" data-reset")
    expect(page).toContain("data-theme-toggle")
    expect(page.match(/data-error-slot/g)).toHaveLength(2)
    // The page renders the headline once; only the fragment sends it out of band
    expect(page.match(/id="overview-headline"/g)).toHaveLength(1)
    expect(overviewFragment(overview([row()])).value).toContain("id=\"overview-headline\" data-oob")
  })

  it("prints the strip from the summary", () => {
    const page = overviewPage(
      overview([
        row({ name: "flaky", last15: { requests: 1000, serverErrors: 171, unmatched: 20 }, p95: 2004 })
      ]),
      { theme: null, form: emptyCreateForm }
    ).value
    expect(page).toContain(">1,000<")
    expect(page).toContain("67 / min")
    expect(page).toContain("<span class=\"tile-value c-warn\">17.1%</span>")
    expect(page).toContain("<span class=\"tile-value\">2,004 <span class=\"tile-unit\">ms</span></span>")
    expect(page).toContain("see them on flaky →")
    expect(page).toContain("imposters v1.2.3 · binds 127.0.0.1")
  })

  it("the unmatched tile counts every imposter with unmatched requests, not just the top one", () => {
    const unmatched = (n: number) => ({ requests: 10, serverErrors: 0, unmatched: n })
    const data = overview([
      row({ id: "a", name: "users-api", last15: unmatched(2) }),
      row({ id: "b", name: "orders-api", uiUrl: "http://h:3001/_admin", last15: unmatched(9) }),
      row({ id: "c", name: "carts-api", last15: unmatched(1) }),
      row({ id: "d", name: "quiet-api", last15: unmatched(0) }),
      row({ id: "e", name: "stopped-api", running: false, last15: unmatched(4) }),
      row({ id: "f", name: "s3", protocol: "S3", last15: unmatched(5) })
    ])
    expect(data.summary.unmatchedImposters).toBe(3)
    const page = overviewFragment(data).value
    expect(page).toContain("3 imposters · <a href=\"http://h:3001/_admin\">most on orders-api →</a>")
    expect(page).not.toContain("see them on")
    // One imposter: the note names it alone
    expect(overviewFragment(overview([row({ name: "solo", last15: unmatched(3) })])).value)
      .toContain("see them on solo →")
  })

  it("labels each value cell with its column name, for the stacked cards on a narrow screen", () => {
    const page = overviewPage(overview([row({ p95: 12 }), row({ id: "imp-2", running: false })]), {
      theme: null,
      form: emptyCreateForm
    }).value
    const labels = ["stubs", "traffic · 15 min", "req/min", "5xx", "p95", "unmatched"]
    for (const label of labels) {
      // In the header row, and on both rows
      expect(page).toContain(`>${label}</span>`)
      expect(page.split(`data-label="${label}"`)).toHaveLength(3)
    }
    expect(page).toContain("<span class=\"num\" role=\"cell\" data-label=\"p95\">12 ms</span>")
    // A stopped row keeps its dashes under the labels
    expect(page).toContain("<span class=\"num\" role=\"cell\" data-label=\"req/min\">—</span>")
    // The cards lay out by these hooks
    expect(page.split("class=\"cell-protocol\"")).toHaveLength(3)
    expect(page.split("class=\"cell-spark\"")).toHaveLength(3)
  })

  it("a row without a clock still renders", () => {
    const data = { ...overview([row({ lastRequestAtMs: 999_000 })]), health: Option.none() }
    const page = overviewPage(data, { theme: null, form: emptyCreateForm }).value
    expect(page).toContain(">running<")
    expect(overviewPage(overview([row({ lastRequestAtMs: 958_000 })]), { theme: null, form: emptyCreateForm }).value)
      .toContain("running · last req 42s ago")
  })

  it("renders an html fragment, not a document, for the poll", () => {
    expect(overviewFragment(overview([row()])).value).not.toContain("<!DOCTYPE")
    expect(html`${overviewFragment(overview([]))}`.value).toContain("Traffic, last 15 minutes")
  })
})

describe("overview cards (ui.css)", () => {
  const css = fs.readFileSync(path.join(rootDir, "ui-assets", "ui.css"), "utf8").replaceAll(/\/\*[\s\S]*?\*\//g, "")

  it("never hide a running imposter's stub count: no rule, at any width, hides the stubs cell", () => {
    const hiding = Array.from(css.matchAll(/([^{}]*\bcell-stubs\b[^{}]*)\{([^{}]*)\}/g))
      .filter(([, , block]) => /display\s*:\s*none/.test(block ?? ""))
      .map(([, selector]) => selector?.trim())
    expect(hiding).toEqual([])
  })
})
