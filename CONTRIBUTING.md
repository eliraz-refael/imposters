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

## UI screenshots

For a change to the web UIs (`/_ui` and an imposter's `/_admin`), attach screenshots to the pull request. One command takes them:

```bash
bun run screenshots                    # writes screenshots/<screen>-<theme>.png
bun run screenshots --out /tmp/shots   # elsewhere
```

It needs **Google Chrome** installed: [`scripts/ui-screenshots.ts`](scripts/ui-screenshots.ts) drives it through `playwright-core`, which downloads no browser. The script starts the CLI with [`examples/ui-showcase.json`](examples/ui-showcase.json) on admin port 2599 (`--port` or `SCREENSHOTS_PORT` to change it; the imposters use 3201-3205), sends it about a minute of traffic (matched, unmatched, 5xx, slow and S3 requests), stops `payments-sandbox`, then captures every screen in its `SCREENS` list in the dark and light themes. Traffic runs until three 30-second buckets have closed, so the 15-minute sparklines have points; `--buckets 0` sends one burst and shoots at once, for quick iterations. The server is stopped when it finishes, fails or is interrupted. `screenshots/` is gitignored.

To add or change a screen, edit its one line in `SCREENS`.

## Code standards

The full list is in [DEVELOPMENT.md](DEVELOPMENT.md), and [CLAUDE.md](CLAUDE.md) covers the Effect 4 gotchas. In short: no `any`, no type casts, validation goes through Effect Schema, and side effects stay inside `Effect`.

## Extensions

Non-HTTP protocols, such as the S3 emulator, are extensions in `src/extensions/<name>/`. The core must never know about a specific protocol:

- The core depends only on `src/extensions/Extension.ts`.
- An extension is registered in one place, the `extensions` list in `src/cli/Commands.ts`. Nothing else in `src/` may import it, and extensions don't import each other. ESLint enforces both rules.
- Deleting an extension's list entry and its folder must leave a core that compiles and passes its tests.

## Commits and releases

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`. Pull requests are usually squash-merged, so the PR title becomes the commit message on `master`: give it the same format.

A merge to `master` publishes a release to npm when the commits since the last release include a code change. The commit types set whether it releases and the version bump:

| Commit | Release |
|---|---|
| `feat!:`, or any type with `!` before the colon | major |
| `feat:` | minor |
| `fix:`, `perf:`, `refactor:`, `revert:` | patch |
| `docs:`, `test:`, `chore:`, `ci:`, `style:`, `build:` | none |

Only the commit title counts: a `BREAKING CHANGE` footer in the body is not read, so mark a breaking change with `!` in the PR title. When several commits are waiting, the largest bump wins. A docs-only merge publishes nothing on its own, but it does release any code change still waiting from an earlier merge.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
