---
title: Responses
description: Status, headers and body, templating with {{key}} and ${JSONata}, response cycling and delays.
---

A stub's `responses` is a non-empty list. Each response is:

| Key | Default | Description |
|---|---|---|
| `status` | `200` | HTTP status, `100` to `599` |
| `headers` | none | An object of header names to string values. Values are templated |
| `body` | none | Any JSON value. A string is sent as-is; anything else is sent as JSON. Templated |
| `delay` | none | Milliseconds to wait before answering, `0` to `60000`, or a range `{ "min", "max" }` to draw from (see [Delays](#delays)) |
| `callbacks` | none | Calls to other services, before answering and after (see [Callbacks](../callbacks/)) |

When `headers` has no `content-type`, a string body is sent as `text/plain` and any other body as `application/json`. A `204`, `205` or `304` is sent without a body.

## Templating

Strings anywhere in `body`, and header values, can use two kinds of placeholder. `{{key}}` substitution runs first, then `${expr}` JSONata expressions.

### `{{key}}`: substitution

`{{key}}` is replaced with a value from the request, or from a [callback](../callbacks/#what-templates-see)'s answer:

| Key | Value |
|---|---|
| `request.method` | `GET`, `POST`, ... |
| `request.path` | The path, without the query string |
| `request.headers.<name>` | A header; the name in lowercase |
| `request.query.<name>` | A query parameter |
| `request.body.<path>` | A field of a JSON body, by dotted path. Array elements by index: `request.body.items.0` |
| `callbacks.<name>.<path>` | A `before` callback's result: `ok`, `status`, `headers.<name>`, `body.<path>`, `durationMs`, `error` |

An object or array at a key is inserted as its JSON text. A key that the request does not have is left as written. Only the value a key names is looked up and converted to text, so a large callback answer is not stringified unless a template uses it whole.

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

### `${expr}`: JSONata

`${...}` evaluates a [JSONata](https://jsonata.org/) expression. Its input is `{ request: { method, path, headers, query, body } }`, plus `callbacks` when the response has [callbacks](../callbacks/).

```json
{
  "predicates": [{ "field": "path", "operator": "equals", "value": "/greet" }],
  "responses": [{
    "body": {
      "greeting": "${\"Hello, \" & request.query.name}",
      "itemCount": "${$count(request.body.items)}",
      "uppercasePath": "${$uppercase(request.path)}",
      "first": "{{request.body.items.0}}",
      "mixed": "total: ${$sum(request.body.items)} items"
    }
  }]
}
```

```bash
curl -X POST "http://localhost:3000/greet?name=Ada" \
  -H "Content-Type: application/json" \
  -d '{"items": [1, 2, 3]}'
```

```json
{"greeting":"Hello, Ada","itemCount":3,"uppercasePath":"/GREET","first":"1","mixed":"total: 6 items"}
```

- When a string is **exactly one** `${...}` expression, the result keeps its JSON type: `itemCount` above is the number `3`, not `"3"`. `{{key}}` always inserts text, so `first` is the string `"1"`.
- When an expression is mixed with other text, or there are several, the results are joined as text, and an object result is inserted as JSON.
- An expression that fails, or has no result, is left in the output as written.

## Several responses: `responseMode`

A stub with several responses picks one per request according to its `responseMode`:

| Mode | Behaviour |
|---|---|
| `sequential` (default) | In order, then around again: 1, 2, 3, 1, 2, ... |
| `repeat` | In order, then the last one forever: 1, 2, 3, 3, 3, ... |
| `random` | A random one each time |

```json
{
  "predicates": [{ "field": "path", "operator": "equals", "value": "/jobs/1" }],
  "responseMode": "repeat",
  "responses": [
    { "body": { "state": "queued" } },
    { "body": { "state": "running" } },
    { "body": { "state": "done" } }
  ]
}
```

Four requests to `/jobs/1` answer `queued`, `running`, `done`, `done`.

The position is kept per stub in the running imposter, so stopping and starting the imposter starts every stub from its first response again.

## Delays

`delay` holds the response back, to exercise timeouts and loading states:

```json
{
  "predicates": [{ "field": "path", "operator": "equals", "value": "/slow" }],
  "responses": [{ "status": 200, "delay": 1500, "body": "late" }]
}
```

```bash
curl -s -o /dev/null -w "%{time_total}s\n" http://localhost:3000/slow
```

```text
1.502136s
```

### Delay ranges

A fixed delay makes every answer equally slow. To simulate jitter, give `delay` a range instead: each time the response is served, Imposters waits a random whole number of milliseconds between `min` and `max`, both included.

```json
{
  "predicates": [{ "field": "path", "operator": "equals", "value": "/jittery" }],
  "responses": [{ "status": 200, "delay": { "min": 100, "max": 800 }, "body": "sometimes slow" }]
}
```

```bash
for i in 1 2 3; do curl -s -o /dev/null -w "%{time_total}s\n" http://localhost:3000/jittery; done
```

```text
0.614203s
0.137950s
0.402871s
```

Both bounds take `0` to `60000`, and `min` must not be above `max`; the API answers 400 otherwise, naming `["responses", 0, "delay", "max"]`. `{ "min": 500, "max": 500 }` behaves like `500`. Reading the stub back returns `delay` exactly as it was given, a number or a range.

The stub preview (`POST /imposters/:id/stubs/preview`) never waits, whichever form the delay takes.
