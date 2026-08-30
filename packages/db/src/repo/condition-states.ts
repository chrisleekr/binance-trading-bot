import { and, eq } from 'drizzle-orm';
import { conditionStates, type ConditionStateRow } from '../schema/condition-states.js';
import * as actionLogs from './action-logs.js';
import type { ProfileScope } from './_scoped.js';

/**
 * Subject sentinel for a condition about the profile rather than one symbol.
 * Not NULL: the primary key spans `symbol`, and Postgres forbids nullable
 * primary-key columns.
 *
 * Exported because readers outside this module must tell a profile-level row
 * from a symbol row, and a second literal `''` elsewhere would be a fact stored
 * twice.
 */
export const PROFILE_SUBJECT = '';

/**
 * Condition name for "the operator recorded a cost basis and the worker refused to seed a position from it".
 *
 * Exported because its producer and its reader live in different packages — the worker's apply-avg-entry-price job opens and clears it, the symbol-state projection reads it — and a condition name is matched by equality with no schema to catch a typo, so two literals would be one silent skew away from a refusal that is recorded and never surfaced.
 */
export const POSITION_SEED_REFUSED = 'position-seed-refused';

/**
 * The only code {@link POSITION_SEED_REFUSED} takes today: nothing sellable backs the symbol, so there is no position to hand the strategy.
 */
export const NO_SELLABLE_POSITION = 'no-sellable-position';

export interface RecordConditionInput {
  readonly condition: string;
  /** Omit (or pass null) for a profile-level condition. */
  readonly symbol?: string | null;
  /**
   * The specific reason, or null to clear — "this condition no longer holds".
   * Clearing deletes the state row and records one resolution edge.
   */
  readonly code: string | null;
  /**
   * The caller's full identity for this state when the code alone is not it,
   * typically the code plus the threshold in `detail`. A change here with an
   * unchanged code is the same condition sitting on a moved level, and it must
   * still land, or `detail` freezes on the first threshold ever seen. Omit when
   * the code is the whole identity.
   */
  readonly changeKey?: string | null;
  readonly detail?: unknown;
  /** Injected so callers stay clock-free and tests stay deterministic. */
  readonly now: Date;
  /** Human sentence for the log edge. Falls back to a generic line. */
  readonly msg?: string;
}

/**
 * What a `recordCondition` call actually did, for callers that log or count.
 *
 * Both arms carry the span start, because "unchanged" is exactly when a caller
 * needs it: an alert gated on how long a condition has held asks on every tick
 * that changes nothing. The unchanged arm reads it off the row the dedup
 * already fetched, so answering costs no extra query. It is null only when
 * nothing is open, which is not the same claim as "open since now".
 */
export type RecordConditionResult =
  | { readonly changed: false; readonly sinceMs: number | null }
  | { readonly changed: true; readonly previousCode: string | null; readonly sinceMs: number };

/**
 * The single writer for every condition, replacing each subsystem's bespoke
 * "log why I did nothing" handling.
 *
 * Writes NOTHING when the identity is unchanged, identity being
 * `changeKey ?? code`. That is the entire reason this is safe on a per-tick
 * path: a symbol sitting on one reason for 4,000 consecutive ticks costs 4,000
 * comparisons and zero writes. On-change storage of a step function is lossless
 * — the reason is fully described by its transition in and its transition out —
 * so per-tick rows would be redundant by construction, and they are what
 * produced the ~86k rows/day this design deliberately avoids.
 *
 * A changed code opens a new span. A changed `changeKey` under an unchanged
 * code is the same span on a moved level, so it rewrites `detail` and logs an
 * edge but leaves `since` alone.
 *
 * On a change it does two writes with different jobs:
 *   - upserts `condition_states`, the retention-immune current state, carrying
 *     `since` so duration survives any log pruning;
 *   - appends one `action_logs` edge with a uniform `ctx.source = 'condition'`,
 *     so one filter yields every state change in the system in one shape.
 *
 * The two writes are not atomic and share one failure path. An append that
 * fails after the state upsert landed still throws, so the caller reads
 * "not recorded" for a state that was recorded. Catching it here is worse: a
 * `ProfileScope` carries no logger, so the lost edge would vanish silently.
 * A retry on that error is harmless, since the identity comparison finds the
 * stored state and writes nothing, but it does not recover the missing edge.
 */
export async function recordCondition(
  scope: ProfileScope,
  input: RecordConditionInput,
): Promise<RecordConditionResult> {
  const symbol = input.symbol ?? PROFILE_SUBJECT;
  const existing = await findOne(scope, input.condition, symbol);
  const previousCode = existing?.code ?? null;
  // Identity, not code: a caller whose threshold lives in `detail` sends it on
  // `changeKey`, and the callers that do not get `code` as their key, so both
  // sides of this comparison mean the same thing for everyone.
  const previousKey = existing === undefined ? null : (existing.changeKey ?? existing.code);
  const nextKey = input.code === null ? null : (input.changeKey ?? input.code);
  if (previousCode === input.code && previousKey === nextKey) {
    return { changed: false, sinceMs: existing?.since.getTime() ?? null };
  }

  // A moved threshold under an unchanged code is the SAME span, so `since`
  // carries over. Restarting it would report a position blocked for nine days
  // as blocked for a tick every time its arm price re-averaged. A cleared
  // condition reports when its span started, not when it ended.
  const sameSpan = input.code === null || previousCode === input.code;
  const since = sameSpan ? (existing?.since ?? input.now) : input.now;

  if (input.code === null) {
    await clear(scope, input.condition, symbol);
  } else {
    await scope.db
      .insert(conditionStates)
      .values({
        profileId: scope.profileId,
        condition: input.condition,
        symbol,
        code: input.code,
        changeKey: input.changeKey ?? null,
        detail: input.detail ?? null,
        since,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [conditionStates.profileId, conditionStates.condition, conditionStates.symbol],
        set: {
          code: input.code,
          changeKey: input.changeKey ?? null,
          detail: input.detail ?? null,
          since,
          updatedAt: input.now,
        },
      });
  }

  await actionLogs.append(scope, {
    time: input.now,
    symbol: symbol === PROFILE_SUBJECT ? null : symbol,
    level: 'info',
    msg: input.msg ?? defaultMsg(input.condition, symbol, input.code),
    ctx: {
      source: 'condition',
      condition: input.condition,
      code: input.code,
      previousCode,
      sinceMs: since.getTime(),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    },
  });

  return { changed: true, previousCode, sinceMs: since.getTime() };
}

const defaultMsg = (condition: string, symbol: string, code: string | null): string => {
  const subject = symbol === PROFILE_SUBJECT ? condition : `${symbol}: ${condition}`;
  return code === null ? `${subject} cleared` : `${subject} (${code})`;
};

/** The open row for one `(condition, subject)`, or undefined when not open. */
export async function findOne(
  scope: ProfileScope,
  condition: string,
  symbol?: string | null,
): Promise<ConditionStateRow | undefined> {
  const rows = await scope.db
    .select()
    .from(conditionStates)
    .where(
      and(
        eq(conditionStates.profileId, scope.profileId),
        eq(conditionStates.condition, condition),
        eq(conditionStates.symbol, symbol ?? PROFILE_SUBJECT),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * Every open condition for the profile — the diagnosis's primary read. Served by
 * the primary key, which leads with `profile_id`.
 */
export async function listOpen(scope: ProfileScope): Promise<ConditionStateRow[]> {
  return scope.db
    .select()
    .from(conditionStates)
    .where(eq(conditionStates.profileId, scope.profileId));
}

/**
 * Every open row of ONE named condition across all of the profile's symbols, in a single query.
 *
 * Exists because the dashboard needs the same fact for every symbol at once, and it is the hottest route in the app: a per-symbol read would add one round trip per coin to every poll, which is the shape the blocker enrichment beside it already avoids. Served by the same primary key as {@link listOpen}, which leads with `profile_id`.
 *
 * Narrowed by condition NAME rather than reusing {@link listOpen} and filtering in the caller: the profile's other conditions describe decisions the strategy made, and one of those surfaced under a refusal's label would tell the operator a healthy position is not held.
 *
 * @param scope - Ownership-proven profile scope; bounds every row read here to one profile.
 * @param condition - The condition name to read, e.g. {@link POSITION_SEED_REFUSED}.
 * @returns Every open row of that condition, one per subject. Empty when none is open; a symbol absent from the result has no such condition, which is the only way "not refused" is expressed.
 */
export async function listOpenByCondition(
  scope: ProfileScope,
  condition: string,
): Promise<ConditionStateRow[]> {
  return scope.db
    .select()
    .from(conditionStates)
    .where(
      and(eq(conditionStates.profileId, scope.profileId), eq(conditionStates.condition, condition)),
    );
}

/**
 * Drop EVERY condition row for one symbol, whatever the condition name.
 *
 * A row closes only when the producer that opened it writes a null code, and
 * the producer for a symbol is its tick. Unbind the symbol and no tick runs
 * again, so a row left here can never close and the diagnosis reads it forever
 * as a live blocker on a coin the profile no longer holds. Unbinding therefore
 * has to close them, and it cannot name the conditions: the codes belong to the
 * strategy plugins and the crons, so `condition` is enumerated by the rows
 * themselves, not by a list this module would have to keep current.
 *
 * The profile-level subject survives: it is stored under
 * {@link PROFILE_SUBJECT}, which no symbol name equals — and passing that
 * sentinel here is refused rather than obeyed, because "every row for this
 * symbol" would then mean every profile-level condition the profile has.
 */
export async function clearAllForSymbol(scope: ProfileScope, symbol: string): Promise<void> {
  if (symbol === PROFILE_SUBJECT) return;
  await scope.db
    .delete(conditionStates)
    .where(and(eq(conditionStates.profileId, scope.profileId), eq(conditionStates.symbol, symbol)));
}

/** Drop a condition's state row. Idempotent — a missing row is a no-op. */
export async function clear(
  scope: ProfileScope,
  condition: string,
  symbol?: string | null,
): Promise<void> {
  await scope.db
    .delete(conditionStates)
    .where(
      and(
        eq(conditionStates.profileId, scope.profileId),
        eq(conditionStates.condition, condition),
        eq(conditionStates.symbol, symbol ?? PROFILE_SUBJECT),
      ),
    );
}
