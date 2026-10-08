---
title: Callbacks
description: Responses that call other services before they answer, and webhooks after, with loop protection.
---

A response can call other services. `before` calls run before it is built, and their results feed its templates as `callbacks.<name>`. `after` calls fire once it is ready, like webhooks. A few imposters can then stand in for a system: a gateway that aggregates two backends and notifies a third.

The repository's [`examples/callbacks.json`](https://github.com/eliraz-refael/imposters/blob/master/examples/callbacks.json) starts a checkout on port `3301` that calls carts (`3302`) and pricing (`3303`), then posts an event to `3304`. Its checkout response:

```json
{
  "status": 201,
  "callbacks": {
    "before": [
      { "name": "cart", "url": "http://127.0.0.1:3302/carts/{{request.query.cart}}" },
      {
        "name": "price",
        "method": "POST",
        "url": "http://127.0.0.1:3303/quote",
        "body": { "items": "${callbacks.cart.body.items}" },
        "timeout": 2000,
        "onError": "fail"
      }
    ],
    "after": [
      {
        "name": "notify",
        "method": "POST",
        "url": "http://127.0.0.1:3304/events",
        "body": { "type": "checkout", "cart": "{{request.query.cart}}", "total": "${callbacks.price.body.total}" }
      }
    ]
  },
  "body": {
    "cart": "{{request.query.cart}}",
    "items": "${callbacks.cart.body.items}",
    "total": "${callbacks.price.body.total}"
  }
}
```

```bash
npx imposters start --config examples/callbacks.json
curl -X POST "http://localhost:3301/checkout?cart=7"
```

```json
{"cart":"7","items":[{"sku":"tea","price":4},{"sku":"cake","price":6}],"total":10}
```

## Fields

`callbacks` sits on a response, beside `status` and `body`, so each response of a cycling stub can call different services.

| Field | Default | Description |
|---|---|---|
| `before`, `after` | `[]` | The calls. At most `10` in all |
| `parallel` | `false` | Run the `before` calls at once instead of in order |
| `name` | *(required)* | Letters, digits and `_`, starting with a letter or `_`, up to 64 characters. Unique within the response. No hyphens: JSONata would read one as a minus |
| `method` | `GET` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` or `OPTIONS`. A `GET` or `HEAD` cannot have a `body` |
| `url` | *(required)* | Must start with a literal `http://` or `https://`. The rest is templated |
| `headers` | none | Header names to string values. Templated |
| `body` | none | Any JSON value, templated. If it is still a string after templating it is sent as `text/plain`, anything else as JSON, unless `headers` names a `content-type`. So `"${callbacks.cart.body.items}"` sends JSON |
| `timeout` | `5000` | Milliseconds to wait for the answer, `100` to `60000` |
| `onError` | `continue` | `before` calls only: `continue` or `fail` (see [Failures](#failures)). On an `after` call it is refused: a `400` from the API, a load failure in a config file |

A call sends only its own `headers`, plus `x-imposters-hop` (see [Loops](#loops)). The incoming request's headers are never copied.

## What templates see

Each `before` call's result is `callbacks.<name>`, for both [`{{key}}` and `${expr}`](../responses/#templating):

| Key | Value |
|---|---|
| `callbacks.<name>.ok` | `true` for a `2xx` answer, `false` otherwise or when no answer came back |
| `callbacks.<name>.status` | The status, when an answer came back |
| `callbacks.<name>.headers.<name>` | An answer header; the name in lowercase |
| `callbacks.<name>.body` | The answer's body: JSON when its content-type says JSON and it parses, else text. Absent when empty or binary |
| `callbacks.<name>.durationMs` | How long the call took |
| `callbacks.<name>.error` | Why no answer came back: a timeout, a refused connection, an invalid url, a body over 1 MiB |

`${callbacks.cart.body.items}` on its own keeps its JSON type, here an array; `{{callbacks.cart.status}}` inserts `"200"`. A failed call has no `body`, so `${callbacks.price.body.total}` is left as written. Branch on `ok` instead: `"${callbacks.price.ok ? callbacks.price.body.total : 0}"`.

Values from the request or a callback are inserted as data and never evaluated, in a url, headers and body alike: a `${` a client sends stays text (and in a url, fails the call as half-templated). Inside `${…}`, use `callbacks.cart.body.id` rather than `{{…}}`.

- **In order** (the default), each call sees the request and every call before it, so one can fetch a token the next one sends.
- **`parallel: true`**: the calls run at once, and each sees only the request.
- **`after` calls** see the request and every `before` result.

### Values in a url

Template values go into a url as they are, as in any template: a `/` or `?` in a value changes the path or the query. To insert a value as one path segment, encode it with JSONata:

```text
http://127.0.0.1:3002/items/${$encodeUrlComponent(request.query.name)}
```

A url that is still half-templated after templating (a `{{` or `${` left in it), or that is not `http` or `https`, fails without sending anything.

## Failures

With `onError: "continue"`, a failed call is data: the response is built anyway, and its templates see `ok: false` and the `error`. A `4xx` is always data, so a stub can pass on an upstream `404`.

With `onError: "fail"`, a call that gets no answer or a `5xx` turns the response into a `502`:

```json
{"error":"Callback failed","callback":"price","status":503}
```

`reason` replaces `status` when no answer came back. The remaining `before` calls are not sent, parallel ones still running are interrupted, and the `after` calls do not run.

A response whose templates cannot be built from the answers (a header value with a line break, say) is a `500` with `{"error": "Response template failed", "reason": ...}`, and its `after` calls do not run.

## Order and timing

1. The `before` calls, in order or in parallel.
2. The response's [`delay`](../responses/#delays), which adds to the calls: it is the service's own think time.
3. The response is built and logged.
4. The `after` calls start, in order, and the response is sent.

The log entry's `duration` covers steps 1 to 3. A failing `after` call never changes an answer already sent. Stopping the imposter interrupts its callback calls in flight, so a stopped imposter sends no webhooks.

The request is logged with each `after` call in state `pending`. Each record settles in place, to `answered`, `failed` or `skipped`, when its call ends; read the log again to see it.

## Loops

Every outbound call, callback or [proxy](../proxy/) forward, sends `x-imposters-hop`: the hop the request arrived with (`0` when absent), plus one. A request that arrives at the limit and would have to call out is answered `508`, with `x-imposters-loop: <limit>`:

```json
{"error":"Loop detected","hop":8,"limit":8}
```

- The limit is `8`, set process-wide with [`--max-hops`](../cli/#flags) or `IMPOSTERS_MAX_HOPS`.
- A `before` call answered `508` with `x-imposters-loop` fails its own response with a `508` too, whatever `onError` says, so the loop reaches the original client. A stub's own `508`, without the header, is an ordinary `5xx`: data under `continue`, a `502` under `fail`.
- A request that needs no call is served at any hop. An `after` call past the limit is recorded `skipped`, and the response is still sent.
- An imposter may call itself: each level of the loop is its own request in the log.

Each imposter has at most **64** callback calls in flight. A call past that fails at once with `too many callbacks in flight`, rather than waiting, so a fan-out that calls itself cannot pile up.

## Seeing the calls

The [request log](../requests-and-stats/#request-log) entry of a response with callbacks has `callbacks`, one record per call, `before` first:

```json
[
  {"name":"cart","phase":"before","method":"GET","url":"http://127.0.0.1:3302/carts/7","state":"answered","status":200,"durationMs":5,"responseBody":"{\"items\":[{\"sku\":\"tea\",\"price\":4},{\"sku\":\"cake\",\"price\":6}]}"},
  {"name":"price","phase":"before","method":"POST","url":"http://127.0.0.1:3303/quote","state":"answered","status":200,"durationMs":97,"requestBody":"{\"items\":[{\"sku\":\"tea\",\"price\":4},{\"sku\":\"cake\",\"price\":6}]}","responseBody":"{\"total\":10}"},
  {"name":"notify","phase":"after","method":"POST","url":"http://127.0.0.1:3304/events","state":"answered","status":202,"durationMs":2,"requestBody":"{\"type\":\"checkout\",\"cart\":\"7\",\"total\":10}"}
]
```

`url` is the templated url, or the template when templating failed or the call is still `pending`. `state` is `answered`, `failed`, `skipped` (never sent), or `pending`. Each body is kept up to its first 2 KiB; headers are not kept.

In the [web UI](../web-ui/), a request's page lists these records in its **outbound calls** panel, and each stub card names its responses' calls and their hosts.

The [stats](../requests-and-stats/#stats) count every call sent, and every call refused because 64 were in flight, as an `outbound` edge of its target host, with failures and latency.

## Preview, playground and replay

- The stub editor's preview and `POST /imposters/:id/stubs/preview` never call out: the templates see no `callbacks`, so `{{callbacks.…}}` and a plain `${callbacks.…}` are shown as written, and the editor says so. An expression that handles a missing result, such as the `ok` branch above, gives its fallback.
- The [playground](../../#playground) on the home page does not run callbacks either: it accepts them, and answers as the preview does.
- A replay from the request page in the [web UI](../web-ui/) is a real request: it runs the callbacks again.

The stub editor's form has no section for callbacks yet, so a stub with callbacks opens in the JSON view.

:::caution
Callbacks, like proxies, make the machine send requests to any URL it can reach: your network, or a cloud metadata address such as `169.254.169.254`. The admin API has no authentication. Keep the default loopback [bind address](../cli/#--host-who-can-reach-it) unless the network is trusted, and on an imposter others can reach, never template a callback's host from request data: that makes it an open relay.
:::
