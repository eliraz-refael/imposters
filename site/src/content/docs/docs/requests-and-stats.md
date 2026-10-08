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
      "proxied": false,
      "outcome": "stub",
      "responseIndex": 0
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
      "proxied": false,
      "outcome": "unmatched"
    },
    "duration": 0
  }
]
```

(Formatted here; the API answers compact JSON.)

Each entry records the request (method, path, headers, query and parsed body), the response (status, headers and body text), and the `duration` in milliseconds. `outcome` says what answered: `stub`, `extension`, `proxy` (also `proxied: true`) or `unmatched`. When a stub answered, `matchedStubId` names it and `responseIndex` says which of its responses it gave. When that response has [callbacks](../callbacks/), `callbacks` lists every call it made:

```json
"callbacks": [
  {"name":"cart","phase":"before","method":"GET","url":"http://127.0.0.1:3302/carts/7","state":"answered","status":200,"durationMs":5,"responseBody":"{\"items\":[{\"sku\":\"tea\",\"price\":4},{\"sku\":\"cake\",\"price\":6}]}"},
  {"name":"notify","phase":"after","method":"POST","url":"http://127.0.0.1:3304/events","state":"pending"}
]
```

An `after` call is logged `pending` and its record settles in place, to `answered`, `failed` or `skipped`, when the call ends. The log keeps the latest **100** requests per imposter, oldest first, and stores up to 10 KB of each response body.

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
{"totalRequests":5,"requestsPerMinute":4918.03,"averageResponseTime":0.4,"errorRate":0.4,"serverErrorRate":0,"requestsByMethod":{"POST":3,"GET":2},"requestsByStatusCode":{"200":1,"201":2,"402":1,"404":1},"lastRequestAt":"2026-10-01T21:17:47.562Z","p50ResponseTime":0,"p95ResponseTime":2,"p99ResponseTime":2,"timeline":[...],"last15Minutes":{"requests":5,"serverErrors":0,"unmatched":1},"stubs":[...],"unmatched":[...],"outbound":[]}
```

| Field | Meaning |
|---|---|
| `totalRequests` | Requests received |
| `requestsPerMinute` | The rate between the first and the latest request |
| `averageResponseTime`, `p50ResponseTime`, `p95ResponseTime`, `p99ResponseTime` | Response times in milliseconds |
| `errorRate` | The fraction of responses with a status of `400` or more |
| `serverErrorRate` | The fraction with a status of `500` or more |
| `requestsByMethod`, `requestsByStatusCode` | Counts |
| `lastRequestAt` | When the latest request arrived |
| `timeline`, `last15Minutes` | The last 15 minutes in 30 buckets of 30 seconds, oldest first, each with `requests`, `serverErrors` and `unmatched`; and their sum |
| `stubs` | One row per stub, in matching order: `hits`, `byResponse`, `lastHitAt`, and `nextResponseIndex` (absent in `random` mode) |
| `unmatched` | Requests nothing answered, grouped by method and path, most recently seen first; up to 50 groups |
| `outbound` | The calls the imposter made, its [callbacks](../callbacks/) and [proxy](../proxy/) forwards, one edge per target host; see below |

### Outbound calls

Each edge counts the calls sent to one host:

```json
"outbound": [
  {"host":"127.0.0.1:3303","via":"callback","calls":1,"failed":0,"serverErrors":0,"lastAt":"2026-10-08T09:02:45.659Z","p50":97,"p95":97,"timeline":[...]}
]
```

`via` is `callback`, `proxy` or `both`. `failed` counts calls that got no answer (a timeout, a refused connection) and calls refused because 64 were already in flight; `serverErrors` counts `5xx` answers. `p50` and `p95` are in milliseconds, over the last 128 calls sent, and `timeline` has 30 buckets of `calls` and `failed`. A call refused at the [hop limit](../callbacks/#loops) was never sent and is not counted. Up to 50 hosts are kept, most recently called first.

`DELETE /imposters/:id/stats` resets them.

Both are also shown in the imposter's [web UI](../web-ui/).
