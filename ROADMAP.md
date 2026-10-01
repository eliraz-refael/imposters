# Roadmap

Where Imposters is heading. Each item links to an issue: comment there with your use case, or add a 👍 to the ones you need most. Priorities shift with that feedback.

What is already shipped is in the [README](README.md). Maintenance work and internal notes live in [DEVELOPMENT.md](DEVELOPMENT.md).

## Now

- **Website and docs**: a landing page with an in-browser playground, a getting-started guide, reference docs for every feature, and this roadmap ([#26](https://github.com/eliraz-refael/imposters/issues/26))
- **Monitoring UI**: a live dashboard across all imposters (which are up, traffic, errors and latency), and a live view inside each one (requests as they arrive, stub hit counts, requests no stub matched) ([#27](https://github.com/eliraz-refael/imposters/issues/27))
- **AI-friendly**: an `imposters mcp` server, so coding agents can create imposters, add stubs and read captured requests as tools, plus `llms.txt` and agent-oriented docs ([#28](https://github.com/eliraz-refael/imposters/issues/28))

## Next

- **OpenAPI import**: generate an imposter and its stubs from an OpenAPI 3.x spec ([#29](https://github.com/eliraz-refael/imposters/issues/29))
- **Mountebank adapter**: accept Mountebank imposter JSON, a direct migration path off a tool that is no longer maintained ([#30](https://github.com/eliraz-refael/imposters/issues/30))
- **Record and replay**: binary stub bodies, then export recorded proxy traffic as a config file and re-import it ([#31](https://github.com/eliraz-refael/imposters/issues/31))
- **S3 completeness**: list pagination and `delimiter`, bucket settings that read back, `aws-chunked` uploads, and keys with `.` or `..` segments ([#32](https://github.com/eliraz-refael/imposters/issues/32))

## Later

- **WebSocket mocking**: scripted message sequences, replies and dropped connections on cue ([#33](https://github.com/eliraz-refael/imposters/issues/33))
- **gRPC and raw TCP**: further protocols as imposter extensions ([#34](https://github.com/eliraz-refael/imposters/issues/34))
- **More cloud emulators**: in-memory services in the S3 extension's mould, starting with SQS ([#35](https://github.com/eliraz-refael/imposters/issues/35))
- **Hosted Imposters (exploring)**: shared mock environments for a team or CI, with nothing to run locally ([#36](https://github.com/eliraz-refael/imposters/issues/36))
