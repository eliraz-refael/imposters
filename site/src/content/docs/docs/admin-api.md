---
title: Admin API
description: The REST API on the admin port, its OpenAPI document and Swagger UI.
---

The admin server (port `2525` by default) serves a REST API with JSON bodies. Its full, schema-derived reference is served by the server itself:

| Path | What it is |
|---|---|
| [`http://localhost:2525/docs`](http://localhost:2525/docs) | Swagger UI, to read and try every endpoint |
| [`http://localhost:2525/openapi.json`](http://localhost:2525/openapi.json) | The OpenAPI document, for generating clients or importing into tools |

Both are generated from the same schemas that validate requests, so they always match the running version.

## Endpoints

### System

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check, with imposter and port counts |
| `GET` | `/info` | Server info, the protocols available, configuration and feature flags |

### Imposters

| Method | Path | Description |
|---|---|---|
| `POST` | `/imposters` | Create an imposter (stopped) |
| `GET` | `/imposters` | List imposters. Query: `limit` (default `50`), `offset`, `status`, `protocol` |
| `GET` | `/imposters/:id` | One imposter |
| `PATCH` | `/imposters/:id` | Update `name`, `status` (`"running"` / `"stopped"`), `port`, `proxy` |
| `DELETE` | `/imposters/:id` | Delete an imposter. A running one needs `?force=true` |

### Stubs

| Method | Path | Description |
|---|---|---|
| `POST` | `/imposters/:id/stubs` | Add a stub |
| `GET` | `/imposters/:id/stubs` | List stubs, in matching order |
| `PUT` | `/imposters/:id/stubs/:stubId` | Update a stub |
| `DELETE` | `/imposters/:id/stubs/:stubId` | Delete a stub |

### Requests and stats

| Method | Path | Description |
|---|---|---|
| `GET` | `/imposters/:id/requests` | Captured requests. Query: `limit`, `method`, `path`, `status` |
| `DELETE` | `/imposters/:id/requests` | Clear captured requests |
| `GET` | `/imposters/:id/stats` | Statistics |
| `DELETE` | `/imposters/:id/stats` | Reset statistics |

## Creating an imposter

| Field | Default | Description |
|---|---|---|
| `port` | allocated from `3000` to `4000` | `1024` to `65535` |
| `name` | the generated id | |
| `protocol` | `"HTTP"` | Or an extension protocol: `"S3"` |
| `proxy` | none | A [proxy](../proxy/), HTTP imposters only |

```bash
curl -X POST http://localhost:2525/imposters \
  -H "Content-Type: application/json" \
  -d '{"name": "users-api", "port": 3000}'
```

```json
{"id":"6ad977d0","name":"users-api","port":3000,"protocol":"HTTP","status":"stopped","endpointCount":0,"createdAt":"2026-10-01T21:18:10.878Z","adminUrl":"http://localhost:3000","adminPath":"/_admin","uptime":"0"}
```

`PATCH` with `{"status": "running"}` returns once the port is bound; with `{"status": "stopped"}`, once it is released.

## Errors

Errors are JSON with a `_tag`. A body that fails validation is a `400` that says what was rejected:

```json
{"_tag":"HttpApiDecodeError","kind":"Payload","message":"Expected a value between 1024 and 65535\n  at [\"port\"]","issues":[{"path":["port"],"message":"Expected a value between 1024 and 65535"}]}
```

Other examples:

```json
{"_tag":"ApiConflictError","message":"Port 4000 is already allocated"}
```

```json
{"_tag":"ApiBadRequestError","message":"Unknown protocol \"FTP\". Available: HTTP, S3"}
```

```json
{"_tag":"ApiConflictError","message":"Imposter is running, use force=true to delete"}
```

## From TypeScript

The [typed client](../client/) is generated from the same API definition, so its methods and types follow these endpoints.
