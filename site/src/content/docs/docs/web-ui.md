---
title: Web UIs
description: The admin dashboard at /_ui and the per-imposter UI at /_admin.
---

Imposters serves two browser UIs, both server-rendered HTML with nothing to install. Every page ships its own stylesheet, fonts and script, so both work offline, with no CDN.

## `/_ui`: the admin dashboard

On the admin port, `http://localhost:2525/_ui` shows every imposter and its traffic. The CLI prints its address on startup:

```text
Admin UI: http://127.0.0.1:2525/_ui
```

- **A summary strip** over the last 15 minutes of the running imposters: requests (with a trend line), the share of 5xx answers and the imposter with the most, the slowest p95 and whose it is, and how many requests no stub matched.
- **The imposter table**: name, status, protocol, port and stub count, a sparkline of the last 15 minutes, requests per minute, 5xx share, p95 and unmatched requests. Start, stop and delete (it asks first) are on each row, and **open ↗** goes to that imposter's own UI.
- **A create form** with name, port (blank picks a free one), protocol (HTTP and every registered extension, such as S3) and whether to start it now. A mistake is explained in plain words, and what you typed is kept.

The page refreshes its numbers every 5 seconds while the tab is visible. Every action is a plain form post, so the dashboard also works with JavaScript off. The sun/moon button switches between the dark and light themes; the choice is remembered in a cookie, and without one the page follows your system setting.

## `/_admin`: one imposter

Each imposter serves its own UI on its own port, at `/_admin`: `http://localhost:4000/_admin` for an imposter on port `4000`. Requests under `/_admin` go to the UI and never reach the stubs.

| Page | What it shows |
|---|---|
| **Live** (`/_admin`) | Requests per minute with a trend line, the 5xx share, p50/p95/p99 and the total since start. Requests stream in as they arrive (pause holds them). Each stub shows its hits, each response's share and the response it gives next; requests no stub matched are grouped by method and path, each with **stub it** |
| **Stubs** (`/_admin/stubs`) | Every stub as a card, in matching order, with its hits and next response. A response with [callbacks](../callbacks/) names them, `before (parallel) → stock, charge · after → notify`, with a line per call giving its method and host and marking `onError fail`. One editor adds and edits: a form (conditions as rows, each response as a card with status, headers, body and a fixed or random delay) or the JSON, insert first or last. It checks the stub as you type, explains mistakes in plain words, and previews how many of the unmatched requests it would answer |
| **Requests** (`/_admin/requests`) | The [request log](../requests-and-stats/), newest first, filterable by method, path and status. A form sends a request (method, path, headers, body) to the imposter itself, and the log can be cleared |
| **A request** (`/_admin/requests/:id`) | What was asked and answered, the **outbound calls** its response made (one row per [callback](../callbacks/), `before` first: its url, its status or error and how long it took, and the bodies the log kept, folded; a `pending` call settles on a reload), which stub and response answered, and why each stub matches it or not, with a warning when today's stubs would answer differently. **copy as curl**, **replay** (sends it to the imposter again and opens the new entry) and **stub it** for a request no stub matched |

The UIs use the same in-memory state as the admin API, so a stub added in the browser is live on the next request, exactly like one added with `POST /imposters/:id/stubs`.
