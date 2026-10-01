---
title: CLI
description: The imposters start command, its flags and the environment variables it reads.
---

```bash
imposters start [flags]
```

`start` runs the admin server and keeps running until it receives `SIGINT` or `SIGTERM`. Stopping it stops every imposter: imposters live in memory and do not survive a restart.

## Flags

| Flag | Alias | Description |
|---|---|---|
| `--port <number>` | `-p` | Admin server port. Default `2525`, or the `ADMIN_PORT` environment variable. |
| `--config <path>` | `-c` | A JSON [config file](../config-file/) of imposters to create and start. |
| `--host <address>` | | The address the admin server **and every imposter** bind to. Default `127.0.0.1`, or the `IMPOSTERS_HOST` environment variable. |
| `--runtime <node\|bun>` | | The server runtime for the admin server. Default `node`. |

`imposters --help` and `imposters start --help` list them, along with the global `--version` and `--log-level` flags.

## `--host`: who can reach it

Every server binds the loopback address `127.0.0.1` by default, so nothing off the machine can reach the admin API or any imposter.

```bash
imposters start --host 0.0.0.0
```

```text
Imposters admin server running on http://localhost:2525 (bound to 0.0.0.0, runtime: node)
Admin UI: http://localhost:2525/_ui
```

`0.0.0.0` binds every interface. You need it inside a container, where the port is published from the container's own network interface.

:::caution
The admin API has no authentication, and it can create proxies that forward requests anywhere. Bind `0.0.0.0` only where the network is trusted, such as inside a container.
:::

The flag wins over `IMPOSTERS_HOST`, which wins over the default:

```bash
IMPOSTERS_HOST=0.0.0.0 imposters start
```

## `--runtime`

`node` (the default) serves the admin API with `node:http`. `bun` serves it with `Bun.serve`, and needs the CLI to run under Bun:

```bash
bun node_modules/imposters/bin/cli.cjs start --runtime bun
```

```text
Imposters admin server running on http://127.0.0.1:2525 (bound to 127.0.0.1, runtime: bun)
Admin UI: http://127.0.0.1:2525/_ui
```

Under Node.js, `--runtime bun` fails with a message that says so and exits.

:::note
The flag applies to the admin server only. Imposters always use `node:http`, which under Bun runs on Bun's Node.js compatibility layer.
:::

## Exit codes and startup errors

The server exits non-zero, with a one-line message, when:

- the admin port cannot be bound (`Failed to start admin server on port 2525: ...`);
- the config file cannot be read, is not valid JSON, fails validation, or one of its imposters cannot be created, stubbed or started (`Failed to load config: ...`).

When a config file loads, every imposter in it is running before the admin server starts answering.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `ADMIN_PORT` | `2525` | Admin server port, when `--port` is not given. |
| `IMPOSTERS_HOST` | `127.0.0.1` | Bind address, when `--host` is not given. |
| `PORT_RANGE_MIN` | `3000` | Lowest port allocated to an imposter created without a `port`. |
| `PORT_RANGE_MAX` | `4000` | Highest such port. |
| `MAX_IMPOSTERS` | `100` | Creating more imposters than this fails. |
