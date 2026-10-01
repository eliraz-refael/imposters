---
title: Overview
description: What Imposters is, how a request flows through it, and where to go next.
---

Imposters is a service virtualization tool. It runs mock servers, called **imposters**, that stand in for the services your code talks to: HTTP APIs, and an in-memory AWS S3. You program them while they run, over a REST API or from a JSON config file. It is inspired by [Mountebank](https://github.com/mountebank-testing/mountebank) and built with TypeScript and [Effect](https://effect.website). It runs on Node.js or Bun.

## How a request flows

1. **One admin server** listens on port `2525`. Its REST API creates imposters, adds stubs and reads back what each imposter received. It also serves a dashboard at [`/_ui`](web-ui/) and the [OpenAPI document](admin-api/).
2. **Each imposter listens on its own port.** Starting one binds that port; stopping it releases the port.
3. **Stubs are matched in order.** A stub is a list of [predicates](stubs/) (all must pass) and one or more [responses](responses/). The first stub whose predicates all match the request answers it.
4. **No stub matched?** An imposter with an extension protocol, such as the [S3 emulator](s3/), answers the request itself. Otherwise, an imposter with a [proxy](proxy/) forwards it to the real service. Otherwise the answer is a `404`:

```json
{"error":"No matching stub found","method":"GET","path":"/refunds"}
```

Stubs are read on every request, so adding, changing or deleting one takes effect on the next request, without restarting the imposter.

## Where to go next

- [Getting started](getting-started/): install, start the server, create your first imposter.
- [Config file](config-file/): declare imposters and stubs in a JSON file.
- [Stubs and predicates](stubs/) and [Responses](responses/): the matching and templating rules.
- [TypeScript client and test helpers](client/): drive Imposters from your tests with `withImposter`.
