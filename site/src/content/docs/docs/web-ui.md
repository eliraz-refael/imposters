---
title: Web UIs
description: The admin dashboard at /_ui and the per-imposter UI at /_admin.
---

Imposters serves two browser UIs. Both are server-rendered HTML with [htmx](https://htmx.org/); there is nothing to install, but the pages load htmx from `unpkg.com`, so the browser needs to reach it.

## `/_ui`: the admin dashboard

On the admin port, `http://localhost:2525/_ui` lists every imposter with its port, protocol and status. From it you can create an imposter, start and stop one, and delete one. The CLI prints its address on startup:

```text
Admin UI: http://127.0.0.1:2525/_ui
```

## `/_admin`: one imposter

Each imposter serves its own UI on its own port, at `/_admin`: `http://localhost:4000/_admin` for an imposter on port `4000`. Requests under `/_admin` go to the UI and never reach the stubs.

| Page | What it shows |
|---|---|
| **Dashboard** (`/_admin`) | The imposter's configuration, its stub and request counts, and the latest requests |
| **Stubs** (`/_admin/stubs`) | Every stub, in matching order. Add one by pasting its predicates and responses as JSON and picking a response mode, edit or delete existing ones |
| **Requests** (`/_admin/requests`) | The [request log](../requests-and-stats/), filterable by method, path and status, with each request's detail. A form sends a test request (method, path, headers, body) to the imposter itself, and the log can be cleared |

The UIs use the same in-memory state as the admin API, so a stub added in the browser is live on the next request, exactly like one added with `POST /imposters/:id/stubs`.
