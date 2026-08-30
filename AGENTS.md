# Engineering charter

> Charter for any coding agent in this repo (Claude Code, Cursor, Codex, …). Keep it short — architecture, config, and ops live in `docs/` (built by `mkdocs`). Generic engineering principles (think-first, simplicity, goal-driven): `.claude/rules/principles.md`.

## Project

`binance-trading-bot`: single-operator, multi-account, multi-profile, reliability-first, mobile-first trading platform on Binance. One operator owns N first-class Binance accounts (each = one API key pair + one environment + one user-data stream); each account runs N strategy **profiles** against its shared wallet. Strategy is a **plugin** — trailing-trade is the first; source of truth is `packages/strategy/trailing-trade/`, contract in `packages/strategy/core/` + `docs/architecture/extensibility.md`.

## Architecture principles

Correctness first. Before coding, confirm the design is sound: surface tradeoffs, pick the simplest option that holds the invariants below, cite authoritative sources for any version/API claim, and push back rather than guess. **Greenfield, not yet deployed** — no back-compat debt, so prefer the correct extensible design over the minimal diff and restructure freely; the invariants still bind, and you name a large refactor before starting it.

## Core invariants

1. **Extensibility.** Strategies are plugins behind `packages/strategy-core`; notifier providers behind `@app/notify`'s `./providers/*` subpath exports. `apps/api`/`apps/worker` MUST NOT import a specific `strategy-*` package or an `@app/notify/providers/*` provider outside their registry bootstrap; `apps/web` MAY import strategy packages for typed event payloads. Adding a strategy = new package + registry entry; adding a notifier = new provider module + `buildNotifyRegistry` entry — never an edit to `apps/api`/`apps/worker`.
2. **Reliability.** Crash-only. Idempotent jobs. Per-account Binance-rate isolation. No silent failures.
3. **Approachable & responsive.** Solo operator, not a finance pro: plain language, gloss a trading term the first time it appears, never assume off-screen knowledge. Mobile-first — every view usable at 375×667 — then scale up.
4. **Account-scoped by row, not convention.**
   - **Model:** one operator (`users`) → many `accounts` → many `profiles`. `accounts.owner_id → users.id`; each account holds one Binance key pair, one `binance_mode`, one user-data stream. `profiles.account_id` binds each profile to its account, sharing that account's key/wallet/stream.
   - **Branded two-tier scope:** `AccountScope{db,operatorId,accountId}` from `scopeAccount`, `ProfileScope{db,operatorId,accountId,profileId}` from `scopeProfile` — proves the ownership chain in one query. `UserId` and `AccountId` are distinct branded types (misplacing one won't compile).
   - **Access rule:** app code reaches account-scoped data ONLY through `profileRepo(...)` / `profileRepoFromScope(scope)` — or `accountRepo(...)` / `accountRepoFromScope` for account-level surfaces like api-keys — from `@app/db`. No manual `(db, operatorId, …)` threading; every account-scoped repo fn takes an `AccountScope`/`ProfileScope` first, minted only by `scopeAccount`/`scopeProfile` — ownership proven exactly once at compile time. Flat `repo.<x>` stays only for operator/global fns (`repo.users.*`, `repo.accounts.create`/`listForOwner`, retention sweeps).
   - **Routes:** API under `/api/accounts/:accountId/...`, web under `/accounts/$accountId/...`.
   - **Enforcement:** `packages/db/__tests__/repo/ast-check.test.ts` + cross-account integration tests. No DB-side RLS. See `docs/architecture/{account-isolation,database}.md`.
   - **Strategy state** is per-(profile, symbol) in storage and in `tick()` — one slice per symbol per call. Cross-symbol state goes through the per-profile KV store: emit `set-kv`/`delete-kv` under a strategy-owned namespaced key and read the merged snapshot back via `TickInput.profileKv` (opt in with `capabilities.needsProfileKv`). A KV write lands for sibling symbols on later ticks, never the same tick.

## Stack

Versions are pinned in `package.json`/lockfiles (the source of truth); names only here.

- Runtime **Bun** · monorepo **Turborepo** · CI: GitHub Actions + GitLab both call `scripts/ci/*.sh`
- Backend **Hono** · Frontend **Vite + React + TanStack Router/Query + Tailwind + shadcn/ui** (PWA)
- Charts **lightweight-charts** (financial), **Recharts** (non-financial)
- DB **Postgres + TimescaleDB** · ORM **Drizzle** · migrations = hand-authored SQL via a checksum-tracked runner
- Cache/queue **Redis + BullMQ** (`ioredis`, `maxRetriesPerRequest: null`)
- Auth **Better Auth** — no email/SMTP, no 2FA (single master account). See `docs/architecture/auth.md`.
- **Encryption-at-rest: none.** Binance keys + notifier secrets stored plaintext; operator IP-allowlists Binance keys. See `docs/architecture/auth.md` "Threat model".
- **Money = decimal.js.** Every price/quantity/amount/balance/pnl is `Decimal` end-to-end; `number` only for counters/indices/ms-timestamps. Snapshots serialise `Decimal` as strings; strategies revive at the boundary.
- Notifications: pluggable `@app/notify` providers (Slack first).
- Technicals: in-process `packages/indicators/rating` (vendored MIT); worker `technicals-compute` cron computes ratings locally, no external scanner. See `docs/architecture/technicals.md`.
- Containers: one multi-stage image (`apps/server/Dockerfile`); `ROLE=all|api|worker|study` selects behaviour. `apps/web` is build-only (api serves the SPA same-origin). Scale split via `docker-compose.scale.yml`.
- Worker: **single replica today** (`WORKER_REPLICAS=1`), no distributed locks; single-execution = BullMQ `jobId` coalescing + in-process `chainByKey` + idempotent `clientOrderId` + version-aware `symbol_states` CAS. Elastic-pool scale-out plumbing is merged but **dormant**. See `docs/architecture/worker-pipeline.md`.

## Repo layout

```text
apps/         api/ web/ worker/ server/       # server = ROLE-selectable entrypoint (api + worker)
packages/
  strategy/    core/ trailing-trade/          # core = contract + Executor; TT = first plugin
  indicators/                                 # pure, Decimal-typed candle/window math
  notify/                                     # @app/notify: contract + registry + providers/{slack,telegram,webhook}
  binance/ db/ contracts/ config/
  core/                                       # shared runtime utils; subpath exports (./env, …)
deploy/compose/  scripts/ci/
```

Directory grouping (`packages/strategy/*`) is filesystem-only; **npm names stay flat** (`@app/strategy-trailing-trade`). `@app/notify` is one package; providers are subpath exports.

## Required commands

| Command | Purpose |
| --- | --- |
| `bun install` | Install workspace deps. |
| `bun run dev` | Boot api+web+worker via turbo. |
| `bun run lint` | oxlint + invariant gates + prettier. Must be clean. |
| `bun run typecheck` | `tsc --noEmit -b` across all packages. Must be clean. |
| `bun run test` | Vitest. Per-workspace thresholds are enforced in the complete-suite coverage lane assigned by `COVERAGE_POLICY`. |
| `bun run test:e2e` | Playwright e2e. |
| `bun run test:worker-integration` | `apps/worker` integration lane on a laptop. Provisions throwaway Postgres + Redis under `TESTCONTAINERS=1`, so it needs a reachable Docker daemon and prints a notice instead of running when there is none. |
| `bun run db:migrate` | Apply hand-authored SQL migrations (checksum-tracked runner). |
| `bun run db:generate` | Not used — repo hand-authors `NNNN_*.sql`. |
| `bun run setup` | First-time bootstrap: `.env` from `.env.example` + migrate. |
| `bun run docs:install` | `uv sync --group docs`. Once, before any other `docs:*` command. |
| `bun run docs:build` | `docs:gen --check` + `uv run mkdocs build --strict`. The docs gate. |
| `docker compose up` | Local stack: postgres, redis, one `ROLE=all` app. |

Docs build in a **uv-managed Python env** (`pyproject.toml`, `[dependency-groups] docs`), never against whatever `mkdocs` happens to be on `PATH`. Run a bare `mkdocs build --strict` and it picks up an unrelated interpreter and dies on `The "<plugin>" plugin is not installed` — that message means the wrong environment, not a broken config, so installing the named plugin by hand is the wrong repair. Go through `bun run docs:build` / `docs:serve`, which invoke mkdocs under `uv run`; `bun run docs:install` (`uv sync --group docs`) creates that env first.

## Linting

**oxlint** is the single lint path (`.oxlintrc.json`, one whole-repo pass so `import/no-cycle` sees the full graph): `correctness` + `typescript`/`import`/`oxc`/`react` plugins, plus repo invariants via `overrides` — strategy/indicator **purity** (`no-restricted-globals`/`-imports`) and the **decimal.js boundary**. `react` is on for `react/no-unstable-nested-components` (a component declared inside another's render body remounts its subtree every render, which clamps `scrollTop` on WebKit); enabling the plugin also arms every `react` **correctness** rule, so `react/exhaustive-deps` is explicitly `off` pending triage of its pre-existing violations. Invariants oxlint can't express are `scripts/ci/*.sh` gates run from `lint.sh`: `no-plugin-leak` (invariant 1), `no-arbitrary-color-token`, `no-phantom-env-var`, `no-invalid-mermaid`, `no-undeclared-workspace-import`, `no-wider-metrics-sink` (only `apps/worker/src/metrics/catalog.ts` may declare the metrics sink; a second one typed `name: string` type-checks and escapes the catalogue), `no-unreviewed-tofixed` (every direct `.toFixed(` and fixed-two `maximumFractionDigits` site under `apps/web/src/**` is registered in `scripts/ci/tofixed-inventory.json` with its pattern identity and a factual value-kind reason; a hard round is how a sub-cent quote balance renders as `0.00`), `no-dropped-lint-rule` (asserts the resolved oxlint config still arms the rules carrying an invariant), `no-backfilled-migration` (a new `NNNN_*.sql` takes the next unused number: the runner applies files in name order, so one inserted below the high-water mark runs LAST on every already-migrated database), `no-mutated-applied-migration` (a shipped `NNNN_*.sql` is immutable; every suite migrates a fresh DB, so only a pinned-digest manifest can see the drift that wedges a deployed one), `no-bun-version-skew` (nine Bun pin sites must agree; Renovate does not reliably cover them, and the gate's reading counts are exact, so a site that stops matching fails loudly instead of silently narrowing the check), `no-blind-walk` (every gate that reads its verdict off a tree walk takes that walk from `scripts/ci/lib/walk.mjs`, whose `collectOrExit` refuses a root declaring no anchor, and carries the `GUARD_ROOT` override seam its self-test needs: a walk that merely narrowed still returns hundreds of files, so the count a gate prints is evidence only once it is proven to still reach the module the rule protects and its stops have been watched fire). See `docs/contributing/coding-rules.md`.

## Quality gates (CI must enforce)

1. Lint clean.
2. Typecheck clean.
3. Docs updated when behaviour changes — every claim traces to a source, not memory. Machine-enforced: `bun run docs:build` (`docs:gen --check` for config tables + env-var reference, then `uv run mkdocs build --strict`), `no-invalid-mermaid.sh`, `no-stale-migration-doc.sh`; narrative accuracy stays a review gate. See `docs/contributing/coding-rules.md#documentation-accuracy`.
4. Per-workspace complete-suite coverage thresholds met (`packages/config/vitest/coverage-policy.js`).
5. Strategy golden-fixture replay diff = 0.
6. Playwright lanes green. `browser-bootstrap` proves the four configured browser projects start and reports every skipped app execution with its reason; it does not claim critical-path app coverage. `app-e2e` boots a hermetic ROLE=all stack against a loopback Binance fixture and runs the P0 journey in all four projects; it fails on any skip and on any Binance traffic the fixture does not answer.
7. `bun run compose:build` succeeds for every app.
8. Migrations: hand-authored `NNNN_*.sql` applied in order by the checksum-tracked runner (`packages/db/src/migrate.ts`, tracked in `_app_migrations`); the `packages/db` suite runs `migrate()` against real Postgres. A shipped migration is **immutable**, and the two ways to break that fail differently. **Editing** one (a comment counts) moves its digest and wedges every already-migrated database at that file, which no later migration can repair. **Renaming or deleting** one is invisible to the runner, which keys on name: the file re-applies as new and orphans its old ledger row, silently. Change a shipped migration with a new migration; `no-mutated-applied-migration` enforces this because a fresh-DB suite cannot see either case, and `migrate-immutability.test.ts` pins both behaviours. Numbering is the other half of the same contract: a new migration takes the next unused number, never a hole, a letter suffix, or anything below `0001`, because name order is apply order — `no-backfilled-migration` enforces it from the directory listing, the only oracle that can tell a backfill from a fresh tree. See `docs/contributing/coding-rules.md` "A migration number is never reused and never backfilled".
9. JSDoc quality is a review gate, not a lint gate. Every exported or non-trivial function carries a block with one `@param` line per parameter and a `@returns` line when it returns a value. The prose above the tags carries the WHY; each tag glosses what that value _means_ — no name-restatements (`@param symbol - The symbol`), no blank blocks. A name that is a misnomer or an easy misread makes its `@param` line the only place a reader is told, so it is required there even when the type looks self-evident.

   **Do not hard-wrap comments.** One paragraph is one line, and one `@param` / `@returns` tag is one line, however long it runs — in JSDoc blocks and in `//` comments alike. This is the `proseWrap: 'never'` rule `prettier.config.mjs` already applies to Markdown, for the same reason: hard-wrapped prose turns every later edit into a multi-line reflow, so the diff hides the sentence that actually changed. Editors soft-wrap; diffs do not. Nothing enforces this — `printWidth` governs code only, and prettier never reflows a comment body — so it is a review gate, and existing wrapped comments are left alone until the code around them is touched. Line breaks are for meaning, not width: a bulleted list, a `- x:` table, or an ASCII diagram keeps its breaks.

## Anti-patterns to refuse

- **NotifyProvider single source of truth.** The shape lives in `@app/notify`; `apps/api` consumes `notifyProviders.describeAll()`, never its own provider interface.
- **No distributed locks.** No `redlock`, `intents:` Redis sets, soft balance reservation, or equivalents (`scripts/ci/no-locks.sh` fails, also scanning `packages/binance`). Permitted shared-Redis primitives are rate-limit / visibility, not locks (no owner, no release/refund): the consume-and-decay request-weight bucket and the self-expiring `SET NX PX` notifier-gap throttle.
- **No plaintext API keys on disk** outside the Postgres exception, and only under the `docs/architecture/auth.md` mitigations (single-tenant, operator-side Binance IP-allowlist). Any new storage surface (backups, replicas, exports, multi-tenant) requires encryption-at-rest first.
- **No secret in a `LIVE_DEMO` response.** The public demo injects the sole operator id, so every route not behind `requireNotDemo` is reachable anonymously. A credential-equivalent value — Binance API key, notifier **webhook URL**, bot token, auth header, AI-provider key — MUST NOT serialise into any response body. Strip it at the projection boundary (api-key → `last4`, ai-provider → `has*` booleans, notifiers declare secrets in `secretFields`) so a leak is impossible by construction. `requireNotDemo` is a blocklist / defence-in-depth: a new secret-reading or credential-writing route is exposed by default — add it to the deny-list AND to the completeness assertion in `apps/api/__tests__/routes/live-demo-guard.test.ts`.
- **No speculative abstraction.** Feature flags, configurability, or "for the future" indirection require a tracked issue with a concrete consumer.
- **Money math = `Decimal`.** `number` (IEEE-754) is banned downstream of `packages/{strategy-*,indicators,contracts}`; the decimal.js import boundary is lint-enforced (oxlint `no-restricted-imports`).
- **`Decision` union stays generic.** `noop` / `place-order` / `cancel-order` / `emit-event` / `set-kv` / `delete-kv` (`packages/strategy/core/src/decision.ts`). Strategy-specific side effects ride `emit-event` with namespaced keys, not new union variants; cross-symbol coupling rides `set-kv` / `delete-kv`. A removed variant takes its worker-side port with it — no idle seams.
- **Strategy & indicators are pure.** No `ioredis` / `pg` / `drizzle-orm` / `fs` / `net` / `http` / `crypto` / `Date` / `Math.random` inside `packages/strategy-*/src/**` or `packages/indicators/src/**`; no I/O inside `tick()` (the worker injects `Clock` and `RNG`). `decimal.js` is allowed.
- **Comments say why, not what.** No Spec / Issue / Phase / `@see` refs in code; commits and PRs own that. CI rejects.
- **Tests live in `<pkg>/__tests__/`,** never beside `src/`. CI rejects.
- **New shared runtime utilities go into `@app/core` via a new subpath, not a new package** — unless the utility has a clear domain boundary (strategy, notifier, binance, db, contracts).
