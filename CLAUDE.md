# Imposters — Project Context for Claude

## Project Overview

**Imposters** is a service virtualization tool — a modern, programmable alternative inspired by [Mountebank](https://github.com/mountebank-testing/mountebank). Mountebank's original site, mbtest.org, no longer belongs to the project, so never link to it; the project now lives at https://github.com/mountebank-testing/mountebank. It spins up mock HTTP servers ("imposters"), each on its own port, managed centrally through an admin REST API. Built with TypeScript and [Effect](https://effect.website).

## Current Status

**Shipped and published.** The package is live on npm as `imposters` (v0.6.0), released automatically from `master` by GitHub Actions with npm provenance.

The tool is functionally complete for its core use case: create an imposter, add stubs, start it, and it serves matched responses on its own port — with templating, proxying, request logging, stats, and a web UI.

All three gates pass: `bun check`, `bun lint`, and 1163 tests across 103 files.

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
| Stub callbacks — `before` calls feed the templates, `after` webhooks, hop limit + 508 | ✅ (the service graph comes next) |
| Request logging + inspector | ✅ |
| Metrics / statistics per imposter | ✅ |
| Web UIs — `/_ui` (admin, the self-hosted Disguise dashboard) and `/_admin` (per imposter: live view, stubs with a form editor, the request log and a page per request with explain, copy as curl, replay and its outbound calls; stub cards name each response's callbacks), all self-hosted with no CDN | ✅ |
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
- **Imposter servers do NOT use `HttpRouter` at all.** There is no router-building step. Each imposter's handler is a plain `async (request: Request) => Response` that: (1) offers the request to the `/_admin` UI router, (2) reads the current stubs from a `Ref`, (3) linearly finds the first stub whose predicates all match, runs its response's `before` callbacks, then its delay, then builds it, (4) falls back to the imposter's extension, proxy or 404 (see Extensions below).

  Imposter routes are user-configured at runtime, so a compile-time-typed router buys nothing. Linear matching over a `Ref<ReadonlyArray<Stub>>` is what makes hot-reload trivial.

### Key runtime mechanics

- **Fiber lifecycle** — `FiberManager` wraps Effect's built-in `FiberMap`. Starting an imposter forks a fiber keyed by imposter id; closing the scope interrupts everything. `FiberMap.remove` awaits the interrupted fiber (finalizers included), but `FiberMap.run` re-keying only calls `interruptUnsafe` and does **not** wait, so `FiberManager.start` removes any existing fiber first, under a semaphore. `stop` therefore resolves only after the old server has released its port.
- **Server lifecycle** — `ServerFactory.create` resolves once the port is bound (Node: `'listening'`; Bun: `Bun.serve` is synchronous) and fails with `ServerBindError` otherwise; `ServerInstance.stop` resolves once the port is released. The imposter fiber wraps them in `Effect.acquireRelease`, and `ImposterServer.start` awaits a `Deferred` the fiber completes after binding, so `start` resolves only when the imposter is reachable. A bind failure fails `start` with `ImposterServerError` (409 `ApiConflictError` over the API) and leaves the imposter `stopped` with no fiber or state entry.
- **Bind address** — every server binds one host, `DEFAULT_HOST` (`127.0.0.1`) unless `--host` or `IMPOSTERS_HOST` says otherwise. It is a parameter of the factory (`makeNodeServerFactory(host)`), passed from the CLI through `makeCompositeHandler` → `makeFullLayer` → `makeMainLayer`, so the admin port and the imposter ports agree. On macOS a specific-address bind succeeds beside a wildcard one, so `test/helpers/net.ts`'s `occupyPort` holds `127.0.0.1`, and firewall stealth mode drops a SYN to a closed port rather than refusing it, which is why `reachability` times out to "unreachable".
- **Hot-reload** — each imposter holds `Ref<ReadonlyArray<Stub>>` and `Ref<ProxyConfig | undefined>`. `updateStubs(id)` / `updateProxyConfig(id)` re-read from the repository and `Ref.set`. The fetch handler reads the `Ref` on every request, so changes take effect immediately with no restart.
- **Runtime abstraction** — `ServerFactory` is a `Context.Service` with two implementations: `NodeServerFactoryLive` (`node:http`, the default) and `BunServerFactoryLive` (`Bun.serve`). This exists because **vitest workers run under Node.js even when invoked via Bun**, so tests could not use `Bun.serve` directly. It later became the user-facing `--runtime node|bun` flag.
- **Callbacks and hops** — `matching/Callbacks.ts` runs a response's `before` calls (sequential, or `parallel`); the pure rules are `CallbackRules.ts`, the hop header logic `Hops.ts`. Every outbound call, callback or proxy, goes through `OutboundHttp`: it sends `x-imposters-hop` = incoming + 1, refuses past `MaxHops` (a `Context.Reference`, default 8, from `--max-hops` / `IMPOSTERS_MAX_HOPS`, passed as a trailing parameter of `makeMainLayer`), times out on the `Clock`, and records the outbound edge. `ImposterServer` builds one `OutboundHttp` per run whose recording checks `isCurrentRun`, so a stopped run's calls never count. A request at the limit that needs a call answers 508 with `x-imposters-loop`, and that 508 travels up whatever `onError` says; a call refused at the limit records no edge. `after` calls fork after logging into a per-run `FiberSet`, closed before `server.stop`, so a stopped run fires nothing; they settle their `pending` records with `RequestLogger.settleCallback`. A run allows 64 callback calls in flight and refuses rather than queues. Preview passes `requestOnly(ctx)` and never calls out.
- **`{{key}}` resolves on demand** (`TemplateEngine.substituteInString` + `resolveTemplateKey`): nothing flattens the context, so a large or deep callback answer costs only the leaf a template names. An inserted value is never `{{key}}`-templated again, but the `${expr}` pass that follows still sees it (old behaviour, a known follow-up: a client's `${…}` in a query value is evaluated). `test/matching/TemplateEngine.prop.test.ts` keeps the old eager flatten + `replaceAll` as an oracle.
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
    route.ts               # substituteParams — legacy, no caller in src/ (DEVELOPMENT.md backlog)
  extensions/
    Extension.ts           # the extension point (core-owned)
    <name>/                # one folder per extension; imported only from src/cli/
    s3/                    # S3Extension, Operation (routing), Kernel (pure store), Render, Xml, S3Error
  layers/
    MainLayer.ts           # makeMainLayer(extensions, host, adminPort?); MainLayer = makeMainLayer([])
    ApiLayer.ts            # HttpApiBuilder.layer + OpenAPI/Swagger + decode-error body + quiet logging
  matching/
    RequestMatcher.ts      # predicate evaluation, findMatchingStub
    Explain.ts             # pure: why each stub did or didn't match; its verdict IS evaluatePredicate's
    Preview.ts             # previewStub: a candidate stub against the unmatched groups
    ResponseGenerator.ts   # response selection + buildResponse
    TemplateEngine.ts      # {{key}} substitution, resolved on demand
    Callbacks.ts           # runs before/after callbacks; CallbackRules.ts (pure rules), Hops.ts (hop header)
    ExpressionEvaluator.ts # ${expr} via JSONata
  repositories/
    ImposterRepository.ts  # Ref<HashMap<id, config + stubs>>
  schemas/
    common.ts              # branded types, enums, pagination, errors
    ImposterSchema.ts
    StubSchema.ts          # Stub, Predicate, ResponseConfig, AddStubRequest (adds `index`)
    IssueMessages.ts       # SchemaError → plain-English messages (stub rules; reusable for the API's 400s)
    ExplainSchema.ts       # explain and preview response shapes
    RequestLogSchema.ts
    ConfigFileSchema.ts
  types/
    bun.d.ts               # minimal ambient `Bun` global (serve/port/stop), possibly undefined
  server/
    AdminServer.ts
    ImposterServer.ts      # the core: start/stop/updateStubs/updateProxyConfig
    FiberManager.ts        # FiberMap wrapper
    AdminPort.ts           # Context.Reference: the admin port, so /_admin can link back to /_ui
    MaxHops.ts             # Context.Reference: the hop limit (default 8)
    ServerFactory.ts       # Node + Bun implementations
  services/
    AppConfig.ts           # Effect.Config, env-driven
    PortAllocator.ts       # Ref<HashSet<number>>, TOCTOU-safe
    ProxyService.ts        # forward (through OutboundHttp from its context) + recordAsStub
    OutboundHttp.ts        # every outbound call: hop header, limit, timeout, edge recording
    OutboundEdges.ts       # pure: per-host outbound edges (50 hosts, p50/p95, timeline), beside MetricsAggregates
    RequestLogger.ts       # bounded per-imposter log + PubSub
    MetricsService.ts      # counts, percentiles, error rate
    Uuid.ts / UuidLive.ts
  ui/
    UiRouter.ts            # per-imposter /_admin — plain URL matcher, returns Response | null; GET /_admin/events is the SSE stream; POST /_admin/requests/:id/replay goes through ImposterServer's serve (deps.serveRequest)
    LiveData.ts            # pure data for the live view; RequestsData.ts (list filters, request page, explain rows); stubDraft.ts ("stub it" drafts); resend.ts (toCurl, replayRequest); forms.ts (formString); crossSite.ts (the shared POST guard)
    StubsData.ts           # the stubs page's view-model: cards, next marker, delay labels, the fallback line
    editor/                # draftText.ts (text ⇄ stub draft, line/column errors), formModel.ts (draft ⇄ form state, edits; pure), formView.ts (each form control's attributes, shared by server and runtime): the three import only each other, editor.js bundles them; checkStub.ts (server-side check)
    html.ts                # tagged-template engine with auto-escaping
    assets/                # generated.ts (committed, from ui-assets/ by `bun gen-ui-assets`), serve.ts (hashed, immutable, ETag)
    components/            # shell (data-theme, hashed asset links), header, imposterHeader (tabs), primitives (postButton…), sparkline (pure points()), format
    theme.ts               # themeFromCookie (imposters-theme)
    pages/                 # live, stubs (stubForm.ts is the editor's form view and row templates), requests, request-detail; all on components/shell.ts
    admin/                 # global /_ui dashboard: AdminUiRouter (forms: 303 without JS, fragments with), OverviewData (decodes the API), pages/Overview.ts
ui-assets/                 # UI sources: tokens.css, fonts.css, ui.css, ui.ts (runtime on every page; dispatches ui:init), editor-main.ts (editor.js, stubs page only) with editor.ts, form.ts, applyEdit.ts, textEdit.ts; own tsconfig, rootDir "." so it can bundle src/ui/editor/{draftText,formModel,formView}.ts
scripts/ui-assets.ts       # the asset generator (gen-ui-assets.ts is its CLI)
test/                      # mirrors src/, plus test/e2e/ and test/helpers/
examples/                  # config files, e.g. s3.json (an S3 imposter on 7070), ui-showcase.json (the screenshots script's data, incl. a `POST /checkout` with callbacks), callbacks.json (four imposters calling each other, 3301–3304)
```

## Development Commands

```bash
bun check          # tsc -b tsconfig.json — runs TypeScript 7 (native); see "Two TypeScript installs" under Environment
bun lint           # eslint
bun lint-fix
bun run test       # vitest --run (single run, NOT watch; ~3s — files run in parallel)
bun coverage
bun run build      # codegen + esm + cjs + esbuild CLI bundle + postbuild
bun run verify-dist  # after a build: import()/require() every dist export in plain Node, run the bin, GET /_ui and a hashed asset
bun run screenshots  # needs Google Chrome: starts examples/ui-showcase.json (admin 2599, imposters 3201–3206), sends traffic, writes screenshots/ in both themes
bun gen-ui-assets    # regenerate src/ui/assets/generated.ts from ui-assets/ (codegen and the build run it; a freshness test fails while it is stale)
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

No `any` survives. About seven non-null assertions do (regex-match and index access in `AdminUiRouter`, `UiRouter`, `RequestMatcher`, `ImposterRepository`, `HandlerHttpClient`), plus the `as` casts in `src/client/testing.ts`. Clean them up rather than copying them.

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
- **A `query` on an endpoint makes the generated client require `query`,** even when every field is optional, and it encodes it at runtime too. Adding one to an existing endpoint breaks every caller, which is why addStub's insert `index` is a body field (`AddStubRequest`, never stored on the stub).
- `HttpApiGroup.make("system", { topLevel: true })` puts endpoints at the client root, not under `.system`.
- The generated client expects the **decoded** type (with brands), not the encoded form — pass `protocol: "HTTP"`, `adminPath: "/_admin"`, a branded `PortNumber`, etc.
- `Layer.provideMerge(self)(that)` feeds **self's** output into **that's** input (order reads backwards).
- v4 shares one layer memo map across `Effect.provide` calls, so `MainLayer` listing a layer twice still builds it once. `HttpRouter.toWebHandler` gets its own memo map, so each test's handler is isolated.

**Testing**
- `@effect/vitest`'s `it.effect` runs on a `TestClock` that starts at 0. Anything compared against `Clock` must also come from `Clock` (`yield* DateTime.now`), never `DateTime.nowUnsafe()`.
- Scoped layers (`FiberMap` etc.) in tests use `ManagedRuntime.make(layer)` + `afterAll(() => runtime.dispose())` + plain vitest `it()` with `await runtime.runPromise(...)`. On v3, `it.effect` with `Layer.scoped` hung forever; not re-verified on v4, so keep the pattern.
- vitest workers are Node.js processes even under Bun — `Bun.serve` is unavailable. Use `NodeServerFactoryLive` (see `test/helpers/NodeServerFactory.ts`). vitest 5 needs Node `^22.12`; CI pins Node 22 in `.github/actions/setup`.
- Test files run in parallel and bind real, fixed ports, so **each file owns its own port block** (e.g. `ImposterServer` 91xx, `stub-matching` 92xx, `ServerFactory` 97xx, S3 88xx, explain/preview 946x, UI assets 966x, delay ranges 867x, admin UI 9901–9929, UI showcase 8521–8529, live events 9021–9029, imposter UI 9601–9640, stub editor 8701–8710, request detail/replay 9561–9569, callbacks 8901–8929 (8929 never bound: a refused target), callback loops 8931–8949, UI callbacks 8401–8429). Grep before picking one. Auto-allocated ports (3000+) are per-file and collide, so never start an imposter without an explicit port.
- No sleeps after start/stop: they resolve once the port is bound/released. To assert on listener state use `test/helpers/net.ts` (`httpGet` opens a fresh connection, `probeConnect`, `occupyPort`), not `fetch`: undici's keep-alive pool can reuse a socket and mask the answer.
- **`ui-assets/ui.ts` is tested in happy-dom,** opted into per file with `// @vitest-environment happy-dom` (everything else stays on node), against a fake `EventSource` and `fetch`.
- **`/_ui` POSTs and every non-GET `/_admin` request refuse cross-site requests** (403, `src/ui/crossSite.ts`): `Sec-Fetch-Site: cross-site`, or, when the header is `same-site` or absent, an `Origin` whose host differs from the request's. Every `/_admin` state change is behind it: the stub writes (`POST /_admin/stubs`, `/stubs/:id`, `/stubs/:id/delete`, `/stubs/preview`) and `/requests/clear`, `/requests/test`, `/requests/:id/replay`. Keep that guard on any new UI form endpoint: the admin API has no auth, and a form post needs no CORS preflight.
- **No CDN, no htmx:** `test/ui/self-hosted.test.ts` fails on any `unpkg`, `cdn.`, `htmx` or `hx-` in `src/` (generated assets included) or `ui-assets/`.
- **UI tokens:** every `--im-*` value must match `site/src/styles/theme.css` (a test checks it); UI-only tokens are `--ui-*`. The `imposters-theme` cookie is set on both `/_ui` and `/_admin`.
- **Randomness goes through Effect's `Random`** (delay ranges, random response mode), never `Math.random`. In tests, fix it with `Effect.provideService(Random.Random, { nextDoubleUnsafe: () => d, nextIntUnsafe: () => 0 })` or `Random.withSeed(seed)`. `Random.nextIntBetween(min, max)` includes both ends unless `{ halfOpen: true }`.
- **SSE streams subscribe before their first chunk** (`RequestLogger.follow` returns a scoped Stream), and every stream does `Stream.interruptWhen(shutdown)` on the run's Deferred, so it ends on stop even on a server that never cancels a body.
- **Property tests:** use `@effect/vitest`'s `it.prop` (sync) or `it.effect.prop` (returns an Effect; wrap async driving in `Effect.promise`). Inputs are Schemas or `effect/unstable/arbitrary/Arbitrary`s, so describe them as a Schema (e.g. a tagged union of steps). Options go in the 4th argument: `{ timeout, arbitrary: { runs, size, seed } }`; `size` bounds collection lengths. With `vi.useFakeTimers`, fake only `setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`/`Date`: Effect's scheduler uses `setImmediate`, and faking it hangs the property. Pin each shrunk counterexample as a plain test. Reach for this for any state machine (see `test/ui/runtime-live.prop.test.ts`, `test/ui/runtime-editor.prop.test.ts` with `test/helpers/stubEditor.ts`, and `test/ui/{formModel,runtime-form}.prop.test.ts` with `test/helpers/formDrafts.ts`). Compare drafts with `shape()` from formDrafts, not `toStrictEqual`: it reads an own `"constructor"` key as the object's class, so two such objects never match.
- **The modules editor.js bundles** (`src/ui/editor/{draftText,formModel,formView}.ts`) import nothing but each other: no Effect. formModel restates the schema's literals; `formModel.test.ts` checks they match.
- **happy-dom quirks:** a select's value does not follow a `selected` attribute set after parsing (browsers do), so form.ts sets both; compare selects by `option[selected]`. It does not drop the newline after `<textarea>` either, and it flags valid number text like `1e3` as `badInput`.
- **A test layer that builds `ProxyServiceLive` or `ImposterServerLive` by hand** must also provide `OutboundHttpLive.pipe(Layer.provide(MetricsServiceLive))`.
- **`Effect.context<never>()` inside `ImposterServer.start` captures the caller's context, not the layer's,** so services the engine needs (`OutboundHttp`) are yielded at layer build and passed with `Effect.provideService`.
- `fetch`'s body type wants `Uint8Array<ArrayBuffer>`, not `Uint8Array`. `Schema.optional(Schema.Never)` refuses a field (a 400) rather than stripping it.
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

- `src/Program.ts` is a one-liner; the real entry point is `src/cli/Commands.ts`, which calls `Command.run` + `NodeRuntime.runMain` at module scope. That is why `generateIndex` excludes both: a root `import "imposters"` would otherwise parse the consumer's `process.argv` and `process.exit(1)` on an unknown flag. They stay subpath exports.
- **Imports need `.js` extensions (NodeNext).** `tsc` emits specifiers as written and Node's ESM loader wants the file, so every relative import in `src/` ends in `.js` (`./dir/index.js` for a directory). `tsconfig.src.json` (and so `tsconfig.build.json`) uses `module`/`moduleResolution: NodeNext`, so a missing extension is a `bun check` error (TS2835). `test/` stays on `Bundler` from the base config, since it imports through the `imposters/*` aliases. `bun run verify-dist` loads every `exports` entry from a temp consumer in plain Node; it runs in the Check workflow's Build job and in publish's "Verify dist". After `rm -rf build`, also delete `.tsbuildinfo/`, or `bun check` trusts stale build info and reports TS6305.
- The CLI ships as an **esbuild CJS bundle** (`dist/bin/cli.cjs`, target node18) because the ESM library build was not usable as a Node `bin`. `bin/imposters` is a three-line shim that `require`s it.
- `scripts/postbuild.ts` copies the shim into `dist/bin/`, chmods it 755, injects the `bin` field into `dist/package.json`, copies `.npmrc`, and copies the fonts' OFL licenses to `dist/licenses/`.
- **The index codegen takes the first multi-line `/**` comment in a module as its doc in `src/index.ts`.** Give functions `//` or single-line `/** */` comments, or the barrel changes. `bun run build` also adds blank lines to `src/index.ts`; revert that churn.
- **`src/cli/version.ts` is intentionally `"0.0.0"`.** CI `sed`s the real version into the bundle and both `dist/dist/{cjs,esm}/cli/version.js` at publish time. Do not "fix" it.
- Publishing uses npm **trusted publishing / OIDC**: `NODE_AUTH_TOKEN: ""` with `id-token: write` and `--provenance`. The empty token is intentional.
- Each release attaches `npm pack dist/` as `imposters-<version>.tgz` to its GitHub release, for networks where the public npm registry is blocked. The workflow checks the file's integrity against `npm view dist.integrity` and only warns on a mismatch. v0.5.0's file was uploaded by hand; its files match npm's.
- **Only code changes release.** The publish run releases only when a commit since the last tag is `feat`, `fix`, `perf`, `refactor` or `revert`, or is marked breaking with `!`. It reads subjects only (`%s`), so a `BREAKING CHANGE` footer in a body is ignored. A run of only `docs`/`chore`/`ci`/`test`/`style`/`build` commits publishes nothing. `workflow_dispatch` with a `version` always releases. CONTRIBUTING.md's release table mirrors this.
- Version base is the higher of (npm published version, latest git tag), then bumped by scanning conventional commits.
