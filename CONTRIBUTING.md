# Contributing to Imposters

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Where to talk

- **Questions and ideas:** [GitHub Discussions](https://github.com/eliraz-refael/imposters/discussions).
- **Bugs and concrete feature requests:** [issues](https://github.com/eliraz-refael/imposters/issues/new/choose). Check the [roadmap](ROADMAP.md) first: planned work already has an issue, and a comment there helps more than a new one.
- **Larger changes:** open an issue or a discussion before you write the code, so we can agree on the shape first.

## Setup

The repo uses [Bun](https://bun.sh) (the version is pinned in `package.json`'s `packageManager`) and Node.js 22 or newer, since vitest needs Node `^22.12`.

```bash
bun install
bun tsx src/Program.ts start   # run the CLI from source
```

## The gates

A pull request needs all three to pass. CI runs the same ones.

```bash
bun check      # TypeScript
bun lint       # ESLint (bun lint-fix fixes formatting)
bun run test   # vitest, single run
```

`bun run test` is not `bun test`: the latter is Bun's own test runner, which this repo does not use.

## Writing tests

- **Each test file owns a block of ports.** Test files run in parallel and bind real ports, so a file picks its own range (for example 91xx) and notes it in a comment near the top. Grep `test/` before choosing one. Always start an imposter on an explicit port: automatically allocated ports collide between files.
- Don't sleep after starting or stopping a server. `start` resolves once the port is bound and `stop` once it is released. To check a listener, use the helpers in `test/helpers/net.ts` rather than `fetch`, whose keep-alive pool can reuse a socket.
- vitest workers run under Node.js even when started from Bun, so tests use the `node:http` server factory.

## Code standards

The full list is in [DEVELOPMENT.md](DEVELOPMENT.md), and [CLAUDE.md](CLAUDE.md) covers the Effect 4 gotchas. In short: no `any`, no type casts, validation goes through Effect Schema, and side effects stay inside `Effect`.

## Extensions

Non-HTTP protocols, such as the S3 emulator, are extensions in `src/extensions/<name>/`. The core must never know about a specific protocol:

- The core depends only on `src/extensions/Extension.ts`.
- An extension is registered in one place, the `extensions` list in `src/cli/Commands.ts`. Nothing else in `src/` may import it, and extensions don't import each other. ESLint enforces both rules.
- Deleting an extension's list entry and its folder must leave a core that compiles and passes its tests.

## Commits and releases

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`. Pull requests are usually squash-merged, so the PR title becomes the commit message on `master`: give it the same format.

Every merge to `master` publishes a release to npm, and the commit type sets the version bump:

| Commit | Release |
|---|---|
| `feat:` | minor |
| `feat!:` (any type with `!`), or `BREAKING CHANGE` in the body | major |
| anything else (`fix:`, `docs:`, ...) | patch |

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
