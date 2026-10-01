---
title: Stubs and predicates
description: How a stub decides whether it answers a request, field by field and operator by operator.
---

A **stub** is a list of **predicates** and a list of [responses](../responses/):

```json
{
  "predicates": [
    { "field": "method", "operator": "equals", "value": "GET" },
    { "field": "path", "operator": "startsWith", "value": "/api/" }
  ],
  "responses": [{ "status": 200, "body": { "ok": true } }]
}
```

## How matching works

- The predicates of a stub are AND-combined: the stub matches when **every** predicate passes. A stub with no predicates (or `"predicates": []`) matches every request.
- An imposter checks its stubs **in order** and the **first** match answers. Stubs are kept in the order they were added; a stub added later never shadows an earlier one.
- When no stub matches, the request goes to the imposter's extension (such as [S3](../s3/)), then its [proxy](../proxy/), and otherwise gets a `404` with `{"error":"No matching stub found","method":"...","path":"..."}`.

## Predicate

| Key | Required | Description |
|---|---|---|
| `field` | yes | `method`, `path`, `headers`, `query` or `body` |
| `operator` | yes | `equals`, `contains`, `startsWith`, `matches` or `exists` |
| `value` | yes for all but `exists` | What to compare with. A string for `method` and `path`; an object for `headers` and `query`; any JSON for `body` |
| `caseSensitive` | no | Default `true`. With `false`, strings compare ignoring case and `matches` uses the `i` flag |

## Fields

| Field | What it is matched against |
|---|---|
| `method` | The method, uppercase: `GET`, `POST`, ... |
| `path` | The URL path, without the query string: `/users/1` |
| `headers` | The request headers. Header names are **lowercase**, so write them lowercase in predicates (or set `caseSensitive: false`) |
| `query` | The query string parameters, as strings |
| `body` | The body: parsed JSON when the `content-type` contains `application/json` and the body parses, otherwise the UTF-8 text. An empty or binary body has no value |

## Operators

| Operator | `method`, `path` | `headers`, `query` | `body` |
|---|---|---|---|
| `equals` | Exact string | Every listed key is present and its value equals | Deep subset match (see below) |
| `contains` | Substring | Every listed value contains | Substring of the body (JSON is compared as its serialized text) |
| `startsWith` | Prefix | Every listed value starts with | Prefix of the body text |
| `matches` | Regular expression | Every listed value matches its regular expression | Regular expression on the body text |
| `exists` | Always passes | Every listed key is present; values are ignored | The body is not empty |

### `headers` and `query`

The `value` is an object. Every key in it must be present in the request, and every value must pass the operator. Values must be strings:

```json
{ "field": "query", "operator": "equals", "value": { "q": "ada", "page": "1" } }
```

With `exists`, only the keys count. Header-name lookup is case-insensitive for `exists`:

```json
{ "field": "headers", "operator": "exists", "value": { "authorization": "" } }
```

### `body` and `equals`: a subset match

`equals` on the body passes when the expected value is a **subset** of the actual one:

- an object matches when every expected key matches, recursively; extra keys in the request are fine;
- an array matches element by element, for as many elements as the expected array has;
- strings, numbers and booleans must be equal (strings ignore case with `caseSensitive: false`).

```json
{
  "predicates": [
    { "field": "method", "operator": "equals", "value": "POST" },
    { "field": "body", "operator": "equals", "value": { "action": "create" } }
  ],
  "responses": [{ "status": 201 }]
}
```

This matches `{"action": "create", "name": "x"}` but not `{"action": "delete"}`. Remember the body is parsed as JSON only when the request's `content-type` says `application/json`.

### `matches`

The value is a JavaScript regular expression source, without slashes. Escape backslashes in JSON:

```json
{ "field": "path", "operator": "matches", "value": "^/users/\\d+$" }
```

## Managing stubs

| Request | Effect |
|---|---|
| `POST /imposters/:id/stubs` | Add a stub at the end. Answers with the stored stub and its generated `id` |
| `GET /imposters/:id/stubs` | List the stubs, in matching order |
| `PUT /imposters/:id/stubs/:stubId` | Replace any of `predicates`, `responses`, `responseMode`; omitted keys stay |
| `DELETE /imposters/:id/stubs/:stubId` | Remove a stub |

Changes apply to a running imposter on the next request, with no restart. For example, changing a response:

```bash
curl -X PUT http://localhost:2525/imposters/2f334551/stubs/7a1d5d07 \
  -H "Content-Type: application/json" \
  -d '{"responses": [{"body": {"path": "{{request.path}}", "plan": "enterprise"}}]}'

curl http://localhost:4000/customers/42
```

```json
{"path":"/customers/42","plan":"enterprise"}
```
