---
title: Config file
description: Declare imposters, their stubs and proxies in a JSON file and load it at startup.
---

A config file declares imposters and their stubs, for a setup you can commit and repeat. Pass it with `--config` (or `-c`):

```bash
imposters start --config imposters.json
```

For each imposter in the file, in order, the CLI creates it, adds its stubs and starts it, through the same admin API you would call yourself. Every one is running before the admin server starts answering:

```text
Created HTTP imposter "payments-api" on port 4000
Imposters admin server running on http://127.0.0.1:2525 (bound to 127.0.0.1, runtime: node)
Admin UI: http://127.0.0.1:2525/_ui
```

A file that does not load completely is fatal: if it is unreadable, is not valid JSON, fails validation, or one imposter cannot be created or started (its port is taken, say), the CLI prints `Failed to load config: ...` and exits non-zero.

## Format

```json
{
  "imposters": [
    {
      "name": "payments-api",
      "port": 4000,
      "stubs": [
        {
          "predicates": [
            { "field": "method", "operator": "equals", "value": "POST" },
            { "field": "path", "operator": "equals", "value": "/charges" }
          ],
          "responses": [
            {
              "status": 201,
              "body": {
                "id": "ch_001",
                "amount": "${request.body.amount}",
                "currency": "${$uppercase(request.body.currency)}",
                "status": "succeeded"
              }
            },
            { "status": 402, "body": { "error": "card_declined" } }
          ]
        },
        {
          "predicates": [
            { "field": "method", "operator": "equals", "value": "GET" },
            { "field": "path", "operator": "startsWith", "value": "/customers/" }
          ],
          "responses": [
            {
              "headers": { "x-served-by": "imposters" },
              "body": { "path": "{{request.path}}", "plan": "pro" }
            }
          ]
        }
      ]
    }
  ]
}
```

### Imposter fields

| Field | Required | Description |
|---|---|---|
| `port` | yes | The port the imposter listens on, `1024` to `65535`. |
| `name` | no | A label shown in the UIs and the CLI output. |
| `protocol` | no | `"HTTP"` (the default) or an extension protocol such as `"S3"` ([S3 emulator](../s3/)). |
| `stubs` | no | [Stubs](../stubs/), matched in the order listed. Default `[]`. |
| `proxy` | no | A [proxy](../proxy/) for requests no stub matches. HTTP imposters only. |

A stub in the file has the same shape as the body of `POST /imposters/:id/stubs`: `predicates`, `responses` and `responseMode`.

### The `admin` block

The format also accepts an `admin` object (`port`, `portRangeMin`, `portRangeMax`, `maxImposters`, `logLevel`), and validates it, but the CLI does not apply it. Set the admin port with `--port` or `ADMIN_PORT`, and the port range and limit with the [environment variables](../cli/#environment-variables).

## An S3 imposter

The repository's [`examples/s3.json`](https://github.com/eliraz-refael/imposters/blob/master/examples/s3.json) starts an in-memory S3 on port `7070`:

```json
{
  "imposters": [
    { "name": "local-s3", "port": 7070, "protocol": "S3" }
  ]
}
```

## A recording proxy

```json
{
  "imposters": [
    {
      "name": "recorder",
      "port": 4001,
      "proxy": { "targetUrl": "https://api.example.com", "mode": "record" }
    }
  ]
}
```
