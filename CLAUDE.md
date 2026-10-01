# Imposters — Project Context for Claude

## Project Overview

**Imposters** is a service virtualization tool — a modern, programmable alternative to the abandoned [Mountebank](http://www.mbtest.org/). It spins up mock HTTP servers ("imposters"), each on its own port, managed centrally through an admin REST API. Built with TypeScript and [Effect](https://effect.website).

## Current Status

**Shipped and published.** The package is live on npm as `imposters` (v0.6.0), released automatically from `master` by GitHub Actions with npm provenance.

The tool is functionally complete for its core use case: create an imposter, add stubs, start it, and it serves matched responses on its own port — with templating, proxying, request logging, stats, and a web UI.

All three gates pass: `bun check`, `bun lint`, and 566 tests across 52 files.

**Runs on Effect 4 release candidates** (`effect@4.0.0-rc.117`, `@effect/platform-node` and `@effect/vitest` at `4.0.0-rc.115`), pinned to exact versions because RCs still rename APIs between builds. `@effect/platform` and `@effect/cli` are gone; their modules live in `effect/unstable/{http,httpapi,cli}`.

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
| CLI via `effect/unstable/cli`, JSON config file loading | ✅ |
| Node **and** Bun runtimes (`--runtime` flag) | ✅ |
| Imposter extensions — pluggable non-HTTP protocols | ✅ |
| S3 emulator — in-memory, path-style, `"protocol": "S3"` | ✅ (first extension; see below) |

### Not implemented

Disk persistence (imposters are in-memory only and do not survive restart), Mountebank config adapter, OpenAPI spec import, WebSocket mocking, gRPC. The S3 emulator's scope trims (three bucket-config PUTs, aws-chunked bodies, list pagination) answer 501 and are in the DEVELOPMENT.md maintenance backlog. The user-facing roadmap is ROADMAP.md.

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

- **Admin server** uses `HttpApi` / `HttpApiGroup` / `HttpApiEndpoint` — a statically typed, schema-derived API, registered with `HttpApiBuilder.layer` and served via `HttpRouter.toWebHandler`.
- **Imposter servers do NOT use `HttpRouter` at all.** There is no router-building step. Each imposter's handler is a plain `async (request: Request) => Response` that: (1) offers the request to the `/_admin` UI router, (2) reads the current stubs from a `Ref`, (3) linearly finds the first stub whose predicates all match, (4) falls back to the imposter's extension, proxy or 404 (see Extensions below).

  Imposter routes are user-configured at runtime, so a compile-time-typed router buys nothing. Linear matching over a `Ref<ReadonlyArray<Stub>>` is what makes hot-reload trivial.

### Key runtime mechanics

- **Fiber lifecycle** — `FiberManager` wraps Effect's built-in `FiberMap`. Starting an imposter forks a fiber keyed by imposter id; closing the scope interrupts everything. `FiberMap.remove` awaits the interrupted fiber (finalizers included), but `FiberMap.run` re-keying only calls `interruptUnsafe` and does **not** wait, so `FiberManager.start` removes any existing fiber first, under a semaphore. `stop` therefore resolves only after the old server has released its port.
- **Server lifecycle** — `ServerFactory.create` resolves once the port is bound (Node: `'listening'`; Bun: `Bun.serve` is synchronous) and fails with `ServerBindError` otherwise; `ServerInstance.stop` resolves once the port is released. The imposter fiber wraps them in `Effect.acquireRelease`, and `ImposterServer.start` awaits a `Deferred` the fiber completes after binding, so `start` resolves only when the imposter is reachable. A bind failure fails `start` with `ImposterServerError` (409 `ApiConflictError` over the API) and leaves the imposter `stopped` with no fiber or state entry.
- **Bind address** — every server binds one host, `DEFAULT_HOST` (`127.0.0.1`) unless `--host` or `IMPOSTERS_HOST` says otherwise. It is a parameter of the factory (`makeNodeServerFactory(host)`), passed from the CLI through `makeCompositeHandler` → `makeFullLayer` → `makeMainLayer`, so the admin port and the imposter ports agree. On macOS a specific-address bind succeeds beside a wildcard one, so `test/helpers/net.ts`'s `occupyPort` holds `127.0.0.1`, and firewall stealth mode drops a SYN to a closed port rather than refusing it, which is why `reachability` times out to "unreachable".
- **Hot-reload** — each imposter holds `Ref<ReadonlyArray<Stub>>` and `Ref<ProxyConfig | undefined>`. `updateStubs(id)` / `updateProxyConfig(id)` re-read from the repository and `Ref.set`. The fetch handler reads the `Ref` on every request, so changes take effect immediately with no restart.
- **Runtime abstraction** — `ServerFactory` is a `Context.Service` with two implementations: `NodeServerFactoryLive` (`node:http`, the default) and `BunServerFactoryLive` (`Bun.serve`). This exists because **vitest workers run under Node.js even when invoked via Bun**, so tests could not use `Bun.serve` directly. It later became the user-facing `--runtime node|bun` flag.
- **Repository is pure storage** — `ImposterRepository` holds config + stubs in a `Ref<HashMap>`. No fiber refs, no server handles; those live in `FiberManager` and `ImposterServer`'s internal state map.

### Extensions — how a non-HTTP protocol plugs in

The core must never know a specific protocol (the S3 emulator is the first). `src/extensions/Extension.ts` is the only core-owned module: `ImposterExtension = { protocol, make }`, the `Extensions` service, `findExtension`, `supportedProtocols`.

- **Protocol** is a real field, fixed at create: `^[A-Z][A-Z0-9]*$`, default `"HTTP"`. Creating one no extension provides is a 400 `ApiBadRequestError`, and so is `proxy` on a non-HTTP imposter (create or PATCH), since it would never run.
- **Handler order:** `/_admin` UI → stubs → extension `handle` → proxy → 404. The extension is **terminal**: it answers every unmatched request and renders its own errors. Its responses share the capture/log/metrics path; a defect becomes a 500.
- **`make({ id, config })` runs on every start**, so per-imposter state (an S3 store) lives in the instance and is lost on stop or restart.
- **Registration point:** the `extensions` list at the top of `src/cli/Commands.ts`, threaded through `makeCompositeHandler` → `makeFullLayer` → `makeMainLayer(extensions)` so `ImposterServerLive` and both handler groups read one `Extensions`. `Extensions.layer` dies at build on a duplicate, `"HTTP"`, or a malformed protocol. Tests register their own (`test/helpers/TestExtensions.ts`) with `makeTestServer({ extensions })`.
- **Boundary:** each extension lives in `src/extensions/<name>/`, and may import core modules (`matching/RequestMatcher` for `RequestContext`, `extensions/Extension`). ESLint `no-restricted-imports` (bottom of `eslint.config.mjs`) forbids importing one from anywhere in `src/` except `src/cli/**`, and one extension from another, in relative and `imposters/...` forms. `generateIndex` excludes `extensions/*/**/*.ts` so the root barrel never pulls one in. Deleting the list entry and the folder leaves a core that compiles and passes.

### The S3 extension (`src/extensions/s3/`)

An in-memory S3 for the AWS SDK with `forcePathStyle` (`/<bucket>/<key>`). Built for a real consumer's usage (SDK `@aws-sdk/client-s3@3.1131.0`, exact-pinned as a devDependency for the e2e). README "S3 Emulator" lists the operations and the 501s.

- **Pipeline:** `parseOperation(ctx)` (`Operation.ts`, a route table keyed by method × target × subresource) → `Result<Operation, S3Error>` → `apply(store, op, now)` (`Kernel.ts`, pure, run through `Ref.modify` so each operation is atomic) → `render` (`Render.ts`, XML + headers + status from `errorStatus`). `S3Extension.ts` wires them; `handleS3(ref, ctx)` is exported for in-process tests.
- **Refuse, never guess:** a query key a route does not accept, a header in its `unsupportedHeaders`, an unrouted method/subresource, presigned URLs and `STREAMING-*` / `aws-chunked` bodies are all `501 NotImplemented`. Add a param to a route's `params` only when the kernel honours it.
- **XML:** `fast-xml-parser` with `processEntities: false`; `unescapeXml` resolves entities itself, because the parser drops numeric references unless its deprecated HTML mode is on. Parser output is `unknown` and goes through a Schema (`DeleteRequestXml`). Answers use the small escaping builder in `Xml.ts`.
- **SDK facts the e2e pins down:** a `Uint8Array` PutObject is a plain signed payload (`x-amz-content-sha256` is the hex SHA-256, plus `x-amz-checksum-crc32`, both ignored), never `STREAMING-*`. The SDK tags requests with `?x-id=<Op>` (ignored). `CopySource` must be URL-encoded by the caller, as on real S3. A 304 surfaces as an `S3ServiceException` with `$metadata.httpStatusCode === 304`. Never send checksum headers on GetObject: the SDK would validate them.
- **Expected owner (stateless):** `x-amz-expected-bucket-owner` / `x-amz-source-expected-bucket-owner` must equal the access key id in `Authorization` (`Credential=<akid>/...`, or SigV2 `AWS <akid>:`), else `403 AccessDenied`. It runs before routing. An unsigned request is not checked. A consumer can map the 403 to a bucket-unavailable error, and its provisioning to a `versioning` failure, which is what that consumer's "another owner" specs expect. SigV4 signatures themselves are not verified.
- **Config PUTs:** `?ownershipControls` (200) and `?policy` (204) are accepted no-ops on an existing bucket; `?publicAccessBlock`, `?encryption`, `?lifecycle` stay 501, so a consumer's provisioning suite reports exactly `['public-access', 'encryption', 'multipart-abort']` as unsupported locally.
- **State is per start** (the `Ref` is made in `make`), so buckets vanish on stop/restart. That is intended.
- **Fault injection is free:** stubs match first, so a stub can answer one key with a 503 `SlowDown` XML body or a `delay`. `test/e2e/s3.test.ts` proves both.

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
    Commands.ts            # effect/unstable/cli; `imposters start`; runs at module scope; extension registration point
    ConfigLoader.ts        # JSON config file → imposters + stubs; any failure exits the CLI non-zero
    version.ts             # "0.0.0" placeholder, patched by CI at publish
  client/
    ImpostersClient.ts     # typed HttpApiClient derived from AdminApi
    HandlerHttpClient.ts   # in-process HttpClient (no socket) for tests
    testing.ts             # withImposter, makeTestServer({ extensions? })
    index.ts
  domain/
    imposter.ts            # ImposterConfig (incl. protocol), status, tagged errors
    route.ts               # substituteParams — used only by TemplateEngine
  extensions/
    Extension.ts           # the extension point (core-owned)
    <name>/                # one folder per extension; imported only from src/cli/
    s3/                    # S3Extension, Operation (routing), Kernel (pure store), Render, Xml, S3Error
  layers/
    MainLayer.ts           # makeMainLayer(extensions); MainLayer = makeMainLayer([])
    ApiLayer.ts            # HttpApiBuilder.layer + OpenAPI/Swagger + decode-error body + quiet logging
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
  types/
    bun.d.ts               # minimal ambient `Bun` global (serve/port/stop), possibly undefined
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
examples/                  # config files, e.g. s3.json (an S3 imposter on 7070)
```

## Development Commands

```bash
bun check          # tsc -b tsconfig.json — runs TypeScript 7 (native); see "Two TypeScript installs" under Environment
bun lint           # eslint
bun lint-fix
bun run test       # vitest --run (single run, NOT watch; ~3s — files run in parallel)
bun coverage
bun run build      # codegen + esm + cjs + esbuild CLI bundle + postbuild
```

Note: `bun test` (Bun's native runner) is **not** the same as `bun run test` (vitest). Always use the latter.

## Code Standards

1. **No `any`.** Use `unknown` and narrow via Schema or type guards.
2. **No type-casting** (`as`, `!`, `<Type>`). Restructure or decode instead. Rare Effect-API exceptions must be commented with why.
3. **Errors:** `Data.TaggedError` for domain errors; `Schema.TaggedError` for API errors (needed for `HttpApi` status annotations).
4. **Services:** class-based services — `class Foo extends Context.Service<Foo, FooShape>()("Foo") {}`.
5. **Purity:** no `new Date()` in domain code — use Effect's `Clock` / `DateTime`. No side effects outside `Effect`.
6. **Schema-first:** all validation through Effect Schema; no manual parsing or unsafe `.make()`.

### Known deviations (tech debt, not precedent)

No `any` survives. About nine non-null assertions do (regex-match and index access in `AdminUiRouter`, `UiRouter`, `MetricsService`, `RequestMatcher`, `ImposterRepository`, `HandlerHttpClient`), plus the `as` casts in `src/client/testing.ts`. Clean them up rather than copying them.

## Effect Gotchas (hard-won — read before debugging)

The official v3→v4 guides are in `Effect-TS/effect-smol/migration/` (`v3-to-v4.md`, `schema.md`, `services.md`). They lag the RCs in places: the `.d.ts` files in `node_modules/effect/dist` are the source of truth.

**Schema / core**
- Filters are checks: `Schema.Int.check(Schema.isBetween({ minimum, maximum }))`, `isGreaterThan(0)` (there is no `positive` / `nonNegative`), `isMinLength`, `isPattern`, `isStartsWith`.
- `Schema.Literals(["a", "b"])` (array), `Schema.Record(key, value)` (two args), `Schema.decodeUnknownEffect` (not `decodeUnknown`).
- Defaults: `X.pipe(Schema.withDecodingDefault(Effect.succeed(encodedValue)))`. The default is an **encoded** value, so it is decoded and brand-checked like any input — no `.make()` or casts needed for branded defaults.
- Validation failures are `Schema.SchemaError` with `_tag: "SchemaError"` (v3's `ParseResult.ParseError` is gone).
- `Data.tagged` is gone. Plain tagged constructors come from `export const { Foo } = Data.taggedEnum<Foo>()`.
- `Config` is still an `Effect` subtype in rc.117 (the yieldable guide says otherwise), so `Layer.effect(Tag, config)` works. Constructors are capitalised: `Config.Number`, `Config.Literals([...], name)`.
- `DateTime.nowUnsafe()` / `DateTime.makeUnsafe()` (renamed from `unsafe*`). `Option.fromNullishOr`. `Effect.catch` / `catchCause` (from `catchAll*`). `Layer.effect` covers v3's `Layer.scoped`. `Effect.callback` replaces `Effect.async`.
- Capture services for use outside Effect with `Effect.context<never>()` + `Effect.runPromiseWith(services)` (the `Runtime` module is gone).
- `String.replace` is curried and returns a function — use native `.replaceAll()`.
- `Ref.modify` with conditional branches fails inference under `exactOptionalPropertyTypes`. Fix by annotating the callback's return type, e.g. `(store): readonly [Effect<A, E>, Store] => ...`. **Do not** split into `Ref.get` + `Ref.set` — that breaks atomicity.
- `HashMap.remove(key)` — don't pass explicit type params to the curried form; TS resolves to the wrong overload. Let inference work.

**HttpApi (`effect/unstable/httpapi`)**
- **Resolve services when the group is built, not inside handlers.** `HttpApiBuilder.group(api, "g", (handlers) => Effect.gen(function*() { const repo = yield* Repo; return handlers.handle(...) }))`. A service yielded *inside* a handler becomes a per-request `HttpRouter` requirement, and `HttpRouter.toWebHandler` then demands it as a second `context` argument.
- Endpoints take an options object: `HttpApiEndpoint.get("id", "/imposters/:id", { params, query, payload, success, error: [A, B] })`. DELETE is `HttpApiEndpoint.delete`.
- Handlers and the generated client both use `params` / `query` / `payload` (v3's `path` / `urlParams` are gone).
- Status codes: success via `Schema.pipe(HttpApiSchema.status(201))`; errors via the third `Schema.TaggedError` argument, `{ httpApiStatus: 404 }`.
- Query params are decoded through a string-tree codec, so plain `Schema.Number` / `Schema.Boolean` parse `"50"` / `"true"`. No `NumberFromString` / `BooleanFromString`.
- A request that fails schema decoding becomes a **defect** rendered as an empty 400. `ApiLayer`'s `DecodeErrorBody` middleware catches it with `Effect.catchDefect` and restores a JSON `HttpApiDecodeError` body. Keep it.
- Every request is logged at INFO unless `HttpRouter.disableLogger` is provided to the route layers *and* `toWebHandler(layer, { disableLogger: true })` is set (the latter also covers unmatched routes).
- `HttpApiGroup.make("system", { topLevel: true })` puts endpoints at the client root, not under `.system`.
- The generated client expects the **decoded** type (with brands), not the encoded form — pass `protocol: "HTTP"`, `adminPath: "/_admin"`, a branded `PortNumber`, etc.
- `Layer.provideMerge(self)(that)` feeds **self's** output into **that's** input (order reads backwards).
- v4 shares one layer memo map across `Effect.provide` calls, so `MainLayer` listing a layer twice still builds it once. `HttpRouter.toWebHandler` gets its own memo map, so each test's handler is isolated.

**Testing**
- `@effect/vitest`'s `it.effect` runs on a `TestClock` that starts at 0. Anything compared against `Clock` must also come from `Clock` (`yield* DateTime.now`), never `DateTime.nowUnsafe()`.
- Scoped layers (`FiberMap` etc.) in tests use `ManagedRuntime.make(layer)` + `afterAll(() => runtime.dispose())` + plain vitest `it()` with `await runtime.runPromise(...)`. On v3, `it.effect` with `Layer.scoped` hung forever; not re-verified on v4, so keep the pattern.
- vitest workers are Node.js processes even under Bun — `Bun.serve` is unavailable. Use `NodeServerFactoryLive` (see `test/helpers/NodeServerFactory.ts`). vitest 5 needs Node `^22.12`; CI pins Node 22 in `.github/actions/setup`.
- Test files run in parallel and bind real, fixed ports, so **each file owns its own port block** (e.g. `ImposterServer` 91xx, `stub-matching` 92xx, `ServerFactory` 97xx, S3 88xx). Grep before picking one. Auto-allocated ports (3000+) are per-file and collide, so never start an imposter without an explicit port.
- No sleeps after start/stop: they resolve once the port is bound/released. To assert on listener state use `test/helpers/net.ts` (`httpGet` opens a fresh connection, `probeConnect`, `occupyPort`), not `fetch`: undici's keep-alive pool can reuse a socket and mask the answer.
- `runPromise` wraps failures in `FiberFailure` — assert with `String(err).toContain(msg)`, not identity.
- tsconfig needs `paths` for `imposters/*` in **both** `tsconfig.src.json` and `tsconfig.test.json`, plus `imposters/test/*` → `./test/*` in the test config.

**Environment**
- **Two TypeScript installs, on purpose.** `typescript` (`~6.0.3`) keeps its real name because typescript-eslint and `@effect/language-service` need the JavaScript compiler API, which TypeScript 7 no longer ships (`require("typescript")` on TS 7 exposes only `version`). TypeScript 7 (native Go compiler, ~7x faster here) is installed under the alias `@typescript/native` (`npm:typescript@~7.0.2`) and drives `bun check` and `build-esm` **by explicit path** (`node node_modules/@typescript/native/bin/tsc`). `node_modules/.bin/tsc` currently resolves to TS 7 and `.bin/tsserver` to TS 6, but the scripts deliberately do not depend on which package wins that bin collision. Microsoft's recommended `@typescript/typescript6` shim does **not** work under bun: its inner `typescript@^6` dependency resolves back to the shim itself. Collapse to a single TS 7 once typescript-eslint supports the TS 7.1 API (typescript-eslint issue #10940).
- A local `.npmrc` pins `registry=https://registry.npmjs.org/` to override a global private-registry setting; without it `bun install` hangs. `scripts/postbuild.ts` also copies it into `dist/`, so do not delete it.
- **If you install through a mirror**, override the registry for that one command: `BUN_CONFIG_REGISTRY=https://your-mirror-host bun install`. It beats both the local `.npmrc` and a global `~/.bunfig.toml`, so `.npmrc` can stay put (moving it aside does nothing when `~/.bunfig.toml` sets a registry). Bun then writes the mirror's tarball URLs into `bun.lock` as the second field of each entry, which upstream CI cannot resolve. Strip them before committing — the field should be `""`:
  ```bash
  sed -i 's#"https://your-mirror-host/[^"]*"#""#g' bun.lock
  bun install --frozen-lockfile   # verify it still resolves
  ```
- **`vite` is pinned explicitly** (`^8.3.0`). vitest 5 only lists it as a peer, and bun kept the stale `vite@5` from the vitest 3 lockfile, which fails at startup with `ERR_PACKAGE_PATH_NOT_EXPORTED ... './module-runner'`.

## Known bugs

- **`--runtime bun` only applies to the admin server.** `MainLayer` hard-codes `NodeServerFactoryLive` for imposters, so under Bun they run on Bun's `node:http` compatibility layer rather than `Bun.serve`.

## Build & Release

- `src/Program.ts` is a one-liner; the real entry point is `src/cli/Commands.ts`, which calls `Command.run` + `NodeRuntime.runMain` at module scope.
- The CLI ships as an **esbuild CJS bundle** (`dist/bin/cli.cjs`, target node18) because the ESM library build was not usable as a Node `bin`. `bin/imposters` is a three-line shim that `require`s it.
- `scripts/postbuild.ts` copies the shim into `dist/bin/`, chmods it 755, injects the `bin` field into `dist/package.json`, and copies `.npmrc`.
- **`src/cli/version.ts` is intentionally `"0.0.0"`.** CI `sed`s the real version into the bundle and both `dist/dist/{cjs,esm}/cli/version.js` at publish time. Do not "fix" it.
- Publishing uses npm **trusted publishing / OIDC**: `NODE_AUTH_TOKEN: ""` with `id-token: write` and `--provenance`. The empty token is intentional.
- Each release attaches `npm pack dist/` as `imposters-<version>.tgz` to its GitHub release, for networks where the public npm registry is blocked. The workflow checks the file's integrity against `npm view dist.integrity` and only warns on a mismatch. v0.5.0's file was uploaded by hand; its files match npm's.
- **Only code changes release.** The publish run releases only when a commit since the last tag is `feat`, `fix`, `perf`, `refactor` or `revert`, or is marked breaking (`!` / `BREAKING CHANGE`). A run of only `docs`/`chore`/`ci`/`test`/`style`/`build` commits publishes nothing. `workflow_dispatch` with a `version` always releases.
- Version base is the higher of (npm published version, latest git tag), then bumped by scanning conventional commits.
