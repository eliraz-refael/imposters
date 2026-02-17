# Imposters

A modern service virtualization tool built with TypeScript and [Effect](https://effect.website). Create mock HTTP services for testing and development — a lightweight, programmable alternative to [Mountebank](http://www.mbtest.org/).

## What is Imposters?

Imposters lets you spin up fake HTTP servers ("imposters") that respond to requests based on configurable stubs. Each imposter listens on its own port and matches incoming requests against predicates, returning templated responses. Use it to isolate services in integration tests, prototype APIs, or simulate third-party dependencies.

## Features

- **Stub matching** — Match requests by method, path, headers, query params, or body using operators like `equals`, `contains`, `startsWith`, `matches`, and `exists`
- **Response templates** — Use `{{key}}` for simple substitution or `${expr}` for JSONata expressions that reference the incoming request
- **Multiple responses** — Cycle through responses sequentially, randomly, or repeat the last one
- **Proxy mode** — Passthrough to a real service or record responses as stubs
- **Per-imposter admin UI** — HTMX-powered UI at each imposter's `/_admin` path
- **Admin dashboard** — Global dashboard at `/_ui` on the admin port
- **Config file support** — Declare imposters and stubs in a JSON file for repeatable setups
- **TypeScript client** — Programmatic client and test helpers built on `@effect/platform`
- **Request logging** — Inspect captured requests per imposter with stats and percentile metrics
- **Built on Effect** — Fiber-based concurrency, typed errors, and composable services

## Quick Start

```bash
# Install dependencies
bun install

# Start the admin server on the default port (2525)
bun tsx src/Program.ts start

# Create an imposter
curl -X POST http://localhost:2525/imposters \
  -H "Content-Type: application/json" \
  -d '{"name": "users-api", "port": 3000}'

# Add a stub
curl -X POST http://localhost:2525/imposters/<id>/stubs \
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

# Start the imposter
curl -X PATCH http://localhost:2525/imposters/<id> \
  -H "Content-Type: application/json" \
  -d '{"status": "running"}'

# Hit your mock
curl http://localhost:3000/users/1
# => {"id":1,"name":"Alice"}
```

## CLI Usage

```bash
imposters start [options]
```

| Option | Alias | Description |
|---|---|---|
| `--port <number>` | `-p` | Admin server port (default: `2525`, or `ADMIN_PORT` env var) |
| `--config <path>` | `-c` | Path to a JSON config file |

## Config File

Declare imposters and stubs declaratively. Pass the file with `--config`:

```json
{
  "admin": {
    "port": 2525,
    "portRangeMin": 3000,
    "portRangeMax": 4000,
    "maxImposters": 100,
    "logLevel": "info"
  },
  "imposters": [
    {
      "name": "users-api",
      "port": 3000,
      "stubs": [
        {
          "predicates": [
            { "field": "path", "operator": "equals", "value": "/health" }
          ],
          "responses": [
            { "status": 200, "body": { "status": "ok" } }
          ]
        }
      ]
    }
  ]
}
```

## API Reference

### System

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check with system info |
| `GET` | `/info` | Server info, configuration, and feature flags |

### Imposters

| Method | Path | Description |
|---|---|---|
| `POST` | `/imposters` | Create an imposter |
| `GET` | `/imposters` | List imposters (supports `status` and `protocol` filters) |
| `GET` | `/imposters/:id` | Get imposter details |
| `PATCH` | `/imposters/:id` | Update imposter (name, status, port, proxy) |
| `DELETE` | `/imposters/:id` | Delete imposter (`?force=true` to skip confirmation) |

### Stubs

| Method | Path | Description |
|---|---|---|
| `POST` | `/imposters/:id/stubs` | Add a stub |
| `GET` | `/imposters/:id/stubs` | List stubs |
| `PUT` | `/imposters/:id/stubs/:stubId` | Update a stub |
| `DELETE` | `/imposters/:id/stubs/:stubId` | Delete a stub |

### Requests & Stats

| Method | Path | Description |
|---|---|---|
| `GET` | `/imposters/:id/requests` | List captured requests |
| `DELETE` | `/imposters/:id/requests` | Clear captured requests |
| `GET` | `/imposters/:id/stats` | Get imposter statistics |
| `DELETE` | `/imposters/:id/stats` | Reset imposter statistics |

## Stub Matching

Each stub has an array of **predicates** that are AND-combined. A request matches a stub when all predicates pass. Stubs are evaluated in order — the first match wins.

### Predicate fields

`method` | `path` | `headers` | `query` | `body`

### Operators

| Operator | Description |
|---|---|
| `equals` | Exact match (deep subset match for objects/body) |
| `contains` | Substring match |
| `startsWith` | Prefix match |
| `matches` | Regular expression match |
| `exists` | Field is present (ignores `value`) |

All operators support `caseSensitive` (default: `true`).

### Examples

```json
// Match GET requests to any path starting with /api/
{
  "predicates": [
    { "field": "method", "operator": "equals", "value": "GET" },
    { "field": "path", "operator": "startsWith", "value": "/api/" }
  ],
  "responses": [{ "status": 200, "body": { "ok": true } }]
}
```

```json
// Match requests with a specific header
{
  "predicates": [
    { "field": "headers", "operator": "exists", "value": { "authorization": "" } }
  ],
  "responses": [{ "status": 200 }]
}
```

```json
// Match POST with a JSON body subset
{
  "predicates": [
    { "field": "method", "operator": "equals", "value": "POST" },
    { "field": "body", "operator": "equals", "value": { "action": "create" } }
  ],
  "responses": [{ "status": 201 }]
}
```

## Response Templates

Response bodies support two kinds of dynamic substitution:

### `{{key}}` — Simple substitution

Reference flattened request context values:

```json
{
  "responses": [{
    "body": {
      "echo": "You requested {{request.path}} with method {{request.method}}",
      "token": "{{request.headers.authorization}}",
      "search": "{{request.query.q}}"
    }
  }]
}
```

Available keys follow the pattern `request.method`, `request.path`, `request.headers.<name>`, `request.query.<name>`, and `request.body.<path>` for nested body fields.

### `${expr}` — JSONata expressions

Use [JSONata](https://jsonata.org/) for computed values. The expression context is `{ request: { method, path, headers, query, body } }`.

```json
{
  "responses": [{
    "body": {
      "greeting": "${\"Hello, \" & request.query.name}",
      "itemCount": "${$count(request.body.items)}",
      "uppercasePath": "${$uppercase(request.path)}"
    }
  }]
}
```

If an entire string is a single `${...}` expression, the raw result type is preserved (number, object, etc.). When mixed with other text, results are concatenated as strings.

## Proxy Mode

Configure an imposter to forward unmatched requests to a real backend.

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

### Modes

| Mode | Description |
|---|---|
| `passthrough` | Forward requests to the target and return the response as-is |
| `record` | Forward requests and automatically save responses as new stubs |

### Proxy options

| Option | Default | Description |
|---|---|---|
| `targetUrl` | *(required)* | Target base URL |
| `mode` | `passthrough` | `passthrough` or `record` |
| `addHeaders` | — | Headers to add to proxied requests |
| `removeHeaders` | `[]` | Headers to strip before proxying |
| `followRedirects` | `true` | Follow HTTP redirects |
| `timeout` | `10000` | Request timeout in milliseconds (100–60000) |

## Programmatic Usage

### TypeScript client

```typescript
import { ImpostersClientFetchLive, ImpostersClient } from "imposters/client"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const client = yield* ImpostersClient

  const imposter = yield* client.imposters.createImposter({
    payload: { name: "my-api", port: 4000, protocol: "HTTP", adminPath: "/_admin" }
  })

  yield* client.imposters.addStub({
    path: { imposterId: imposter.id },
    payload: {
      responses: [{ status: 200, body: { hello: "world" } }]
    }
  })

  yield* client.imposters.updateImposter({
    path: { id: imposter.id },
    payload: { status: "running" }
  })
})

program.pipe(
  Effect.provide(ImpostersClientFetchLive("http://localhost:2525")),
  Effect.runPromise
)
```

### Test helpers

The `withImposter` helper manages the lifecycle of a test imposter — create, configure stubs, start, run your test, then clean up:

```typescript
import { withImposter, makeTestServer } from "imposters/client"
import { Effect } from "effect"

const { clientLayer } = makeTestServer(FullLayer)

const test = withImposter(
  {
    port: 4001,
    name: "test-api",
    stubs: [{
      predicates: [
        { field: "path", operator: "equals", value: "/greet" }
      ],
      responses: [{ status: 200, body: { message: "hi" } }]
    }]
  },
  (ctx) =>
    Effect.gen(function*() {
      const res = yield* Effect.promise(() =>
        fetch(`http://localhost:${ctx.port}/greet`)
      )
      // assert on res...
    })
)

Effect.provide(test, clientLayer).pipe(Effect.runPromise)
```

## Admin UI

- **`/_ui`** on the admin port — Global dashboard showing all imposters
- **`/_admin`** on each imposter port — Per-imposter UI with stubs, captured requests, and stats

Both UIs are HTMX-powered and require no additional setup.

## Development

```bash
bun check          # Type check
bun run test       # Run tests (vitest)
bun lint           # Lint
bun lint-fix       # Lint with auto-fix
bun coverage       # Test coverage
```

## Architecture

Imposters is built entirely on [Effect](https://effect.website):

- **Effect services** — All components (`ImposterRepository`, `PortAllocator`, `ProxyService`, `MetricsService`, `RequestLogger`, `FiberManager`) are Effect services composed via layers
- **Fiber concurrency** — Each running imposter is managed as an Effect Fiber via `FiberMap`, allowing independent start/stop lifecycle
- **`@effect/platform` HTTP API** — Admin API is defined declaratively with `HttpApi`, `HttpApiGroup`, and `HttpApiEndpoint`, with schema-derived request validation and typed error handling
- **`@effect/cli`** — CLI commands and option parsing
- **Bun.serve()** — HTTP server runtime
- **JSONata** — Expression evaluation in response templates

## License

MIT
