---
title: Request log and stats
description: See every request an imposter received, which stub answered it, and its traffic statistics.
---

Every imposter records the requests it receives and keeps running statistics. Both are in memory, per imposter.

## Request log

```bash
curl "http://localhost:2525/imposters/2f334551/requests?limit=2"
```

```json
[
  {
    "id": "2b19816a-ce7d-47d6-91d2-636ff010de30",
    "imposterId": "2f334551",
    "timestamp": "2026-10-01T21:17:47.547Z",
    "request": {
      "method": "GET",
      "path": "/customers/42",
      "headers": { "accept": "*/*", "host": "localhost:4000", "user-agent": "curl/8.7.1" },
      "query": {},
      "body": null
    },
    "response": {
      "status": 200,
      "headers": { "content-type": "application/json", "x-served-by": "imposters" },
      "body": "{\"path\":\"/customers/42\",\"plan\":\"pro\"}",
      "matchedStubId": "7a1d5d07",
      "proxied": false
    },
    "duration": 0
  },
  {
    "id": "315e7518-8da2-4562-8c4d-6a7a412b6a9f",
    "imposterId": "2f334551",
    "timestamp": "2026-10-01T21:17:47.562Z",
    "request": {
      "method": "GET",
      "path": "/refunds",
      "headers": { "accept": "*/*", "host": "localhost:4000", "user-agent": "curl/8.7.1" },
      "query": {},
      "body": null
    },
    "response": {
      "status": 404,
      "headers": { "content-type": "application/json" },
      "body": "{\"error\":\"No matching stub found\",\"method\":\"GET\",\"path\":\"/refunds\"}",
      "proxied": false
    },
    "duration": 0
  }
]
```

(Formatted here; the API answers compact JSON.)

Each entry records the request (method, path, headers, query and parsed body), the response (status, headers and body text), `matchedStubId` when a stub answered, `proxied` when the [proxy](../proxy/) did, and the `duration` in milliseconds. The log keeps the latest **100** requests per imposter, oldest first, and stores up to 10 KB of each response body.

### Filters

| Query parameter | Default | Description |
|---|---|---|
| `limit` | `50` | The latest N matching entries |
| `method` | none | Only this method (any case) |
| `path` | none | Only this exact path |
| `status` | none | Only this response status |

```bash
curl "http://localhost:2525/imposters/2f334551/requests?status=404"
```

`DELETE /imposters/:id/requests` clears the log.

## Stats

```bash
curl http://localhost:2525/imposters/2f334551/stats
```

```json
{"totalRequests":5,"requestsPerMinute":4918.03,"averageResponseTime":0.4,"errorRate":0.4,"requestsByMethod":{"POST":3,"GET":2},"requestsByStatusCode":{"200":1,"201":2,"402":1,"404":1},"lastRequestAt":"2026-10-01T21:17:47.562Z","p50ResponseTime":0,"p95ResponseTime":2,"p99ResponseTime":2}
```

| Field | Meaning |
|---|---|
| `totalRequests` | Requests received |
| `requestsPerMinute` | The rate between the first and the latest request |
| `averageResponseTime`, `p50ResponseTime`, `p95ResponseTime`, `p99ResponseTime` | Response times in milliseconds |
| `errorRate` | The fraction of responses with a status of `400` or more |
| `requestsByMethod`, `requestsByStatusCode` | Counts |
| `lastRequestAt` | When the latest request arrived |

`DELETE /imposters/:id/stats` resets them.

Both are also shown in the imposter's [web UI](../web-ui/).
