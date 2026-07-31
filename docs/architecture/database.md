# Database

Canonical references for the database surface — the in-repo files are the source of truth, this page summarises the constraints those files encode.

- `packages/db/migrations/` — hand-authored, numbered `NNNN_*.sql` files applied in order by `migrate({ connectionString })`. They are hand-written, not generated: the drizzle journal is empty so `db:generate` emits a full snapshot rather than incremental ALTERs and is therefore not used (drizzle-kit is kept for schema typing and `db:check`). Applied files are tracked by SHA-256 checksum in `_app_migrations`, so re-runs skip already-applied files. `migrate()` holds a session advisory lock while applying, so concurrent callers serialize and the loser skips the already-applied files instead of racing on non-transactional `create type` DDL. This is a migration-time DB lock, not a runtime coordination lock, so it does not breach the no-distributed-locks invariant. CI runs the `packages/db` isolation/projection suites against a real Postgres via `DATABASE_TEST_URL` in the integration job; without that variable they skip. **`DATABASE_TEST_URL` must name a database whose name ends with `_test`** (e.g. `binance_trading_bot_test`): the integration and isolation harnesses TRUNCATE / delete rows on it, and `assertTestDatabaseUrl` refuses to run against any non-`_test` target so a value pointed at the live `binance_trading_bot` cannot wipe real data.
- `packages/db/src/schema/` — drizzle schema definitions, one file per logical table group.
- `packages/db/src/repo/` — typed repository wrappers over a **two-tier scope**. Account-scoped functions take an `AccountScope` (produced only by `scopeAccount`); profile-scoped functions take a `ProfileScope` (produced only by `scopeProfile`). Each scope runs the single ownership check for its tier, so a scoped query cannot be reached without ownership having been proven.

## Account isolation policy

The data model is **one operator (`users`) → many `accounts` → many `profiles`**. An `account` is a first-class row (`accounts`, `owner_id → users.id`) holding one Binance API key pair, one `binance_mode`, and one user-data stream; `profiles.account_id → accounts.id`. Ownership is a two-hop chain — `accounts.owner_id = operatorId` and `profiles.account_id = accountId` — resolved in a single query by `scopeProfile(db, operatorId, accountId, profileId)` (and `scopeAccount(db, operatorId, accountId)` for account-level surfaces). `UserId` (the operator) and `AccountId` are distinct branded types, so misplacing one for the other is a compile error. The typed repository layer is the **single enforcement point**; app code resolves a scope via `profileRepo` / `accountRepo` (or the `*FromScope` variants) and ownership is checked exactly once per scope. There is no DB-side RLS — the cross-account integration tests in `apps/api/__tests__/cross-account.test.ts` and `packages/db/__tests__/isolation/*.test.ts` verify the policy in CI, and `packages/db/__tests__/repo/ast-check.test.ts` statically enforces the scope-first contract.

See also: [`account-isolation.md`](account-isolation.md).

## `override_actions`: `result` vs `outcome`

`override_actions` backs two unrelated operator flows, and each owns its own nullable jsonb column. They are **not** interchangeable:

| column | meaning | written by | read by |
| --- | --- | --- | --- |
| `result` | the action's SIDE-EFFECT payload — Binance's `convertDust` response | `finalize()`, on a dust transfer only | the dust-history route |
| `outcome` | what the operator actually GOT: `{ status, reason?, at }` | every terminal write (`settle` / `finalize` / the sweep) | `GET /override`, the SPA |

`outcome` is stamped by EVERY terminal transition, so "the row is closed out" and "the row carries an outcome" are one fact — a row marked done with no outcome cannot tell a filled force-sell apart from one the exchange refused, and reads on the symbol page exactly like a success. The two columns stay separate for the same reason: sharing one would make `null` mean both "still pending" and "settled, but the payload is not an outcome", which no reader can disambiguate without guessing at the shape.

Migration `0072` adds the `outcome` column plus the two indexes these reads need — a `(profile_id, symbol, created_at desc)` index for "the newest override for this symbol, settled or not", and a partial index on the pending symbol-scoped rows for the stranded-row sweep.

All four terminal paths funnel through one private `consume()` in `packages/db/src/repo/override-actions.ts`, whose `outcome` argument is required, so a new "mark it done" writer cannot reintroduce the outcome-less row. The stranded-row sweep is account-tier (`reapExpiredForAccount`, on `AccountRepo`): two statements per account per sweep — one per stranding branch, see below — rather than a scope-resolve plus an UPDATE for every active profile.

### `picked_up_at`: a write-once record, not a lease

Migration `0075` adds a third nullable column, and it is the odd one out: nothing is gated on it, and nothing ever clears it.

| written | read | cleared by | gates any behaviour |
| --- | --- | --- | --- |
| once per override, by the tick, when it marks itself about to dispatch and before `applyAll` runs (`markPickedUp`, guarded `picked_up_at is null` so a retry cannot slide the timestamp) | one consumer: `reapExpiredForAccount`, which only asks whether it is NULL | nothing | nothing |

(It is of course in the `WHERE` of both sweep statements — "gates" means no path _branches_ on it the way the cancel route branches on a claim, and the dispatch gate on the claim's own CAS reply.)

**The "cleared by" column is why this is a new column and not a reuse of `processing_at`.** A claim is a **lease**: it exists in order to be handed back. Two paths null it — `releaseClaim`, when a side-effect failed and the next tick should retry, and `reapStaleProcessing`, when a worker died holding a claim. A lease therefore cannot carry a fact that must OUTLIVE the crash: the crash is what summons the stale-claim reaper, and the reaper clears exactly the evidence the sweep would need to read. `picked_up_at` is written once and cleared by nothing, so it survives.

This is why the two columns stayed separate once the tick DID become a claiming consumer of overrides. The claim means "work is in flight now", which is inherently revocable; the breadcrumb means "work was once in flight", which must never be revoked. Merging them would put the durable fact back under a reaper's control.

The two also differ in span, which is what keeps a claim from swallowing cancellation. `processing_at` is read as a guard — `deletePendingForSymbol` skips a claimed row — so the tick holds it only across the window where a dispatch is genuinely in flight, and `settleOverride` releases it before re-arming the Redis key. An operator cancel arriving inside that window is answered `409`, never silently dropped; outside it the row is deletable again, and the compensating re-arm still infers "the operator revoked this" from that cancel having deleted the row. `consumed_at` is terminal and would settle the override the tick is still holding.

Both columns are also read at ARM time. `record` settles the row a new override replaces `superseded`, in one transaction with the insert, because the operator's Redis key is overwritten blindly and only the newest override can run — but it settles only rows where BOTH are null. A claimed row would disappear from `findActiveForSymbol` and take the cancel route's `409` with it; a breadcrumbed one is destined for the sweep's `unknown`, the only outcome that notifies, and terminal writes are immutable, so an early `superseded` would suppress it permanently. Same asymmetry as everywhere else here: the lease and the breadcrumb both mean "someone else owns this row's ending".

No index. The sweep's predicate is unchanged and its two branches are disjoint halves of the same pending set already covered by `override_actions_pending_symbol_idx`; a second index on a two-valued column would earn nothing and cost every override write. What the two branches mean for the operator is in [`worker-pipeline.md`](worker-pipeline.md#operator-overrides-settling-on-the-outcome).

## `orders`: account-owned, profile-referencing

An order is **ACCOUNT-domain**: its Binance id is unique per account, the user-data stream that reconciles it is per account, and it keeps resting on the exchange whether or not the strategy that placed it still exists. Migration `0073` moves the table onto that footing:

| column | before | after (0073) | why |
| --- | --- | --- | --- |
| `account_id` | — | NOT NULL, FK `→ accounts` ON DELETE CASCADE | The owner. CASCADE because deleting the account destroys the key pair: nothing can ever query, cancel or reconcile those orders again, so there is no one left to keep the row for. |
| `profile_id` | NOT NULL, FK (implicit CASCADE) | NULLABLE, FK `→ profiles` ON DELETE SET NULL | A reference, not ownership. Deleting a profile DETACHES its orders instead of destroying them: a resting order is real money, and its ledger row must outlive the strategy or the order is unreconcilable. |

The backfill is total (`profile_id` was NOT NULL with an FK before, so every row joins to a profile and every profile to an account), which is what lets `SET NOT NULL` on `account_id` be unconditional.

New index `orders_account_binance_order_id (account_id, binance_order_id)`: the seek every reconciliation path now makes (user-data stream, orphan sweep, adopt route, detached-orders-reconcile), and the only way a detached row is reachable at all.

The partial unique index `orders_one_live_per_intent (profile_id, symbol, intent) WHERE closed_at IS NULL` needs **no change**: Postgres treats NULLs as distinct in a unique index, so no two detached rows ever conflict and a detached row never blocks a new live slot for the (recreated) profile.

A **recovery row** — an order that IS live on Binance but whose normal bookkeeping did not land — is written by `orders.insertTracking` under a reserved intent, `` `${intent}:untracked:${binanceOrderId}` ``. `intent` is an open, strategy-owned string (no CHECK since 0026), and the reservation is what keeps the row out of the strategy's live slot: that slot is very often ALREADY HELD by the still-resting previous order — which is the single most likely reason the normal write failed in the first place — so an insert under the strategy's own intent would conflict on the partial unique index and be silently swallowed, leaving the live order with zero local trace. The row stays fully visible where it matters: the orphan sweep and the exposure guard read `account_id` / `closed_at` (intent-blind), and the fill adopter seeks by `(account_id, binance_order_id)`.

## Dashboard read-through caches

The two dashboard projections cache their composed payload in Redis to absorb the SPA's 5s poll without re-running the per-profile × per-symbol Postgres + Redis fan-in on every request:

- `getAggregateForAccount` — the per-account cross-profile home rollup. Key `dashboardAggregateCacheKey(accountId)` (`tenant:<accountId>:dashboard-aggregate:cache`), TTL `DASHBOARD_AGGREGATE_TTL_S = 5`.
- `getProfileDashboard` — the per-profile view. Key `profileKey(scope, 'dashboardCache')`, TTL `PROFILE_DASHBOARD_TTL_S = 5`.

Because reads are cached, a write must drop the affected keys or the UI replays a stale payload until the TTL expires (the "action is slow to refresh" lag). The `bustDashboardCache` middleware (`apps/api/src/middleware/`) is mounted app-wide and, after any successful (2xx) non-GET request by an authenticated user, reads the `{accountId}` from the account-scoped path and deletes that account's aggregate key plus the per-profile key when the path also carries a `{profileId}`. The SPA's on-success refetch then recomputes immediately. Invalidation is best-effort via `invalidateDashboardCaches` — a Redis failure is swallowed so it never turns a successful write into a 5xx; the read just waits out the TTL. The cache holds composed DTOs only; the source of truth stays in Postgres, and ownership is re-proven on the recompute path, so a stale or dropped cache is never an isolation concern.
