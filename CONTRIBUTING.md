# Contributing

Thanks for looking. Issues and pull requests go to [github.com/chrisleekr/binance-trading-bot](https://github.com/chrisleekr/binance-trading-bot).

This is a single-operator hobby project. Small, focused pull requests get merged; large speculative ones usually do not. If you are planning something substantial, open an issue first so we can agree on the shape before you spend the time.

**Security problems do not go here** — follow [`SECURITY.md`](SECURITY.md).

## Before you start

Read [`AGENTS.md`](AGENTS.md). It is the engineering charter: the invariants the codebase holds, the required commands, and the gates CI enforces. A pull request that violates an invariant will not merge no matter how good the code is. The most load-bearing ones:

- **Strategies are plugins.** Adding a strategy means a new package plus a registry entry — never an edit to `apps/api` or `apps/worker`.
- **Money is `Decimal`.** Every price, quantity, amount, balance, and P/L is `decimal.js` end to end. `number` is for counters, indices, and millisecond timestamps only. This is lint-enforced.
- **Strategies and indicators are pure.** No I/O, no `Date`, no `Math.random` inside `tick()`; the worker injects a `Clock` and an `RNG`.
- **Tests live in `<package>/__tests__/`**, never beside `src/`. CI rejects colocated tests.
- **Comments say why, not what**, and carry no issue or spec references. Commits and pull requests own that history.

## Setup

Prerequisites: [Bun](https://bun.sh) 1.3+ and Docker with the `compose` plugin.

```bash
bun install
bun run setup   # writes .env, starts Postgres + Redis, runs migrations
bun run dev     # api + web + worker
```

The SPA is at `http://localhost:5173`.

## Before you open a pull request

These must be clean. CI runs the same commands, so failing locally means failing there:

```bash
bun run lint        # oxlint + the repo invariant gates + prettier
bun run typecheck   # tsc --noEmit -b across every package
bun run test        # vitest
```

Two things that will waste your time if you do not know them:

- **Turbo caches test results, and the cache hides both coverage failures and prettier failures.** Use `bun run test --force` when you need to trust the result.
- After changing anything in `packages/contracts`, run `build --force` before `typecheck --force`, or you will typecheck against stale declarations.

If you changed behaviour, update the docs in the same pull request — that is a CI gate, not a nicety. See [`docs/contributing/coding-rules.md`](docs/contributing/coding-rules.md).

## Commits and pull requests

[Conventional Commits](https://www.conventionalcommits.org/). The pull request title is linted, because it becomes the squashed commit subject:

```
feat(worker): retry a partially filled order once before cancelling
fix(web): stop the symbol rail flickering on reconnect
docs: correct the backtest metric definitions
```

Keep the subject under 100 characters. Explain **why** in the body; the diff already shows what.

## Licence

By contributing you agree that your contributions are licensed under [Apache-2.0](LICENSE), the licence of this project.
