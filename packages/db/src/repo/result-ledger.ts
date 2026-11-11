import { and, desc, eq, sql } from 'drizzle-orm';
import {
  backtestResultLedger,
  type BacktestResultLedgerRow,
} from '../schema/backtest-result-ledger.js';
import type { ProfileScope } from './_scoped.js';

export interface LedgerWindow {
  readonly fromMs: number;
  readonly toMs: number;
  readonly interval: string;
  /** The replay context the outcome was measured in; null when the run recorded none. */
  readonly contextFingerprint: string | null;
}

export interface LedgerEntry {
  readonly backtestSignature: string;
  readonly configFingerprint: string | null;
  readonly strategyId: string;
  readonly symbols: readonly string[];
  readonly window: LedgerWindow;
  readonly params: unknown;
  readonly outcome: unknown;
}

/**
 * Record (or refresh) one backtest's durable outcome for the scoped profile.
 * Upserts on (profile_id, backtest_signature): re-running an identical backtest
 * updates the stored outcome rather than duplicating the row. Symbols are stored
 * sorted so {@link listForMarket}'s array-equality match holds regardless of the
 * order they were backtested in.
 */
export async function upsert(scope: ProfileScope, entry: LedgerEntry): Promise<void> {
  await scope.db
    .insert(backtestResultLedger)
    .values({
      profileId: scope.profileId,
      backtestSignature: entry.backtestSignature,
      configFingerprint: entry.configFingerprint,
      strategyId: entry.strategyId,
      symbols: [...entry.symbols].sort(),
      window: entry.window,
      params: entry.params,
      outcome: entry.outcome,
    })
    .onConflictDoUpdate({
      target: [backtestResultLedger.profileId, backtestResultLedger.backtestSignature],
      set: {
        configFingerprint: entry.configFingerprint,
        params: entry.params,
        outcome: entry.outcome,
        updatedAt: new Date(),
      },
    });
}

/**
 * Every prior outcome for one replay context (same symbols, window, strategy and context), newest first. Only a shared context makes a past config and outcome informative about a new run. Symbols are compared as a sorted text[] (stored sorted by {@link upsert}); window fields are read out of the jsonb so the comparison is exact, and a legacy row has no context key so it never matches.
 *
 * @param scope - The owning profile.
 * @param q - The market to match; a null `window.contextFingerprint` matches nothing, because such a run cannot be compared with any other.
 * @returns The matching rows, newest first.
 */
export async function listForMarket(
  scope: ProfileScope,
  q: { symbols: readonly string[]; window: LedgerWindow; strategyId: string },
): Promise<BacktestResultLedgerRow[]> {
  if (q.window.contextFingerprint === null) return [];
  const sorted = [...q.symbols].sort();
  return scope.db
    .select()
    .from(backtestResultLedger)
    .where(
      and(
        eq(backtestResultLedger.profileId, scope.profileId),
        eq(backtestResultLedger.strategyId, q.strategyId),
        // Symbols are stored sorted; compare as a joined string to sidestep
        // array-parameter type inference. Symbols never contain commas.
        sql`array_to_string(${backtestResultLedger.symbols}, ',') = ${sorted.join(',')}`,
        sql`${backtestResultLedger.window}->>'interval' = ${q.window.interval}`,
        sql`(${backtestResultLedger.window}->>'fromMs')::bigint = ${q.window.fromMs}`,
        sql`(${backtestResultLedger.window}->>'toMs')::bigint = ${q.window.toMs}`,
        sql`${backtestResultLedger.window}->>'contextFingerprint' = ${q.window.contextFingerprint}`,
      ),
    )
    .orderBy(desc(backtestResultLedger.updatedAt));
}
