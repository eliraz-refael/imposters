---
title: TypeScript client and test helpers
description: The typed admin API client, and withImposter for setting up and tearing down imposters in tests.
---

The `imposters` package includes a typed client for the admin API, derived from the same schema as the server, and helpers for tests. Both are [Effect](https://effect.website) programs; your project needs `effect` as a dependency.

```bash
npm install --save-dev imposters effect
```

Import them from their modules:

| Module | Exports |
|---|---|
| `imposters/client/ImpostersClient` | `ImpostersClient`, `ImpostersClientFetchLive`, `ImpostersClientLive`, `makeImpostersClient` |
| `imposters/client/testing` | `withImposter`, `makeTestServer` |
| `imposters/schemas/common` | `PortNumber`, `NonEmptyString` and the other branded types the client expects |

## The client

`ImpostersClientFetchLive(baseUrl)` provides an `ImpostersClient` that calls a running admin server with `fetch`. Its methods mirror the [admin API](../admin-api/) and take `params`, `query` and `payload`:

```ts
import { Effect } from "effect"
import { ImpostersClient, ImpostersClientFetchLive } from "imposters/client/ImpostersClient"
import { NonEmptyString, PortNumber } from "imposters/schemas/common"

const program = Effect.gen(function*() {
  const client = yield* ImpostersClient

  const imposter = yield* client.imposters.createImposter({
    payload: {
      name: NonEmptyString.make("my-api"),
      port: PortNumber.make(4000),
      protocol: "HTTP",
      adminPath: "/_admin"
    }
  })

  yield* client.imposters.addStub({
    params: { imposterId: imposter.id },
    payload: {
      predicates: [],
      responses: [{ status: 200, body: { hello: "world" } }],
      responseMode: "sequential"
    }
  })

  yield* client.imposters.updateImposter({
    params: { id: imposter.id },
    payload: { status: "running" }
  })
})

await program.pipe(
  Effect.provide(ImpostersClientFetchLive("http://localhost:2525")),
  Effect.runPromise
)
```

```bash
curl http://localhost:4000/
```

```json
{"hello":"world"}
```

The client's inputs are the schema's **decoded** types: branded values such as `PortNumber` and `NonEmptyString` (build them with `.make`, which validates), and every field the server would otherwise default, such as `protocol`, `adminPath`, `predicates` and `responseMode`. Each method fails with the API's typed errors, for example `ApiConflictError` when the port is taken.

## `withImposter`

`withImposter(config, test)` creates an imposter, adds its stubs, starts it, runs your test, and deletes the imposter afterwards, whether the test passed or not. Its config takes plain values and fills the defaults for you:

```ts
import { Effect } from "effect"
import { makeTestServer, withImposter } from "imposters/client/testing"

const { clientLayer, dispose } = makeTestServer()

const test = withImposter(
  {
    port: 4001,
    name: "test-api",
    stubs: [{
      predicates: [{ field: "path", operator: "equals", value: "/greet" }],
      responses: [{ status: 200, body: { message: "hi" } }]
    }]
  },
  (ctx) =>
    Effect.gen(function*() {
      const res = yield* Effect.promise(() => fetch(`http://localhost:${ctx.port}/greet`))
      const body = yield* Effect.promise(() => res.json())
      console.log(res.status, JSON.stringify(body))
    })
)

await Effect.provide(test, clientLayer).pipe(Effect.runPromise)
await dispose()
```

```text
200 {"message":"hi"}
```

`ctx` has the imposter's `id` and `port`. The config's `protocol` defaults to `"HTTP"`.

### `makeTestServer`

`makeTestServer()` runs the admin API **in process**, with no admin port: the client talks to it through a handler, not a socket. Imposters still listen on their real ports, so your code under test reaches them over HTTP as usual. It returns:

- `clientLayer`: provides `ImpostersClient`, for `withImposter` or your own calls;
- `handler`: the admin API as a `(request: Request) => Promise<Response>` function;
- `dispose`: stops it; call it when your test suite ends.

To use an extension protocol such as S3 in tests, register it; without that, only `"HTTP"` imposters can be created:

```ts
import { S3Extension } from "imposters/extensions/s3/S3Extension"

const { clientLayer, dispose } = makeTestServer({ extensions: [S3Extension] })

const test = withImposter({ port: 7071, protocol: "S3" }, (ctx) =>
  Effect.gen(function*() {
    // an S3Client with endpoint `http://127.0.0.1:${ctx.port}` and forcePathStyle: true
  }))
```

To run against a separate admin server instead, provide `ImpostersClientFetchLive("http://localhost:2525")` to `withImposter`.

:::tip
Give each imposter in a test an explicit `port`, and keep the ports of parallel test files apart, so they never compete for one.
:::
