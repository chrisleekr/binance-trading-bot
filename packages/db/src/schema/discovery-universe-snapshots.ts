import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { profiles } from './profiles.js';

/**
 * Append-only, profile-scoped point-in-time discovery universe series (#436).
 * One row per discovery cycle so a window accumulates for a later net-edge
 * backtest of the dynamic universe. The discovery cron persists what it already
 * computed; this is pure observability and never feeds the selection.
 */
export const discoveryUniverseSnapshots = pgTable(
  'discovery_universe_snapshots',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    snapshot: jsonb('snapshot').notNull(),
  },
  (table) => [
    index('discovery_universe_snapshots_profile_captured').on(
      table.profileId,
      table.capturedAt.desc(),
    ),
  ],
);

/**
 * Per-cycle filter-funnel counts (#629). Structurally identical to
 * `@app/discovery`'s `DiscoveryFunnel`, redeclared here so the storage schema
 * stays self-contained: `@app/db` depends only on `@app/contracts` + `@app/core`,
 * and adding a `@app/db → @app/discovery` edge for one jsonb sub-shape is not
 * worth the coupling. The worker's `projectFunnel(...)` result is structurally
 * assignable to this. Keep the two shapes in sync when either changes.
 */
export interface DiscoveryFunnel {
  readonly universe: number;
  readonly quote: number;
  readonly blacklist: number;
  readonly liquidity: number;
  readonly activity: number;
  readonly spread: number;
  readonly changeBand: number;
  readonly age: number;
  readonly trend: number;
  readonly eligible: number;
  readonly added: number;
  readonly kept: number;
  readonly removed: number;
  readonly breadthOk: boolean;
}

/** Money / ratio fields stay decimal-strings, matching the wire format end-to-end. */
export interface DiscoveryUniverseSnapshotPayload {
  /** Full quote-matched ranked universe at t, before the ticker filter. */
  readonly universe: readonly {
    readonly symbol: string;
    readonly priceChangePercent: string;
    readonly quoteVolume: string;
  }[];
  /** Post ticker-filter ranked symbols (the shortlist the kline stage gates). */
  readonly shortlist: readonly string[];
  /** The resolved diff this cycle. */
  readonly add: readonly string[];
  readonly remove: readonly string[];
  readonly desired: readonly string[];
  /** Thresholds in force at t, so the backtest knows them without guessing. */
  readonly configDigest: {
    readonly quoteAsset: string;
    readonly maxAutoSymbols: number;
    readonly changeMinPercent: string;
    readonly rankTopPercent: number;
    readonly rankExcludeTopPercent: number;
    readonly marketBreadthMinPercent: string;
  };
  /**
   * Per-cycle filter funnel: survivor counts per stage + the diff outcome. Optional
   * because rows persisted before this field existed have no funnel on disk; every
   * new write populates it (the cron always passes one), so absence marks a
   * historical row, not a current one. Readers must treat `undefined` as "unknown".
   */
  readonly funnel?: DiscoveryFunnel;
}

export type DiscoveryUniverseSnapshotRow = typeof discoveryUniverseSnapshots.$inferSelect;
