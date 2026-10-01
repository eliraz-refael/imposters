---
title: Proxy and record
description: Forward unmatched requests to a real service, and record its answers as stubs.
---

An HTTP imposter with a `proxy` forwards every request that no stub matches to a real service. Stubs still answer first, so you can override a few endpoints and pass the rest through.

```json
{
  "name": "proxied-api",
  "port": 3000,
  "proxy": {
    "targetUrl": "https://api.example.com",
    "mode": "passthrough"
  }
}
```

The forwarded request keeps the method, path, query string, body and headers, except `host` and the other hop-by-hop headers. `GET /v1/users?page=2` on the imposter goes to `https://api.example.com/v1/users?page=2`.

## Modes

| Mode | Behaviour |
|---|---|
| `passthrough` (default) | Forward the request and return the answer as-is |
| `record` | Forward the request, return the answer, and save it as a new stub |

### Record

In `record` mode, each answer below `500` becomes a stub that matches the same method and path, added at the end of the stub list. The next identical request is answered locally, without reaching the target.

```bash
curl -X POST http://localhost:2525/imposters \
  -H "Content-Type: application/json" \
  -d '{"name": "recorder", "port": 4001, "proxy": {"targetUrl": "http://127.0.0.1:4000", "mode": "record"}}'
```

After starting it and requesting `GET /customers/7` once, its stubs hold the recording:

```json
[{"id":"0027d88d","predicates":[{"field":"method","operator":"equals","value":"GET","caseSensitive":true},{"field":"path","operator":"equals","value":"/customers/7","caseSensitive":true}],"responses":[{"status":200,"headers":{"connection":"keep-alive","content-type":"application/json","date":"Thu, 01 Oct 2026 21:18:17 GMT","keep-alive":"timeout=5","transfer-encoding":"chunked"},"body":{"path":"/customers/7","plan":"enterprise"}}],"responseMode":"sequential"}]
```

The recorded stub matches method and path only, not the query string, headers or body. A JSON answer is stored as JSON, anything else as text. Edit or delete recorded stubs like any other; to freeze the recording, remove the proxy by sending `{"proxy": null}` to `PATCH /imposters/:id`.

## Options

| Option | Default | Description |
|---|---|---|
| `targetUrl` | *(required)* | The target's base URL, starting with `http://` or `https://` |
| `mode` | `passthrough` | `passthrough` or `record` |
| `addHeaders` | none | Headers to set on the forwarded request |
| `removeHeaders` | `[]` | Headers to remove from the forwarded request |
| `followRedirects` | `true` | Follow redirects from the target |
| `timeout` | `10000` | Milliseconds to wait for the target, `100` to `60000` |

If the target cannot be reached or times out, the imposter answers `502` with `{"error": "Proxy failed", "target": ..., "reason": ...}`.

## Changing the proxy

`PATCH /imposters/:id` with a `proxy` object sets or replaces it, and `"proxy": null` removes it. On a running imposter the change takes effect on the next request. A proxy is for HTTP imposters only: setting one on an extension protocol such as S3 is a `400`.
