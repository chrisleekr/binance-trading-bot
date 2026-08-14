import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or, type SQL } from 'drizzle-orm';
import { asProfileId, type OverrideOutcomeInput, type ProfileId } from '@app/contracts';
import {
  overrideActions,
  type OverrideActionInsert,
  type OverrideActionRow,
} from '../schema/override-actions.js';
import { profiles } from '../schema/profiles.js';
import { withTx, type AccountScope, type ProfileScope } from './_scoped.js';

export async function listPending(scope: ProfileScope): Promise<OverrideActionRow[]> {
  return scope.db
    .select()
    .from(overrideActions)
    .where(and(eq(overrideActions.profileId, scope.profileId), isNull(overrideActions.consumedAt)));
}

/**
 * Most-recent-first dust-transfer actions for the profile — the operator's
 * conversion history. Bounded by `limit`; each row carries its durable `result`
 * payload (Binance's convertDust response) once finalised.
 */
export async function listDustTransferHistory(
  scope: ProfileScope,
  limit: number,
): Promise<OverrideActionRow[]> {
  return scope.db
    .select()
    .from(overrideActions)
    .where(
      and(
        eq(overrideActions.profileId, scope.profileId),
        eq(overrideActions.action, 'dust-transfer'),
      ),
    )
    .orderBy(desc(overrideActions.createdAt))
    .limit(limit);
}

/**
 * Arms an override, settling the one it replaces.
 *
 * Only the NEWEST override for a symbol can ever run: the caller's Redis key is
 * one key per (profile, symbol) and the arming `SET` overwrites it blindly, so a
 * predecessor left unconsumed is unreachable work. It stays hidden while the newer
 * row exists, since the symbol page is served the newest row in the window and
 * nothing else — but it outlives it. Cancel the replacement and the ghost becomes
 * the newest row, reading as an override still pending though its key is gone and
 * no tick can run it. `superseded` is what makes that row explain itself, and
 * stamping it here — rather than in every caller that arms — is what makes it
 * impossible to arm without it.
 *
 * ONE transaction with the insert, because the two halves are only true together:
 * settled alone loses the operator's override entirely, and inserted alone is the
 * ghost row. Settling FIRST is required — after the insert the new row matches the
 * predicate and supersedes itself.
 *
 * Best-effort against a concurrent arm, not an enforced invariant: at READ
 * COMMITTED a sibling's uncommitted insert is invisible, so neither arm settles the
 * other's row and both new rows survive. That degrades to the ghost above rather
 * than losing an override, and one operator double-tapping is the only way to
 * reach it.
 *
 * Bounded to rows that are pending AND on a non-null symbol:
 * - `processing_at` — a claimed row is mid-side-effect. Settling it hides it from
 *   `findActiveForSymbol`, and the cancel route reads that to decide between 204
 *   and 409; it would answer "cancelled" while an order is on the wire.
 * - `picked_up_at` — a tick took this override and may have dispatched from it.
 *   Its correct end state is the sweep's `unknown`, the only outcome that sends a
 *   human to the exchange, and a settled row is immutable, so an early
 *   `superseded` would suppress that permanently.
 * - `symbol` — a null symbol is an account-wide dust conversion with its own
 *   claim/finalize lifecycle and no Redis key to overwrite; two queued
 *   conversions are two real pieces of work.
 */
export async function record(
  scope: ProfileScope,
  input: Omit<OverrideActionInsert, 'profileId'>,
): Promise<OverrideActionRow> {
  const { symbol } = input;
  return scope.db.transaction(async (tx) => {
    if (symbol != null) {
      await consume(withTx(scope, tx), {
        narrow: and(
          eq(overrideActions.symbol, symbol),
          isNull(overrideActions.processingAt),
          isNull(overrideActions.pickedUpAt),
        ) as SQL,
        outcome: {
          status: 'superseded',
          reason: 'a newer override for this symbol replaced it before it ran',
        },
      });
    }
    const [row] = await tx
      .insert(overrideActions)
      .values({ ...input, profileId: scope.profileId })
      .returning();
    if (!row) throw new Error('override-actions.record: insert returned no rows');
    return row;
  });
}

/**
 * The rows a scope is allowed to touch, derived from the scope ITSELF.
 *
 * A `ProfileScope` proves ownership of exactly one profile. An `AccountScope`
 * proves only the account, so its rows are bounded by a subquery over that
 * account's profiles — never by profile ids the caller hands in, which prove
 * nothing.
 */
const ownedBy = (scope: ProfileScope | AccountScope): SQL =>
  'profileId' in scope
    ? (eq(overrideActions.profileId, scope.profileId) as SQL)
    : (inArray(
        overrideActions.profileId,
        scope.db
          .select({ id: profiles.id })
          .from(profiles)
          .where(eq(profiles.accountId, scope.accountId)),
      ) as SQL);

/** Identity of a row a terminal write closed out. */
interface ConsumedRow {
  readonly id: string;
  readonly profileId: string;
  readonly symbol: string | null;
}

/**
 * A stranded override the sweep could prove a tick had taken before dying. The
 * operator has to be told about each one by symbol, so the sweep returns them
 * rather than a count.
 */
export interface UnresolvedOverride {
  readonly id: string;
  readonly profileId: ProfileId;
  readonly symbol: string;
}

/** What one account-tier expiry sweep settled, split by which branch claimed it. */
export interface ReapExpiredResult {
  /** Rows no tick ever picked up: the window simply drained. */
  readonly expired: number;
  /** Rows a tick took and never came back from — a human must check the exchange. */
  readonly unresolved: readonly UnresolvedOverride[];
}

/**
 * The ONE terminal writer. Every path that closes a row out goes through here,
 * so "terminal" and "carries an outcome" are the same fact — `outcome` is a
 * required argument, not an option, which is what makes it impossible to
 * reintroduce the outcome-less "consumed = done" row that cannot tell a filled
 * force-sell apart from one the exchange refused.
 *
 * Takes the SCOPE, not a raw db handle, and builds the ownership predicate from
 * it. Callers supply only `narrow` — the extra conditions that pick rows WITHIN
 * what the scope already proves — so it is not possible to reach this writer with
 * no ownership bound at all. The scope-first gate only inspects EXPORTED repo
 * functions, and this one is private; deriving ownership here instead of trusting
 * a caller-built predicate is what keeps that hole from existing.
 *
 * The predicate is ANDed with `consumed_at is null`, so a settled row's outcome
 * is immutable: a replayed tick, or a reaper racing a settle, cannot overwrite
 * the truth. `at` is stamped here because the callers (a tick, a cron) have no
 * wall clock of their own. `result` is the SIDE-EFFECT payload and a separate
 * column; left untouched when omitted.
 *
 * Returns the rows actually closed out, so a caller can tell "I won it" from
 * "someone else already had". Identity, not just the id: an account-tier sweep
 * settles rows across profiles and has to be able to NAME what it settled, and a
 * count cannot name a symbol.
 */
async function consume(
  scope: ProfileScope | AccountScope,
  spec: {
    readonly narrow: SQL;
    readonly outcome: OverrideOutcomeInput;
    readonly result?: unknown;
  },
): Promise<ConsumedRow[]> {
  const now = new Date();
  return scope.db
    .update(overrideActions)
    .set({
      consumedAt: now,
      outcome: { ...spec.outcome, at: now.toISOString() },
      ...(spec.result !== undefined ? { result: spec.result } : {}),
    })
    .where(and(isNull(overrideActions.consumedAt), ownedBy(scope), spec.narrow))
    .returning({
      id: overrideActions.id,
      profileId: overrideActions.profileId,
      symbol: overrideActions.symbol,
    });
}

/**
 * CAS claim: flips one pending row to `processing` and returns whether this
 * call won it. The single `update ... where consumed_at is null and
 * processing_at is null` is atomic, so a replayed tick (or, in v1.x, a second
 * worker) that races on the same id sees zero rows updated and gets `false`.
 * A consumer with a non-idempotent side-effect MUST claim before the call and
 * run it only when this returns `true`.
 *
 * `at` is supplied by the caller rather than generated here, and that is what
 * makes {@link releaseClaim} fenceable: the caller knows the value it sent even
 * when the reply is lost, so it can later release exactly its own claim and
 * nobody else's.
 */
export async function claimAction(scope: ProfileScope, id: string, at: Date): Promise<boolean> {
  const rows = await scope.db
    .update(overrideActions)
    .set({ processingAt: at })
    .where(
      and(
        eq(overrideActions.profileId, scope.profileId),
        eq(overrideActions.id, id),
        isNull(overrideActions.consumedAt),
        isNull(overrideActions.processingAt),
      ),
    )
    .returning({ id: overrideActions.id });
  return rows.length === 1;
}

/**
 * Finalises a claimed action: `processing -> consumed`, outcome `applied` —
 * reaching here means the side-effect succeeded. Guarded on `processing_at is
 * not null` so it only ever advances a row this consumer claimed; a row already
 * consumed, or never claimed, is left untouched. Returns whether a row was
 * finalised — `false` means the row was no longer `processing` (concurrently
 * reaped or deleted), which the caller logs since the side-effect already ran
 * and the action will be reclaimed.
 *
 * `result` is the side-effect's own payload (Binance's convertDust response),
 * stored for the operator's history. Omitted for actions with no such payload.
 */
export async function finalize(
  scope: ProfileScope,
  id: string,
  result?: unknown,
): Promise<boolean> {
  const consumed = await consume(scope, {
    narrow: and(eq(overrideActions.id, id), isNotNull(overrideActions.processingAt)) as SQL,
    outcome: { status: 'applied' },
    ...(result !== undefined ? { result } : {}),
  });
  return consumed.length === 1;
}

/**
 * Closes out an override with the outcome the operator actually got. The
 * worker's tick path settles the override it just ran; the api settles one it
 * recorded but could not hand to the bot.
 */
export async function settle(
  scope: ProfileScope,
  id: string,
  outcome: OverrideOutcomeInput,
): Promise<void> {
  await consume(scope, { narrow: eq(overrideActions.id, id), outcome });
}

/**
 * Releases a claim: `processing -> pending`. Called when the side-effect
 * failed, so the next consumer retries the action immediately rather than
 * waiting for the stale-processing reaper.
 *
 * FENCED on `at`: it reverts the row only while `processing_at` still equals the
 * stamp the caller claimed with. Every caller bounds its writes by a deadline and
 * `raceDeadline` ABANDONS rather than cancels, so a release issued under one
 * attempt can still land minutes later, by which time a different consumer may
 * hold the row. Unfenced (`processing_at is not null`) that late write clears the
 * live claim, and the guard protecting an in-flight side-effect from an operator
 * cancel silently comes off. Fenced, a stale release is a genuine no-op.
 */
export async function releaseClaim(scope: ProfileScope, id: string, at: Date): Promise<void> {
  await scope.db
    .update(overrideActions)
    .set({ processingAt: null })
    .where(
      and(
        eq(overrideActions.profileId, scope.profileId),
        eq(overrideActions.id, id),
        isNull(overrideActions.consumedAt),
        eq(overrideActions.processingAt, at),
      ),
    );
}

/**
 * Resets `processing` rows whose claim is older than `staleBefore` back to
 * pending, and returns the count reset. Recovers an action a worker claimed
 * then died before finalising. Profile-scoped: the dust cron sweeps each
 * active profile on its own tick rather than running a global reaper.
 */
export async function reapStaleProcessing(scope: ProfileScope, staleBefore: Date): Promise<number> {
  const rows = await scope.db
    .update(overrideActions)
    .set({ processingAt: null })
    .where(
      and(
        eq(overrideActions.profileId, scope.profileId),
        isNull(overrideActions.consumedAt),
        isNotNull(overrideActions.processingAt),
        lt(overrideActions.processingAt, staleBefore),
      ),
    )
    .returning({ id: overrideActions.id });
  return rows.length;
}

/**
 * The newest override row for a symbol under `extra`, or null. Shared by both
 * symbol reads so the deterministic ordering — newest `created_at`, ties broken
 * by `id` — is written exactly once. Without the `id` tiebreak two rows recorded
 * in the same millisecond resolve arbitrarily, and the caller would show a
 * different override on each request.
 */
async function findForSymbol(
  scope: ProfileScope,
  symbol: string,
  extra: SQL,
): Promise<OverrideActionRow | null> {
  const rows = await scope.db
    .select()
    .from(overrideActions)
    .where(
      and(
        eq(overrideActions.profileId, scope.profileId),
        eq(overrideActions.symbol, symbol),
        extra,
      ),
    )
    .orderBy(desc(overrideActions.createdAt), desc(overrideActions.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The latest unconsumed override for a symbol, or null. "Active" spans both
 * lifecycle states a caller still cares about: `pending` and `processing`.
 * Callers inspect `processingAt` on the row to tell them apart, e.g. the
 * override-cancel route leaving a worker-claimed row alone.
 */
export async function findActiveForSymbol(
  scope: ProfileScope,
  symbol: string,
): Promise<OverrideActionRow | null> {
  return findForSymbol(scope, symbol, isNull(overrideActions.consumedAt));
}

/**
 * The newest unconsumed dust-transfer for the profile, or null. Dust rows are
 * account-wide, so they carry no symbol: `symbol is null` is what separates them
 * from the per-symbol overrides, and the action name is what separates them from
 * any future account-wide action. Ordered like the symbol reads so the row a
 * cancel decides on is the row the history page shows.
 *
 * A dust row is never `markPickedUp`-stamped — it has no Redis key and no tick
 * hand-off — so `processingAt` on the returned row is the only thing that says a
 * worker has started converting.
 */
export async function findActiveDustTransfer(
  scope: ProfileScope,
): Promise<OverrideActionRow | null> {
  const rows = await scope.db
    .select()
    .from(overrideActions)
    .where(
      and(
        eq(overrideActions.profileId, scope.profileId),
        eq(overrideActions.action, 'dust-transfer'),
        isNull(overrideActions.symbol),
        isNull(overrideActions.consumedAt),
      ),
    )
    .orderBy(desc(overrideActions.createdAt), desc(overrideActions.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Deletes every dust-transfer for the profile that no live worker holds, and
 * returns the ids removed. Ids rather than a count because the delete is hard: the
 * rows are gone from the history the operator reads, so the caller's audit entry is
 * the last place the detail can survive. Plural by necessity: arming a dust-transfer
 * supersedes only
 * rows carrying a symbol, so a profile can hold several queued conversions at once
 * and cancelling one of them would leave the rest to run.
 *
 * A row claimed more recently than `staleBefore` is mid-conversion at Binance, and
 * deleting it would erase the only record of a transfer that still completes. Past
 * that horizon the claim belongs to a worker that died holding it, and
 * `reapStaleProcessing` — which the caller must drive off the SAME horizon — resets
 * it to pending so the cron converts it on its next pass. Leaving such a row behind
 * would answer a cancel with success and then convert the coins anyway, so it is
 * deleted here for exactly the reason the unclaimed rows are.
 */
export async function deletePendingDustTransfer(
  scope: ProfileScope,
  staleBefore: Date,
): Promise<readonly string[]> {
  const rows = await scope.db
    .delete(overrideActions)
    .where(
      and(
        eq(overrideActions.profileId, scope.profileId),
        eq(overrideActions.action, 'dust-transfer'),
        isNull(overrideActions.symbol),
        isNull(overrideActions.consumedAt),
        or(isNull(overrideActions.processingAt), lt(overrideActions.processingAt, staleBefore)),
      ),
    )
    .returning({ id: overrideActions.id });
  return rows.map((r) => r.id);
}

/**
 * The newest override for a symbol recorded since `notOlderThan`, settled or
 * not. Deliberately NOT filtered on `consumed_at is null`: an operator who just
 * pushed an override needs to see how it ENDED, and the settled row is the only
 * one that knows. The time bound is what keeps yesterday's force-sell from
 * resurfacing as if it were the current one.
 */
export async function findLatestForSymbol(
  scope: ProfileScope,
  symbol: string,
  notOlderThan: Date,
): Promise<OverrideActionRow | null> {
  return findForSymbol(scope, symbol, gte(overrideActions.createdAt, notOlderThan));
}

/**
 * Marks that a tick has taken this override out of Redis, before the executor can
 * dispatch anything. The stamp is the only durable trace of that hand-off: from
 * the consuming `DEL` onward the operator's intent lives in one worker's memory,
 * so a row that outlives its worker is otherwise indistinguishable from one no
 * tick ever reached — and those two need opposite advice.
 *
 * Once-only (`picked_up_at is null`), returning whether THIS call stamped it. The
 * timestamp must stay the moment the FIRST tick took ownership, because that is
 * what dates the crash; a retry sliding it forward would erase that. Not a claim:
 * nothing is guarded on this column, deliberately — see the schema comment.
 */
export async function markPickedUp(scope: ProfileScope, id: string): Promise<boolean> {
  const rows = await scope.db
    .update(overrideActions)
    .set({ pickedUpAt: new Date() })
    .where(
      and(
        eq(overrideActions.profileId, scope.profileId),
        eq(overrideActions.id, id),
        isNull(overrideActions.consumedAt),
        isNull(overrideActions.pickedUpAt),
      ),
    )
    .returning({ id: overrideActions.id });
  return rows.length === 1;
}

/**
 * Settles symbol overrides still pending long after their Redis key can have
 * expired, across every named profile of the account. Without it a row whose
 * re-arm failed, or whose worker died between the Redis DEL and the settle, stays
 * "pending" on the symbol page forever — the operator is left watching an override
 * that can never run again.
 *
 * Two statements, one per way a row strands, because they need opposite outcomes:
 * a window that drained with no tick inside it placed nothing ("expired, try
 * again"), while a row carrying a pick-up breadcrumb belonged to a tick that may
 * have put an order on the wire before dying ("unknown, check the exchange").
 * Still account-tier rather than per-profile: run per profile this was a scope
 * SELECT plus an UPDATE for every active profile every five minutes, to settle
 * nothing almost every time.
 *
 * `symbol is not null` excludes the account-wide dust-transfer rows: those have
 * their own claim/finalize lifecycle and no Redis key to expire.
 */
export async function reapExpiredForAccount(
  scope: AccountScope,
  profileIds: readonly ProfileId[],
  staleBefore: Date,
): Promise<ReapExpiredResult> {
  if (profileIds.length === 0) return { expired: 0, unresolved: [] };
  // The caller's profile ids only NARROW the sweep; they never widen it.
  // `consume` intersects them with the account's own profiles (the `AccountScope`
  // proves the operator owns the ACCOUNT, and nothing about an id the caller
  // hands us), so a stray id cannot reach another account's rows.
  const stranded = and(
    inArray(overrideActions.profileId, [...profileIds]),
    isNotNull(overrideActions.symbol),
    lt(overrideActions.createdAt, staleBefore),
  ) as SQL;

  // Breadcrumbed rows FIRST, and the order is load-bearing. A stamp landing
  // between the two statements would, with the branches reversed, already have been
  // settled `expired` — recording "nothing ran" about an order that may be live,
  // and recording it terminally: `consume` refuses to rewrite a settled row, and it
  // is the audit trail plus the caller's escalation, not a screen, that this row
  // feeds. This way such a row simply misses the sweep and stays pending; the next
  // one, five minutes later, calls it `unknown`. Late and right beats early and
  // wrong on the only branch that costs money.
  const picked = await consume(scope, {
    narrow: and(stranded, isNotNull(overrideActions.pickedUpAt)) as SQL,
    outcome: {
      status: 'unknown',
      reason: 'a tick consumed this override and no outcome was recorded',
    },
  });
  const expired = await consume(scope, {
    narrow: and(stranded, isNull(overrideActions.pickedUpAt)) as SQL,
    outcome: { status: 'expired', reason: 'no tick ran inside the override window' },
  });

  return {
    expired: expired.length,
    // `symbol is not null` is part of `stranded`, so the empty arm is unreachable;
    // it exists only to narrow the column's nullable type without asserting.
    unresolved: picked.flatMap((r) =>
      r.symbol === null
        ? []
        : [{ id: r.id, profileId: asProfileId(r.profileId), symbol: r.symbol }],
    ),
  };
}

/**
 * Deletes the `pending` overrides for a symbol and returns the count deleted.
 * Guarded on `processing_at is null`: a row a worker has already claimed is
 * mid-side-effect, so an operator cancel (or symbol wipe) skips it rather than
 * deleting it out from under the worker. The reaper/finalize path resolves the
 * claimed row; this function only ever removes work that has not started.
 */
export async function deletePendingForSymbol(scope: ProfileScope, symbol: string): Promise<number> {
  const rows = await scope.db
    .delete(overrideActions)
    .where(
      and(
        eq(overrideActions.profileId, scope.profileId),
        eq(overrideActions.symbol, symbol),
        isNull(overrideActions.consumedAt),
        isNull(overrideActions.processingAt),
      ),
    )
    .returning({ id: overrideActions.id });
  return rows.length;
}
