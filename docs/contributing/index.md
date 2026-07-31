# Contributing

This section is the **contributor reference**. It assumes you read code and want to understand the architecture, extend it, or send a pull request. If you only want to _run_ the bot, start at [Get started](../get-started/index.md) instead.

## Start here

`AGENTS.md` at the repo root (the `CLAUDE.md` symlink points at it) is the north-star design and invariant list — read it first. Then the deep-dives:

- **[Tech stack & components](../architecture/tech-stack.md)** — what the repo is built from and what actually runs on a server.
- **[Worker pipeline](../architecture/worker-pipeline.md)** — the tick lifecycle, from market event to committed order.
- **[Reliability](../architecture/reliability.md)** — crash-only guarantees and the self-healing mechanisms the worker upholds.
- **[Account isolation](../architecture/account-isolation.md)** — the typed, scope-first data model that prevents cross-account leaks.

## Extending it

The two extension points are strategies and notifiers, both plug-ins behind a contract. Adding either is a new package (or provider) plus a registry entry — never a change to `apps/api` or `apps/worker`.

- **[Strategy plugin contract](../architecture/extensibility.md)** — the `Strategy` interface every strategy implements.
- **[Notifiers](../concepts/notifiers.md)** — the provider contract for Slack, Telegram, and webhooks.

## Reference

- **[Environment variables](../operations/env-vars.md)** — process-level `.env` config.
- **[Notifiers](../concepts/notifiers.md)** — provider contract and config.
- **Strategy pages** — the canonical per-strategy references (behaviour, full config, scenarios, internals): [Trailing Trade](../concepts/strategies/trailing-trade.md) · [Momentum](../concepts/strategies/momentum.md) · [Rebalance](../concepts/strategies/rebalance.md).
- **API** — the running app serves interactive OpenAPI docs (Swagger UI) at `/docs`, with the spec at `/openapi.json`. Profile config is edited in the app; its schema lives in `packages/contracts` (Zod).

## Contributing

Read the engineering charter in `AGENTS.md` at the repo root before your first pull request — it lists the invariants, the required commands, and the quality gates CI enforces.

- **[Coding rules](coding-rules.md)** — narrower conventions, including the [documentation-accuracy rules](coding-rules.md#documentation-accuracy).
- **CI secrets** — the image-tag scheme and the secrets table live in `docs/ci-secrets.md` in the repository. It is deliberately not published to this site: it maps which secrets exist in which provider and which job reads them, which is an infrastructure map rather than contributor documentation.

## Run the docs site locally

The documentation you're reading is built with MkDocs. Requires `uv` (Python 3.13):

```bash
uv sync --group docs
uv run mkdocs serve   # http://127.0.0.1:8000
```

The `bun run docs:*` scripts are thin wrappers around those commands.
