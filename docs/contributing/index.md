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
- **Dependency updates** — automated by Renovate (`renovate.json`), which is the only dependency bot; there is no Dependabot config. Routine updates arrive weekly on `chore/renovate-*` branches as two grouped pull requests: one for every non-major bump, one for every major. Grouping spans managers on purpose, because the Bun and Playwright versions are each duplicated across `package.json`, both CI providers and the Dockerfile, and only move consistently when a single PR moves all managed copies together. The custom managers cover those Bun pins and the TimescaleDB runtime pin in `packages/testcontainers/src/index.ts`; the `legacy-postgres` fixture pin is held below 2.28.0 by an `allowedVersions` rule matched on its 2.27.x value, so Renovate keeps resolving it and the hold stays visible on the dashboard rather than disappearing behind `enabled: false`. It is matched on the value rather than on a file because each CI config now declares the deployed server and that fixture together, and only the fixture is held. Two update paths sit outside grouping: lock-file maintenance opens its own PR and competes for the same two-PR budget, while a security update [ignores concurrency limits and the schedule](https://docs.renovatebot.com/configuration-options/#vulnerabilityalerts) so a fix is never queued behind a routine bump. A dependency that must not advance is expressed as an `allowedVersions` rule in `renovate.json` with the reason in its `description`, never as `enabled: false` and never as a silent hand-pin: a resolved-but-capped dependency still appears on the dashboard, and for npm packages the nightly `bun audit` job reads the lockfile directly and ignores every Renovate rule. That backstop does not extend to Docker images, so a held image carries its own note about what is not being checked.

## Run the docs site locally

The documentation you're reading is built with MkDocs. Requires `uv` (Python 3.14.7 or newer):

```bash
uv sync --group docs
uv run mkdocs serve   # http://127.0.0.1:8000
```

The `bun run docs:*` scripts are thin wrappers around those commands.
