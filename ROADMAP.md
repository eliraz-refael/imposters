# Imposters — Development Roadmap

> **Status as of 2026-08-30:** Phases 0–5 are complete and shipped. The package is published on npm as `imposters` v0.2.4. Phase 6 is partially delivered. See [Phase 6](#phase-6-advanced-features) for what remains.

## Context

**Imposters** is a service virtualization tool replacing the abandoned Mountebank. It uses TypeScript + Effect, leveraging Effect's Fiber concurrency to spawn mock HTTP servers at runtime. Each imposter runs on its own port as a Fiber, is configurable via a central admin REST API, and serves its own HTMX-based configuration UI.

**Key decisions (as built):**
- **Runtime:** Node.js by default, Bun optional — selected via `--runtime node|bun`, abstracted behind a `ServerFactory` tag. (Originally planned as Bun-only; changed in Phase 6 so the published npm package runs anywhere.)
- **UI:** HTMX + server-rendered HTML, per imposter and globally
- **Protocol:** HTTP built in; other protocols plug in as imposter extensions (`src/extensions/`). S3 is the first
- **API:** Clean new design; Mountebank adapter remains a future add-on

---

## Code Standards

These rules apply across ALL phases:

1. **No `any` type.** Every value must be properly typed. Use `unknown` when the type is genuinely unknown, then narrow with Schema validation or type guards.
2. **No type-casting** (`as`, `!`, `<Type>`). If the type system can't prove it, restructure the code or use Schema decoding. The only exception is the rare case where Effect APIs genuinely require it (and those should be commented with why).
3. **Errors:** `Data.TaggedError` for domain errors; `Schema.TaggedError` for API errors (required for `HttpApi` status annotations).
4. **Services:** class-based `Context.Tag` pattern: `class Foo extends Context.Tag("Foo")<Foo, { ... }>() {}`
5. **Purity:** No `new Date()` in domain code — use Effect's `Clock`/`DateTime`. No side effects outside `Effect`.
6. **Schema-first:** All validation through Effect Schema. No manual parsing or unsafe `.make()` calls.

### Outstanding violations

Standards 1 and 2 have one known breach that should be repaid:

| Location | Issue |
|---|---|
| `src/ui/admin/AdminUiRouter.ts:16` | `toAdminData = (imp: any)` — needs a real parameter type |

Plus ~4 non-null assertions (`UiRouter.ts:30`, `ImposterRepository.ts:119`, `RequestLogger.ts:48`, `ImposterServer.ts` response indexing).

---

## Architecture as built

```
                    ┌────────────────────────────┐
                    │      Admin Server          │
                    │      (port 2525)           │
                    │  HttpApi + Swagger + /_ui  │
                    └─────────────┬──────────────┘
                                  │ FiberManager (FiberMap)
              ┌───────────────────┼───────────────────┐
       ┌──────▼──────┐     ┌──────▼──────┐     ┌──────▼──────┐
       │ Imposter A  │     │ Imposter B  │     │ Imposter C  │
       │ (port 3001) │     │ (port 3002) │     │ (port 3003) │
       │ Fiber       │     │             │     │             │
       │ ├ /_admin UI│     │  ...stubs   │     │  ...stubs   │
       │ ├ stubs     │     │             │     │             │
       │ └ proxy?    │     │             │     │             │
       └─────────────┘     └─────────────┘     └─────────────┘
```

### Where the implementation diverged from the original plan

These are deliberate changes, not drift. Anyone reading the older plan should note them:

| Planned | Built | Why |
|---|---|---|
| Imposter routing via `HttpRouter` + a `RouterBuilder` module converting `Stub[]` → router | **No `HttpRouter` anywhere.** Each imposter's handler is a plain `async (request: Request) => Response` doing linear predicate matching over `Ref<ReadonlyArray<Stub>>` | Routes are runtime-configured, so a typed router adds no value; linear matching makes hot-reload a single `Ref.set` |
| Hot-reload by swapping `Ref<HttpRouter>` | Hot-reload by swapping `Ref<ReadonlyArray<Stub>>` and `Ref<ProxyConfig \| undefined>` | Follows from the above |
| Bun-only, `Bun.serve()` throughout | `ServerFactory` tag with `NodeServerFactoryLive` (default) and `BunServerFactoryLive` | vitest workers run under Node.js even when launched by Bun, so tests could not use `Bun.serve`. Became the `--runtime` flag and made the npm package portable |
| UI mounted via `HttpRouter.mount` at `/_admin` | Plain URL-prefix matcher returning `Response \| null`, tried before stub matching | No `HttpRouter` to mount into |
| `src/api/AdminHandlers.ts` | Split into `ImpostersHandlers.ts` + `SystemHandlers.ts`, with groups in `ImpostersGroup.ts` / `SystemGroup.ts` | Size |

---

## Data Model: Stubs & Predicates

The core abstraction is **stubs**, not simple routes. Each stub has:

- **Predicates:** An ordered list of request matchers (method, path, headers, query, body). Combined with AND logic. Operators: `equals`, `contains`, `startsWith`, `matches` (regex), `exists` — all supporting `caseSensitive`.
- **Responses:** An ordered list of response configs, selected by `responseMode`: `sequential` (round-robin), `random`, or `repeat`. Each response has status, headers, body, delay.
- **Template data:** Response bodies can reference `request.method`, `request.path`, `request.headers.*`, `request.query.*`, and `request.body.*`.

```
Imposter
  ├── Stubs[]
  │     ├── predicates: Predicate[]     (AND-combined matchers)
  │     └── responses: ResponseConfig[] (sequential | random | repeat)
  └── proxy?: { targetUrl, mode: passthrough | record, ... }
```

Stubs are evaluated in order; first match wins. An unmatched request falls through to the proxy if configured, otherwise 404.

---

## Phase 0: Cleanup & Foundation ✅ COMPLETE

Fixed bugs and removed dead artifacts from the original scaffold: deleted the stale Go/Effect-org CI workflows, removed `endpoint.ts` and `isValidPath.ts`, de-duplicated the UUID service, migrated errors to `Data.TaggedError`, replaced `new Date()` with Effect time, standardized on `Schema.decodeUnknown`, and switched CI to Bun on `master`.

---

## Phase 1: Core Services & Infrastructure ✅ COMPLETE

Stub/predicate schemas (`StubSchema.ts`) designed upfront, plus `UuidLive`, `AppConfig` (env-driven via `Effect.Config`: admin port 2525, port range 3000–4000, max 100 imposters), `PortAllocator` (TOCTOU-safe with bind-failure recovery), `ImposterRepository` (pure `Ref<HashMap>` storage), and `MainLayer` composition.

---

## Phase 2: Admin REST API ✅ COMPLETE

`HttpApi.make("admin")` composing `ImpostersGroup` and `SystemGroup` (the latter `topLevel: true`). OpenAPI middleware + Swagger UI wired in `ApiLayer.ts`. Endpoints:

```
GET    /health                                    GET    /info
POST   /imposters                                 GET    /imposters
GET    /imposters/:id                             PATCH  /imposters/:id
DELETE /imposters/:id
POST   /imposters/:imposterId/stubs               GET    /imposters/:imposterId/stubs
PUT    /imposters/:imposterId/stubs/:stubId       DELETE /imposters/:imposterId/stubs/:stubId
GET    /imposters/:id/requests                    DELETE /imposters/:id/requests
GET    /imposters/:id/stats                       DELETE /imposters/:id/stats
```

---

## Phase 3: Imposter Runtime + Route Matching ✅ COMPLETE

`ImposterServer` exposes `start`/`stop`/`updateStubs`/`updateProxyConfig`/`isRunning`. Fibers are managed by `FiberManager` (a `FiberMap` wrapper); each server instance is wrapped in `Effect.acquireRelease` so interruption stops the server and frees the port. `RequestMatcher` evaluates predicates; `ResponseGenerator` selects and builds responses with delays and templating. Hot-reload works via `Ref` swap with zero downtime.

---

## Phase 4: Client Library & Developer Experience ✅ COMPLETE

Typed `ImpostersClient` derived from the `HttpApi` definition, `HandlerHttpClient` for in-process (socket-free) testing, `withImposter` / `makeTestServer` helpers, and JSON config-file loading (`ConfigFileSchema` + `ConfigLoader`) for declarative setup.

---

## Phase 5: Configuration UIs ✅ COMPLETE

Tagged-template HTML engine with auto-escaping (`ui/html.ts`), HTMX from CDN. Per-imposter UI at `/_admin` (dashboard, stubs, requests, request detail) and a global dashboard at `/_ui` on the admin port. Backed by `RequestLogger` (bounded per-imposter buffer + `PubSub` for future SSE) and `MetricsService` (counts, percentiles, error rate).

---

## Phase 6: Advanced Features

**Delivered:**

| Feature | Notes |
|---|---|
| ✅ **CLI** | `@effect/cli`. `imposters start` with `--port/-p`, `--config/-c`, `--runtime node\|bun`. Published to npm with a `bin` entry |
| ✅ **Dynamic Response Injection** | JSONata via `${expr}`, alongside `{{key}}` substitution |
| ✅ **Proxy Mode** | `passthrough` and `record` (records live responses as new stubs, hot-reloading them in) |
| ✅ **Statistics** | Per-imposter request counts, rate, average response time, error rate, breakdowns by method and status |
| ✅ **npm publishing** | Automated release from `master`: conventional-commit version bump, OIDC/provenance publish, git tag, GitHub release |
| ✅ **Imposter extensions** | Pluggable non-HTTP protocols behind stub matching (#22) |
| ✅ **S3 emulator** | In-memory S3 extension (`"protocol": "S3"`) for the AWS SDK, path-style. Scope trims are 501s, listed in the backlog below |

**Remaining, roughly in priority order:**

| Feature | Description |
|---|---|
| **Persistence** | Imposters are in-memory only and do not survive a restart. Save/restore configs to disk via `@effect/platform` `FileSystem`. This is the biggest functional gap |
| **Request Recording export/import** | Export recorded requests as JSON and re-import to generate stubs. Proxy `record` mode covers the capture half already |
| **Mountebank Adapter** | Accept Mountebank-format JSON configs; translation layer for predicates/responses |
| **OpenAPI Import** | Parse OpenAPI 3.x specs to auto-generate imposters + stubs |
| **WebSocket Mocking** | Mock WebSocket endpoints with configurable message sequences |
| **Multi-protocol** | gRPC, TCP as further imposter extensions |

---

## Maintenance backlog

Non-feature work that is currently outstanding:

- **Repay the `any` / non-null-assertion debt** listed under [Code Standards](#code-standards).
- **Proxy `record` mode corrupts binary responses.** `recordAsStub` reads the upstream response as text, and stub bodies can only hold JSON or text, so a recorded image replays corrupted. Passthrough is byte-exact since #20. Needs binary stub bodies (e.g. base64 plus a flag) in the stub schema.
- **S3: three bucket-configuration PUTs answer 501.** `?publicAccessBlock`, `?encryption` and `?lifecycle` (neeo's provisioning reports them as unsupported locally), plus `?cors`, versioning `PUT` and the rest. Accepting and echoing them (GET after PUT) would let provisioning apply every setting locally.
- **S3: `?policy` and `?ownershipControls` PUTs are accepted but not enforced.** They answer 204 / 200 on an existing bucket and are discarded: no GET-back, and a policy never denies a request.
- **S3: `aws-chunked` / `STREAMING-*` bodies answer 501.** SDK 3.1131.0 sends a `Uint8Array` PutObject as a plain signed payload (verified in `test/e2e/s3.test.ts`), but stream bodies and unknown-length uploads use aws-chunked encoding with trailing checksums. Needs a chunk decoder that strips the chunk framing before storing.
- **Pass the raw request path to extensions so S3 keys with dot segments survive.** The WHATWG `URL` parse in the Node server resolves `.` / `..` (and `%2e`) segments before `RequestContext` is built, so `DELETE /b/k/..` reaches S3 as DeleteBucket. Needs the core to carry the raw path in `RequestContext`.
- **Advertise the bind address in imposter URLs.** `adminUrl` (`src/api/Conversions.ts`) and the admin dashboard's "Open UI" link (`src/ui/admin/partials.ts`) are hard-coded to `http://localhost:<port>`. With `--host` set to one specific non-loopback address, both point at an address nothing listens on. Needs the bind host passed into the API conversions and the admin UI.
- **S3: ListObjectsV2 pagination and `delimiter` answer 501.** A listing longer than `max-keys` (capped at 1000) is refused rather than truncated; `continuation-token`, `start-after` and `delimiter` / `CommonPrefixes` are not implemented.
- **Binary stubs for proxy record mode** (the record-mode item above): a recorded stub cannot hold binary bytes, which also rules out recording S3 GetObject answers as stubs.
- **`--runtime bun` only applies to the admin server.** `MainLayer` hard-codes `NodeServerFactoryLive` for imposters, so under Bun they run on Bun's `node:http` compatibility layer.
- **Type errors can slip through the `start` command handler.** `yield*` inside the `Command.make` handler in `src/cli/Commands.ts` infers loosely: changing `ServerFactory.create`'s signature did not flag a stale `.port` access there.
- **Drop the TypeScript 6 alias** once typescript-eslint supports the TS 7.1 API (typescript-eslint #10940); see CLAUDE.md "Two TypeScript installs".
- **Bump the exact Effect 4 RC pins** once Effect 4 stable ships. Re-diff the APIs first, since renames still land between RCs.

### Recently completed

- In-memory S3 emulator shipped as the first imposter extension, verified against `@aws-sdk/client-s3` 3.1131.0.
- Imposter extensions: pluggable non-HTTP protocols, terminal after stub matching (#22).
- Server lifecycle is synchronised: `ImposterServer.start` resolves once the port is bound (a bind failure returns 409), and `stop` once it is released. The fixed test sleeps and `fileParallelism: false` are gone, so the suite dropped from ~26s to ~3s.
- Request and response bodies are byte-exact end to end, and stubs returning 204/205/304 no longer become a 500 (#20).
- Effect 4 RC and vitest 5 (#19), bun 1.4.2 (#18), TypeScript 7 alongside TypeScript 6 (#17).
- GitHub release for v0.2.3 backfilled; the release step that failed in March is fixed (#15) and verified by the v0.2.4 publish.
- CI actions moved off deprecated Node 20 (`actions/checkout` and `actions/setup-node` → v7).
- bun aligned at 1.3.13 across local and CI; nixpkgs pinned instead of tracking `master`.
- TypeScript 5.9.3 → 6.0.3, typescript-eslint 8.46 → 8.67, vitest 2.1.9 → 3.2.7.

---

## Verification Strategy

Every change must pass:

1. **`bun check`** — zero type errors
2. **`bun run test`** — vitest, single-run (currently 558 tests across 51 files, ~4s; files run in parallel)
3. **`bun lint`** — no violations
4. **E2E tests** — `test/e2e/` covers lifecycle, stub matching, hot-reload, proxy mode, request logging, request inspector, statistics, expression templates, extensions, the S3 emulator (with the real AWS SDK), and both UIs

Note: `bun test` (Bun's native runner) is not the same as `bun run test` (vitest). Use the latter.
