import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AccountId } from '@app/contracts';
import {
  avgEntryPrices,
  type AvgEntryPriceInsert,
  type AvgEntryPriceRow,
} from '../schema/avg-entry-prices.js';
import { profiles } from '../schema/profiles.js';
import type { Database } from './_db.js';
import type { ProfileScope } from './_scoped.js';

export async function findBySymbol(
  scope: ProfileScope,
  symbol: string,
): Promise<AvgEntryPriceRow | null> {
  const rows = await scope.db
    .select()
    .from(avgEntryPrices)
    .where(and(eq(avgEntryPrices.profileId, scope.profileId), eq(avgEntryPrices.symbol, symbol)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Batched {@link findBySymbol}: the avg-entry-price rows for `symbols` under the
 * profile, in one query. At most one row per symbol (the table is unique on
 * `(profileId, symbol)`); a symbol with no row is simply absent from the
 * result, so callers build a per-symbol map. Empty `symbols` → `[]`.
 */
export async function findBySymbols(
  scope: ProfileScope,
  symbols: readonly string[],
): Promise<AvgEntryPriceRow[]> {
  if (symbols.length === 0) return [];
  return scope.db
    .select()
    .from(avgEntryPrices)
    .where(
      and(
        eq(avgEntryPrices.profileId, scope.profileId),
        inArray(avgEntryPrices.symbol, [...symbols]),
      ),
    );
}

/**
 * Every avg-entry-price (ledger) row for the profile, across all symbols. The
 * delete-profile guard counts held positions from these without a
 * `profile_symbols` join, so a position on an unbound symbol still blocks the
 * destructive wipe.
 */
export async function listForProfile(scope: ProfileScope): Promise<AvgEntryPriceRow[]> {
  return scope.db
    .select()
    .from(avgEntryPrices)
    .where(eq(avgEntryPrices.profileId, scope.profileId));
}

export async function upsert(
  scope: ProfileScope,
  symbol: string,
  input: Omit<AvgEntryPriceInsert, 'profileId' | 'symbol'>,
): Promise<AvgEntryPriceRow> {
  const [row] = await scope.db
    .insert(avgEntryPrices)
    .values({ ...input, profileId: scope.profileId, symbol })
    .onConflictDoUpdate({
      target: [avgEntryPrices.profileId, avgEntryPrices.symbol],
      set: {
        avgEntryPrice: input['avgEntryPrice'],
        quantity: input['quantity'],
      },
    })
    .returning();
  if (!row) throw new Error('avg-entry-prices.upsert: insert returned no rows');
  return row;
}

/**
 * Total quote-asset cost basis deployed across the account's profiles that share
 * a `quote_asset`: `SUM(avg_entry_price × quantity)` over the cost-basis ledger,
 * joined to `profiles` and bounded to one `account_id` and one `quote_asset`.
 * Returns a decimal-string ('0' when nothing matches). Account-scoped, not
 * profile-scoped — it is the one cross-profile read the account-wide exposure
 * cap and percent-of-account entry sizing need.
 *
 * An account is one Binance account with one environment, so `account_id`
 * already fixes the trading environment (no `binance_mode` filter needed). The
 * quote-asset filter keeps the sum apples-to-apples: a USDT profile must not add
 * a BTC-quoted profile's cost basis (different unit). Cash is per-(profile,
 * mode), so scoping deployed by account+quote keeps equity = cash + deployed
 * internally consistent.
 */
export async function sumDeployedQuoteForAccount(
  db: Database,
  accountId: AccountId,
  quoteAsset: string,
): Promise<string> {
  const [row] = await db
    .select({
      deployed: sql<string>`coalesce(sum(${avgEntryPrices.avgEntryPrice} * ${avgEntryPrices.quantity}), 0)::text`,
    })
    .from(avgEntryPrices)
    .innerJoin(profiles, eq(avgEntryPrices.profileId, profiles.id))
    .where(and(eq(profiles.accountId, accountId), eq(profiles.quoteAsset, quoteAsset)));
  return row?.deployed ?? '0';
}

export async function remove(scope: ProfileScope, symbol: string): Promise<void> {
  await scope.db
    .delete(avgEntryPrices)
    .where(and(eq(avgEntryPrices.profileId, scope.profileId), eq(avgEntryPrices.symbol, symbol)));
}
