---
title: Web UIs
description: The admin dashboard at /_ui and the per-imposter UI at /_admin.
---

Imposters serves two browser UIs, both server-rendered HTML with nothing to install. The admin dashboard ships its own stylesheet, fonts and script, so it works offline. The per-imposter pages still load [htmx](https://htmx.org/) and Tailwind from a CDN while they move to the same design, so for now the browser needs to reach `unpkg.com` and `cdn.tailwindcss.com` for them.

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
| **Dashboard** (`/_admin`) | The imposter's configuration, its stub and request counts, and the latest requests |
| **Stubs** (`/_admin/stubs`) | Every stub, in matching order. Add one by pasting its predicates and responses as JSON and picking a response mode, edit or delete existing ones |
| **Requests** (`/_admin/requests`) | The [request log](../requests-and-stats/), filterable by method, path and status, with each request's detail. A form sends a test request (method, path, headers, body) to the imposter itself, and the log can be cleared |

The UIs use the same in-memory state as the admin API, so a stub added in the browser is live on the next request, exactly like one added with `POST /imposters/:id/stubs`.
