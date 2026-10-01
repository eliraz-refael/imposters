---
title: Getting started
description: Install Imposters, start the admin server, and serve your first stubbed response.
---

## Install

Imposters is published on npm as [`imposters`](https://www.npmjs.com/package/imposters). Add it to a project as a dev dependency:

```bash
npm install --save-dev imposters
```

Or run it without installing:

```bash
npx imposters start
```

Every release also attaches the same package to its [GitHub release](https://github.com/eliraz-refael/imposters/releases) as `imposters-<version>.tgz`, with the same files as the npm package. Where the npm registry is not reachable, depend on that file directly:

```json
"imposters": "https://github.com/eliraz-refael/imposters/releases/download/v0.6.0/imposters-0.6.0.tgz"
```

## Start the admin server

```bash
npx imposters start
```

```text
Imposters admin server running on http://127.0.0.1:2525 (bound to 127.0.0.1, runtime: node)
Admin UI: http://127.0.0.1:2525/_ui
```

The admin server listens on port `2525` and binds the loopback address, so nothing off your machine can reach it. See [CLI](../cli/) for the flags.

## Create an imposter

An imposter is a mock server on its own port. Create one through the admin API:

```bash
curl -X POST http://localhost:2525/imposters \
  -H "Content-Type: application/json" \
  -d '{"name": "users-api", "port": 3000}'
```

```json
{"id":"6ad977d0","name":"users-api","port":3000,"protocol":"HTTP","status":"stopped","endpointCount":0,"createdAt":"2026-10-01T21:18:10.878Z","adminUrl":"http://localhost:3000","adminPath":"/_admin","uptime":"0"}
```

The `id` is generated; use yours in the next steps. A new imposter is `stopped`: it does not listen yet. Leave out `port` and one is allocated from the range `3000` to `4000`; leave out `name` and the id is used.

## Add a stub

A stub pairs predicates, which a request must all match, with the responses to send:

```bash
curl -X POST http://localhost:2525/imposters/6ad977d0/stubs \
  -H "Content-Type: application/json" \
  -d '{
    "predicates": [
      { "field": "method", "operator": "equals", "value": "GET" },
      { "field": "path", "operator": "equals", "value": "/users/1" }
    ],
    "responses": [{
      "status": 200,
      "headers": { "content-type": "application/json" },
      "body": { "id": 1, "name": "Alice" }
    }]
  }'
```

The answer is the stored stub, with its generated `id` and the defaults filled in:

```json
{"id":"f0ade9bc","predicates":[{"field":"method","operator":"equals","value":"GET","caseSensitive":true},{"field":"path","operator":"equals","value":"/users/1","caseSensitive":true}],"responses":[{"status":200,"headers":{"content-type":"application/json"},"body":{"id":1,"name":"Alice"}}],"responseMode":"sequential"}
```

## Start it and send a request

```bash
curl -X PATCH http://localhost:2525/imposters/6ad977d0 \
  -H "Content-Type: application/json" \
  -d '{"status": "running"}'
```

The `PATCH` returns once the port is bound, so the imposter answers straight away:

```bash
curl http://localhost:3000/users/1
```

```json
{"id":1,"name":"Alice"}
```

A request that no stub matches gets a `404`:

```bash
curl http://localhost:3000/users/2
```

```json
{"error":"No matching stub found","method":"GET","path":"/users/2"}
```

## Next steps

- Put the imposter and its stubs in a [config file](../config-file/) and start with `--config`.
- Learn the [predicate operators](../stubs/) and [response templating](../responses/).
- Open `http://localhost:3000/_admin` to see the imposter's stubs and the requests it received ([Web UIs](../web-ui/)).
