# Imposters - Comprehensive Development Roadmap

## Context

**Imposters** is a service virtualization tool replacing the abandoned Mountebank. It uses TypeScript + Effect, leveraging Effect's Fiber concurrency to spawn mock HTTP servers at runtime. Each imposter runs on its own port as a Fiber, is configurable via a central admin REST API, and serves its own HTMX-based configuration UI.

**Current state:** Early scaffolding on the `port-to-effect` branch. Domain models, schemas, and a UUID service contract exist but have quality issues (duplicate service definitions, bugs in endpoint.ts, no actual server). CI workflows are misaligned (leftover Go pipelines, pnpm instead of Bun).

**Key decisions:**
- **Runtime:** Bun only (`Bun.serve()` + `HttpApp.toWebHandlerRuntime`)
- **UI:** HTMX + server-rendered HTML per imposter
- **Protocol:** HTTP first, architecture open for future GRPC/WS
- **API:** Clean new design; Mountebank adapter as a future add-on

---

## Code Standards

These rules apply across ALL phases:

1. **No `any` type.** Every value must be properly typed. Use `unknown` when the type is genuinely unknown, then narrow with Schema validation or type guards.
2. **No type-casting** (`as`, `!`, `<Type>`). If the type system can't prove it, restructure the code or use Schema decoding. The only exception is the rare case where Effect APIs genuinely require it (and those should be commented with why).
3. **Errors:** Use `Data.TaggedError` (not `Data.tagged`) for all error types — gives proper stack traces and enables `catchTag`.
4. **Services:** Use the class-based `Context.Tag` pattern consistently: `class Foo extends Context.Tag("Foo")<Foo, { ... }>() {}`
5. **Purity:** No `new Date()` in domain code — use Effect's `Clock` service. No side effects outside `Effect`.
6. **Schema-first:** All validation through Effect Schema. No manual parsing or unsafe `.make()` calls.

---

## Architecture Overview

```
                        ┌─────────────────────┐
                        │    Admin Server      │
                        │   (port 2525)        │
                        │  HttpApi + OpenAPI   │
                        └────────┬────────────┘
                                 │ manages via FiberMap
                 ┌───────────────┼───────────────┐
                 │               │               │
          ┌──────▼──────┐ ┌─────▼───────┐ ┌─────▼───────┐
          │ Imposter A  │ │ Imposter B  │ │ Imposter C  │
          │ (port 3001) │ │ (port 3002) │ │ (port 3003) │
          │ Fiber + Bun │ │ Fiber + Bun │ │ Fiber + Bun │
          │ ┌─────────┐ │ │             │ │             │
          │ │ Mock     │ │ │  ...stubs   │ │  ...stubs   │
          │ │ Stubs    │ │ │             │ │             │
          │ ├─────────┤ │ │             │ │             │
          │ │ HTMX UI │ │ │             │ │             │
          │ │ /_admin  │ │ │             │ │             │
          │ └─────────┘ │ │             │ │             │
          └─────────────┘ └─────────────┘ └─────────────┘
```

### Key architectural patterns

- **Admin server:** Uses `HttpApi` + `HttpApiBuilder.toWebHandler` (static, typed API)
- **Imposter servers:** Uses `HttpRouter` + `HttpApp.toWebHandlerRuntime` (dynamic, runtime-built routes). NOT `HttpApi` — imposter routes are user-configured at runtime, not compile-time typed.
- **Fiber lifecycle:** `FiberMap<ImposterId>` (built-in Effect module) manages all imposter fibers. Automatic interrupt-on-rekey, cleanup on scope close.
- **Server lifecycle:** `Effect.acquireRelease` for each `Bun.serve()` instance — ensures `server.stop()` on fiber interrupt.
- **Hot-reload:** Each imposter holds a `Ref<HttpRouter>`. Route changes rebuild the router and atomically swap via `Ref.set`. The fetch handler reads from the `Ref` on every request. Zero downtime.
- **Repository:** Pure config storage only (imposter config + stubs). No fiber/server refs — those live in `FiberMap`.

---

## Data Model: Stubs & Predicates

A critical design insight from Mountebank: the core abstraction is **stubs**, not simple routes. Each stub has:

- **Predicates:** An ordered list of request matchers (method, path, headers, query, body). Combined with AND logic. Support for `equals`, `contains`, `startsWith`, `matches` (regex), `exists`.
- **Responses:** An ordered list of response configs. Cycled through in order (round-robin by default). Each response has status, headers, body, delay.
- **Template data:** Response bodies can reference request data — not just path params, but also `request.headers`, `request.query`, `request.body`, `request.path`.

This model must be designed upfront in the schemas to avoid breaking API changes later.

```
Imposter
  └── Stubs[]
        ├── predicates: Predicate[]     (AND-combined matchers)
        │     ├── method: equals "GET"
        │     ├── path: matches "/users/:id"
        │     └── headers: contains { "accept": "application/json" }
        └── responses: ResponseConfig[] (cycled round-robin)
              ├── { status: 200, body: {"id": "{{request.params.id}}"} }
              └── { status: 500, body: {"error": "intermittent failure"} }
```

---

## Phase 0: Cleanup & Foundation ✅ COMPLETE

**Goal:** Fix bugs, remove dead artifacts, establish clean baseline. Keep it tight — don't refactor code that later phases will rewrite.

### Changes

1. ✅ **Fix `package.json`** — rename from `@template/basic` to `imposters`, add `bin` field for future `npx imposters` support
2. ✅ **Fix `vitest.config.ts`** — update `@template/basic` alias
3. ✅ **Delete stale CI workflows:**
   - `.github/workflows/test.yaml` (Go pipeline)
   - `.github/workflows/release.yaml` (Go binary release)
   - `.github/workflows/snapshot.yml` (Effect-Ts org specific)
4. ✅ **Fix `.github/workflows/check.yml`** and `.github/actions/setup/` — use Bun, target `master`
5. ✅ **`src/domain/imposter.ts`:**
   - Remove duplicate `UuidService` interface/tag — import from `src/services/Uuid.ts`
   - Replace `new Date()` with Effect `Clock`
   - Migrate errors to `Data.TaggedError`
6. ✅ **Delete `src/domain/endpoint.ts`** entirely — it misuses `HttpApiEndpoint` for dynamic mock routes. Will be replaced by `HttpRouter.makeRoute` in Phase 3.
7. ✅ **`src/domain/route.ts`:**
   - Standardize to `Schema.decodeUnknown` (returns Effect, not Either)
   - Replace `new Date()` with Clock
   - Migrate errors to `Data.TaggedError`
8. ✅ **`src/schemas/ImposterSchema.ts`:**
   - Fix unsafe `.make()` calls — use Schema encoding instead
   - Add route API schemas: `CreateRouteRequest`, `RouteResponse`, `ListRoutesResponse`
   - Add `UpdateImposterRequest` fields for `port` and `adminPath`
9. ✅ **`src/schemas/common.ts`:**
   - Remove GRPC from `Protocol` enum (HTTP only for now)
   - Fix `currentDateTime` helper
10. ✅ **Delete `src/domain/isValidPath.ts`** (empty placeholder)
11. ✅ **Write unit tests** for domain models and schemas
12. ✅ **Audit all code for `any` and type-casts** — remove them

### Files deleted
- `.github/workflows/test.yaml`, `.github/workflows/release.yaml`, `.github/workflows/snapshot.yml`
- `src/domain/isValidPath.ts`, `src/domain/endpoint.ts`

### Verification
- ✅ `bun check` passes with zero `any` types
- ✅ `bun run test` passes with real tests
- ✅ No duplicate service definitions, no `new Date()`, no type-casts
- ✅ CI runs on Bun

---

## Phase 1: Core Services & Infrastructure ✅ COMPLETE

**Goal:** Implement foundational Effect services and layers. Design the stub/predicate schemas upfront.

### 1.1 Stub & Predicate Schemas ✅

Implemented in `src/schemas/StubSchema.ts`:

```
PredicateOperator: "equals" | "contains" | "startsWith" | "matches" | "exists"
Predicate: { field, operator, value } — matches against method, path, headers, query, body
Stub: { predicates: Predicate[], responses: ResponseConfig[], responseMode: "sequential" | "random" | "repeat" }
ResponseConfig: { status, headers, body, delay }
```

Response templates can reference: `{{request.params.id}}`, `{{request.headers.authorization}}`, `{{request.query.page}}`, `{{request.body.name}}`.

### 1.2 Services ✅

1. ✅ **UUID Service Implementation** (`src/services/UuidLive.ts`)
   - `Layer.succeed(Uuid, { generate, generateShort })` using `uuid` package

2. ✅ **App Configuration** (`src/services/AppConfig.ts`)
   - `class AppConfig extends Context.Tag("AppConfig")<AppConfig, {...}>() {}`
   - Admin port (default 2525), imposter port range (3000-4000), max imposters, log level
   - `Effect.Config` + `ConfigProvider`

3. ✅ **Port Allocator** (`src/services/PortAllocator.ts`)
   - `allocate(preferred?)`, `release(port)`, `isAvailable(port)`
   - `Ref<HashSet<number>>` for tracking with atomic `Ref.modify`
   - **Must handle TOCTOU race:** if `Bun.serve()` bind fails, catch the error, release the port in the allocator, propagate `PortInUseError`

4. ✅ **Imposter Repository** (`src/repositories/ImposterRepository.ts`)
   - **Pure config storage only:** `Ref<HashMap<ImposterId, ImposterConfig & { stubs: Stub[] }>>`
   - NO fiber refs, NO server refs — those live in `FiberMap`
   - CRUD for imposters + nested stub management
   - Concurrent updates: atomic `Ref.modify` with explicit return type annotations

5. ✅ **Layer Composition** (`src/layers/MainLayer.ts`)
   - Express dependencies: `PortAllocatorLive` depends on `AppConfig`, etc.
   - Use `Layer.provide` for dependency edges

### Verification
- ✅ All services implemented with tests (74 tests across 10 files)
- ✅ Stub/predicate schemas defined and validated
- ✅ Port allocator handles concurrent allocation + bind failure recovery
- ✅ Repository stores imposter configs and stubs (pure data, no runtime refs)

---

## Phase 2: Admin REST API

**Goal:** REST API on the admin port for managing imposters and stubs.

### API Design

```
POST   /imposters                            → Create imposter
GET    /imposters                            → List (paginated, filterable)
GET    /imposters/:id                        → Get details
PATCH  /imposters/:id                        → Update (name, port, status)
DELETE /imposters/:id                        → Delete
POST   /imposters/:imposterId/stubs          → Add stub
GET    /imposters/:imposterId/stubs          → List stubs
PUT    /imposters/:imposterId/stubs/:stubId  → Update stub
DELETE /imposters/:imposterId/stubs/:stubId  → Delete stub
GET    /health                               → Health check
GET    /info                                 → Server info
```

### Implementation

1. **API Definition** (`src/api/AdminApi.ts`)
   - `HttpApi.make("admin")` with `HttpApiGroup` per resource
   - Uses schemas from `ImposterSchema.ts` and `StubSchema.ts`

2. **Handlers** (`src/api/AdminHandlers.ts`)
   - `HttpApiBuilder.group(AdminApi, "imposters", ...)` pattern
   - Delegates to repository + services

3. **Admin Server** (`src/server/AdminServer.ts`)
   - `HttpApiBuilder.toWebHandler(layer)` → `Bun.serve({ port, fetch: handler })`
   - Lifecycle via `Effect.acquireRelease` for clean shutdown
   - OpenAPI auto-generation via `HttpApiBuilder.middlewareOpenApi()`

4. **Entry Point** (`src/Program.ts`)
   - Top-level `Effect.scoped` providing shared scope for admin + all imposters
   - Use `Effect.runFork` (no `@effect/platform-bun` dependency needed)

### Done when
- Admin server starts, all CRUD endpoints work
- OpenAPI spec served at `/docs`
- Integration tests pass using `HttpApiClient`

---

## Phase 3: Imposter Runtime + Route Matching

**Goal:** Creating an imposter spawns an HTTP server on its port as an Effect Fiber. Stubs match requests and generate responses. This is one phase because an imposter without matching logic can't be meaningfully tested.

### Core components

1. **Fiber Manager** (`src/server/FiberManager.ts`)
   - Wraps `FiberMap<ImposterId>` (Effect built-in, NOT hand-rolled `Ref<HashMap>`)
   - `FiberMap.run(map, id, effect)` — forks fiber, auto-interrupts previous if same key
   - `FiberMap.remove(map, id)` — interrupts and removes
   - Scoped: closing the scope interrupts all fibers

2. **Router Builder** (`src/server/RouterBuilder.ts`)
   - Converts `Stub[]` → `HttpRouter` dynamically
   - Uses `HttpRouter.makeRoute` + `HttpRouter.fromIterable` (not `HttpRouter.route`)
   - Each stub becomes a handler that: evaluates predicates, selects next response (round-robin), applies delay, substitutes template variables from full request context, returns response

3. **Request Matcher** (`src/matching/RequestMatcher.ts`)
   - Evaluates predicates against incoming `HttpServerRequest`
   - Supports: method, path (with `:param` extraction), headers, query params
   - Predicates combined with AND logic
   - Returns matched stub + extracted params, or 404

4. **Response Generator** (`src/matching/ResponseGenerator.ts`)
   - Selects next response from stub's response list (tracks index per stub in `Ref`)
   - Applies `{{request.params.*}}`, `{{request.headers.*}}`, `{{request.query.*}}`, `{{request.body.*}}` substitution
   - Applies delay via `Effect.sleep(Duration)`
   - Builds `HttpServerResponse` with status, headers, body

5. **Imposter Server** (`src/server/ImposterServer.ts`)
   - `start(id)`: builds initial `HttpRouter`, stores in `Ref<HttpRouter>`, creates web handler via `HttpApp.toWebHandlerRuntime(runtime)(ref-reading-app)`, launches `Bun.serve()` via `Effect.acquireRelease`, forks via `FiberMap.run`
   - `stop(id)`: `FiberMap.remove` (acquireRelease finalizer calls `server.stop()` + releases port)
   - `updateRoutes(id)`: rebuilds router from current stubs, atomically swaps `Ref<HttpRouter>` — zero downtime

6. **Fiber supervision:** When a fiber fails (imposter crash), mark imposter as `stopped` with `lastError`, release its port. Use `Effect.onError` or `Effect.ensuring` within the fiber effect.

7. **Graceful shutdown:** The top-level `Effect.scoped` in `Program.ts` owns the `FiberMap` scope. SIGINT/SIGTERM → scope closes → all fibers interrupted → all `acquireRelease` finalizers run → all Bun servers stopped.

### Key Effect patterns
- `FiberMap` for fiber lifecycle (NOT hand-rolled Ref<HashMap>)
- `Effect.acquireRelease` for `Bun.serve()` lifecycle
- `Ref<HttpRouter>` per imposter for hot-reload
- `HttpRouter.makeRoute` + `HttpRouter.fromIterable` for dynamic routing
- `HttpApp.toWebHandlerRuntime` for converting router to Bun-compatible handler
- `HttpRouter.RouteContext` for path parameters
- `Effect.sleep(Duration)` for response delays

### E2E test plan
- Create imposter via admin API → send HTTP request to imposter port → verify response matches stub config
- Create imposter with multiple stubs → verify correct stub matches based on predicates
- Create stub with multiple responses → verify round-robin cycling
- Create imposter → add route → verify hot-reload (no restart)
- Create imposter → stop → verify port freed → create new imposter on same port
- Create 10 imposters → stop 5 → delete 3 → verify exactly 2 running, ports correctly managed
- Rapid create/delete cycles → verify no resource leaks

### Done when
- Imposters spawn as HTTP servers on their ports
- Predicate matching works (method, path, headers, query)
- Response cycling works (round-robin)
- Template substitution works with full request context
- Hot-reload works (route changes without restart)
- Lifecycle works (create/start/stop/delete)
- Clean shutdown stops all fibers
- E2E tests pass

---

## Phase 4: Client Library & Developer Experience

**Goal:** Make Imposters usable as a testing tool with a proper client library and programmatic API.

### Components

1. **Client Library** (`src/client/ImpostersClient.ts`)
   - Typed client auto-generated from `HttpApi` definition using `HttpApiClient`
   - Published as `@imposters/client` or included in main package
   - API: `createImposter()`, `addStub()`, `deleteImposter()`, etc.

2. **Test Helpers** (`src/client/testing.ts`)
   - `withImposter(config, testFn)` — creates imposter, runs test, tears down
   - `startImpostersServer(config)` — programmatic server start for test setup files
   - Integration with vitest setup/teardown

3. **Configuration File Loading**
   - Accept JSON/YAML config file at startup: `imposters start --config imposters.json`
   - Config file defines imposters + stubs declaratively
   - Useful for CI/CD pipelines

### Done when
- Client library works and is well-typed (no `any`)
- Test helpers enable easy imposter lifecycle in test suites
- Config file loading works for declarative setup

---

## Phase 5: Per-Imposter Configuration UI

**Goal:** Each imposter serves an HTMX-based web UI at `/_admin`.

Split into sub-phases for manageable delivery:

### 5a: Request Logging Service
- `RequestLogger` service using `Queue.sliding(100)` per imposter for bounded buffer
- `PubSub<RequestLogEntry>` for real-time event streaming (enables future SSE)
- Middleware wrapping imposter routes to capture requests
- Exposed via admin API: `GET /imposters/:id/requests`

### 5b: Basic UI
- HTML template engine with tagged template literals + auto-escaping
- Layout with HTMX loaded from CDN
- Dashboard page: imposter overview, stub count, request count
- Stub list page with add/edit/delete via HTMX partials

### 5c: Request Inspector
- Request log viewer with filtering
- Request detail view (headers, body, matched stub)
- Testing tool: send a request from the UI and see the response

### Router integration
- UI routes mounted at `/_admin` with priority over mock stubs
- Uses `HttpRouter.mount` to namespace UI routes

### Done when
- Each imposter serves a web UI at `/_admin`
- Stubs can be managed through the UI
- Recent requests are visible and inspectable

---

## Phase 6: Advanced Features (prioritized)

**High priority (essential for real usage):**

| Feature | Description |
|---------|-------------|
| **Persistence** | Save/restore imposter configs to disk via `@effect/platform` `FileSystem`. Imposters survive restart. |
| **CLI** | `@effect/cli` based: `imposters start`, `imposters create`, `imposters list`. `bin` field in package.json for `npx imposters`. |
| **Dynamic Response Injection** | Safe expression evaluator (e.g., JSONata) for dynamic response generation beyond template substitution. |

**Medium priority:**

| Feature | Description |
|---------|-------------|
| **Proxy Mode** | Forward unmatched requests to real backend, record responses as stubs. The proxy-to-record-to-stub workflow. |
| **Statistics** | `Effect.Metric` counters and histograms per route/imposter. |
| **Request Recording** | Export/import recorded requests as JSON, auto-generate stubs. |
| **Mountebank Adapter** | Accept Mountebank-format JSON configs. Translation layer for predicates/responses. |

**Lower priority:**

| Feature | Description |
|---------|-------------|
| **OpenAPI Import** | Parse OpenAPI 3.x specs to auto-generate imposters + stubs. |
| **WebSocket Mocking** | Mock WebSocket endpoints with configurable message sequences. |
| **Multi-protocol** | GRPC, TCP support as pluggable protocol adapters. |

---

## Verification Strategy

Each phase must pass:
1. **`bun check`** — zero type errors, zero `any` types
2. **`bun test`** — all unit + integration tests pass
3. **`bun lint`** — no lint violations
4. **Phase 3+: E2E tests** — admin API → create imposter → hit imposter → verify response
5. **Phase 3+: Lifecycle tests** — create/stop/delete imposters, verify fiber cleanup and port release
6. **Phase 3+: Concurrency tests** — concurrent imposter creation, concurrent stub updates
7. **Phase 5+: Manual smoke test** — open `/_admin` in browser, manage stubs visually

---

## Estimated Project Structure (Phase 5 complete)

```
src/
  Program.ts
  api/
    AdminApi.ts
    AdminHandlers.ts
  client/
    ImpostersClient.ts
    testing.ts
  domain/
    imposter.ts
    route.ts
  layers/
    MainLayer.ts
  matching/
    RequestMatcher.ts
    ResponseGenerator.ts
  repositories/
    ImposterRepository.ts
  schemas/
    common.ts
    ImposterSchema.ts
    StubSchema.ts
  server/
    AdminServer.ts
    FiberManager.ts
    ImposterServer.ts
    RouterBuilder.ts
  services/
    AppConfig.ts
    PortAllocator.ts
    RequestLogger.ts
    Uuid.ts
    UuidLive.ts
  ui/
    templates.ts
    ImposterUI.ts
    pages/
      Dashboard.ts
      Routes.ts
      Requests.ts
test/
  (mirrors src/ structure with .test.ts files)
  e2e/
    imposter-lifecycle.test.ts
    stub-matching.test.ts
    hot-reload.test.ts
```
