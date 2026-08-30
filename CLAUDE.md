# Imposters — Project Context for Claude

## Project Overview

**Imposters** is a service virtualization tool — a modern, programmable alternative to the abandoned [Mountebank](http://www.mbtest.org/). It spins up mock HTTP servers ("imposters"), each on its own port, managed centrally through an admin REST API. Built with TypeScript and [Effect](https://effect.website).

## Current Status

**Shipped and published.** The package is live on npm as `imposters` (v0.2.4), released automatically from `master` by GitHub Actions with npm provenance.

The tool is functionally complete for its core use case: create an imposter, add stubs, start it, and it serves matched responses on its own port — with templating, proxying, request logging, stats, and a web UI.

All three gates pass: `bun check`, `bun lint`, and 322 tests across 39 files.

### What's implemented

| Area | Status |
|---|---|
| Admin REST API (`HttpApi` + OpenAPI/Swagger) | ✅ |
| Imposter runtime — per-imposter server as an Effect Fiber | ✅ |
| Stub matching with predicates | ✅ |
| Response templating — `{{key}}` substitution + `${expr}` JSONata | ✅ |
| Response cycling — sequential / random / repeat | ✅ |
| Hot-reload — stub changes apply with zero downtime | ✅ |
| Proxy mode — passthrough and record-as-stub | ✅ |
| Request logging + inspector | ✅ |
| Metrics / statistics per imposter | ✅ |
| HTMX UIs — `/_ui` (admin) and `/_admin` (per imposter) | ✅ |
| Typed client library + `withImposter` test helpers | ✅ |
| CLI via `@effect/cli`, JSON config file loading | ✅ |
| Node **and** Bun runtimes (`--runtime` flag) | ✅ |

### Not implemented

Disk persistence (imposters are in-memory only and do not survive restart), Mountebank config adapter, OpenAPI spec import, WebSocket mocking, gRPC / multi-protocol.

## Architecture

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

### Two different HTTP styles — this is deliberate

- **Admin server** uses `HttpApi` / `HttpApiGroup` / `HttpApiEndpoint` — a statically typed, schema-derived API, served via `HttpApiBuilder.toWebHandler`.
- **Imposter servers do NOT use `HttpRouter` at all.** There is no router-building step. Each imposter's handler is a plain `async (request: Request) => Response` that: (1) offers the request to the `/_admin` UI router, (2) reads the current stubs from a `Ref`, (3) linearly finds the first stub whose predicates all match, (4) falls back to proxy or 404.

  Imposter routes are user-configured at runtime, so a compile-time-typed router buys nothing. Linear matching over a `Ref<ReadonlyArray<Stub>>` is what makes hot-reload trivial.

### Key runtime mechanics

- **Fiber lifecycle** — `FiberManager` wraps Effect's built-in `FiberMap`. Starting an imposter forks a fiber keyed by imposter id; re-keying auto-interrupts the previous one; closing the scope interrupts everything.
- **Server lifecycle** — `Effect.acquireRelease` around each server instance, so the finalizer stops the server and releases the port on interrupt.
- **Hot-reload** — each imposter holds `Ref<ReadonlyArray<Stub>>` and `Ref<ProxyConfig | undefined>`. `updateStubs(id)` / `updateProxyConfig(id)` re-read from the repository and `Ref.set`. The fetch handler reads the `Ref` on every request, so changes take effect immediately with no restart.
- **Runtime abstraction** — `ServerFactory` is a `Context.Tag` with two implementations: `NodeServerFactoryLive` (`node:http`, the default) and `BunServerFactoryLive` (`Bun.serve`). This exists because **vitest workers run under Node.js even when invoked via Bun**, so tests could not use `Bun.serve` directly. It later became the user-facing `--runtime node|bun` flag.
- **Repository is pure storage** — `ImposterRepository` holds config + stubs in a `Ref<HashMap>`. No fiber refs, no server handles; those live in `FiberManager` and `ImposterServer`'s internal state map.

## Project Structure

```
src/
  Program.ts               # one-liner: import "./cli/Commands.js"
  index.ts                 # generated barrel (eslint-plugin-codegen)
  api/
    AdminApi.ts            # HttpApi.make("admin") — composes the two groups
    ImpostersGroup.ts      # imposter/stub/request/stats endpoints
    SystemGroup.ts         # /health, /info (topLevel: true → client root)
    ImpostersHandlers.ts
    SystemHandlers.ts
    ApiSchemas.ts
    ApiErrors.ts           # Schema.TaggedError types with status annotations
    Conversions.ts         # domain <-> API shape mapping
  cli/
    Commands.ts            # @effect/cli; `imposters start`; runs at module scope
    ConfigLoader.ts        # JSON config file → imposters + stubs
    version.ts             # "0.0.0" placeholder, patched by CI at publish
  client/
    ImpostersClient.ts     # typed HttpApiClient derived from AdminApi
    HandlerHttpClient.ts   # in-process HttpClient (no socket) for tests
    testing.ts             # withImposter, makeTestServer
    index.ts
  domain/
    imposter.ts            # ImposterConfig, status, tagged errors
    route.ts               # substituteParams — used only by TemplateEngine
  layers/
    MainLayer.ts           # service composition
    ApiLayer.ts            # ApiLive + OpenAPI/Swagger middleware + HttpServer ctx
  matching/
    RequestMatcher.ts      # predicate evaluation, findMatchingStub
    ResponseGenerator.ts   # response selection + buildResponse
    TemplateEngine.ts      # {{key}} substitution
    ExpressionEvaluator.ts # ${expr} via JSONata
  repositories/
    ImposterRepository.ts  # Ref<HashMap<id, config + stubs>>
  schemas/
    common.ts              # branded types, enums, pagination, errors
    ImposterSchema.ts
    StubSchema.ts          # Stub, Predicate, ResponseConfig
    RequestLogSchema.ts
    ConfigFileSchema.ts
  server/
    AdminServer.ts
    ImposterServer.ts      # the core: start/stop/updateStubs/updateProxyConfig
    FiberManager.ts        # FiberMap wrapper
    ServerFactory.ts       # Node + Bun implementations
  services/
    AppConfig.ts           # Effect.Config, env-driven
    PortAllocator.ts       # Ref<HashSet<number>>, TOCTOU-safe
    ProxyService.ts        # forward + recordAsStub
    RequestLogger.ts       # bounded per-imposter log + PubSub
    MetricsService.ts      # counts, percentiles, error rate
    Uuid.ts / UuidLive.ts
  ui/
    UiRouter.ts            # per-imposter /_admin — plain URL matcher, returns Response | null
    html.ts                # tagged-template engine with auto-escaping
    layout.ts, partials.ts
    pages/                 # dashboard, stubs, requests, request-detail
    admin/                 # global /_ui dashboard on the admin port
test/                      # mirrors src/, plus test/e2e/ and test/helpers/
```

## Development Commands

```bash
bun check          # tsc -b tsconfig.json
bun lint           # eslint
bun lint-fix
bun run test       # vitest --run (single run, NOT watch; ~32s — files run serially)
bun coverage
bun run build      # codegen + esm + cjs + esbuild CLI bundle + postbuild
```

Note: `bun test` (Bun's native runner) is **not** the same as `bun run test` (vitest). Always use the latter.

## Code Standards

1. **No `any`.** Use `unknown` and narrow via Schema or type guards.
2. **No type-casting** (`as`, `!`, `<Type>`). Restructure or decode instead. Rare Effect-API exceptions must be commented with why.
3. **Errors:** `Data.TaggedError` for domain errors; `Schema.TaggedError` for API errors (needed for `HttpApi` status annotations).
4. **Services:** class-based tags — `class Foo extends Context.Tag("Foo")<Foo, FooShape>() {}`.
5. **Purity:** no `new Date()` in domain code — use Effect's `Clock` / `DateTime`. No side effects outside `Effect`.
6. **Schema-first:** all validation through Effect Schema; no manual parsing or unsafe `.make()`.

### Known deviations (tech debt, not precedent)

Three `any` usages and ~4 non-null assertions survive and should be cleaned up rather than copied:

- `src/server/ServerFactory.ts:75` — `(globalThis as any).Bun.serve`. A previous `src/types/bun.d.ts` declaring the `Bun` global was deleted during the Node-runtime work; restoring it would remove this cast.
- `src/ui/admin/AdminUiRouter.ts:16` — `toAdminData = (imp: any)`.
- `src/client/testing.ts:100` — `HttpApiBuilder.toWebHandler(fullLayer as any)`.

## Effect Gotchas (hard-won — read before debugging)

**Schema / core**
- `ParseError` lives in `effect/ParseResult`, not `effect/Schema`.
- `String.replace` is curried and returns a function — use native `.replaceAll()`.
- `Ref.modify` with conditional branches fails inference under `exactOptionalPropertyTypes`. Fix by annotating the callback's return type, e.g. `(store): readonly [Effect<A, E>, Store] => ...`. **Do not** split into `Ref.get` + `Ref.set` — that breaks atomicity.
- `HashMap.remove(key)` — don't pass explicit type params to the curried form; TS resolves to the wrong overload. Let inference work.

**HttpApi**
- `HttpApiGroup.prefix("/x")` plus endpoint path `"/"` yields `/x/` — a trailing slash. Put full paths on endpoints instead.
- `Layer.provideMerge(self)(that)` feeds **self's** output into **that's** input (order reads backwards).
- Middleware layers (`middlewareOpenApi`, `HttpApiSwagger.layer`) require `Api` — provide it via `Layer.provide(ApiLive)`.
- `Effect.catchTag` as a standalone helper types the error as `unknown`. Always inline it in a `.pipe()` chain.
- `HttpApiGroup.make("system", { topLevel: true })` puts endpoints at the client root, not under `.system`.
- The generated client expects the **decoded** type (with brands), not the encoded form — pass `protocol: "HTTP"`, `adminPath: "/_admin"`, a branded `PortNumber`, etc.

**Testing**
- **`Layer.scoped` + `it.effect` hangs forever.** `@effect/vitest`'s `it.effect`/`it.scoped` do not clean up scoped layers (`FiberMap` etc.). Use `ManagedRuntime.make(layer)` + `afterAll(() => runtime.dispose())` + plain vitest `it()` with `await runtime.runPromise(...)`.
- vitest workers are Node.js processes even under Bun — `Bun.serve` is unavailable. Use `NodeServerFactoryLive` (see `test/helpers/NodeServerFactory.ts`).
- `runPromise` wraps failures in `FiberFailure` — assert with `String(err).toContain(msg)`, not identity.
- tsconfig needs `paths` for `imposters/*` in **both** `tsconfig.src.json` and `tsconfig.test.json`, plus `imposters/test/*` → `./test/*` in the test config.

**Environment**
- A local `.npmrc` pins `registry=https://registry.npmjs.org/` to override a global private-registry setting; without it `bun install` hangs. `scripts/postbuild.ts` also copies it into `dist/`, so do not delete it.
- **If you install through a mirror** (e.g. moving `.npmrc` aside to use a reachable internal registry), bun writes that mirror's tarball URLs into `bun.lock` as the second field of each entry. Upstream CI then cannot resolve them. Strip them before committing — the field should be `""`:
  ```bash
  sed -i 's#"https://your-mirror-host/[^"]*"#""#g' bun.lock
  bun install --frozen-lockfile   # verify it still resolves
  ```

## Known bugs

- **`ServerFactory` does not synchronise the server lifecycle.** `create()` calls `server.listen(port)` and returns without awaiting `'listening'`; `stop()` calls `server.close()` without awaiting `'close'`. So `ImposterServer.start(id)` resolves before the port is bound, and teardown resolves before it is released. Callers that create → start → request immediately (including the README quick-start) can hit `ECONNREFUSED`. The e2e suites mask it with fixed `setTimeout` sleeps, which is why `vitest.config.ts` must set `fileParallelism: false`. Fixing this should let that flag go.

## Build & Release

- `src/Program.ts` is a one-liner; the real entry point is `src/cli/Commands.ts`, which calls `Command.run` + `NodeRuntime.runMain` at module scope.
- The CLI ships as an **esbuild CJS bundle** (`dist/bin/cli.cjs`, target node18) because the ESM library build was not usable as a Node `bin`. `bin/imposters` is a three-line shim that `require`s it.
- `scripts/postbuild.ts` copies the shim into `dist/bin/`, chmods it 755, injects the `bin` field into `dist/package.json`, and copies `.npmrc`.
- **`src/cli/version.ts` is intentionally `"0.0.0"`.** CI `sed`s the real version into the bundle and both `dist/dist/{cjs,esm}/cli/version.js` at publish time. Do not "fix" it.
- Publishing uses npm **trusted publishing / OIDC**: `NODE_AUTH_TOKEN: ""` with `id-token: write` and `--provenance`. The empty token is intentional.
- Version base is the higher of (npm published version, latest git tag), then bumped by scanning conventional commits.
