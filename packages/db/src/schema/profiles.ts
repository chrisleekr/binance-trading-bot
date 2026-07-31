import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';

export const profiles = pgTable(
  'profiles',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    strategyName: text('strategy_name').notNull(),
    strategyVersion: text('strategy_version').notNull(),
    config: jsonb('config').notNull(),
    state: jsonb('state').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    // The profile's trading quote currency (e.g. 'USDT', 'BTC'). First-class
    // column, not nested in discovery_config, because it is the single source of
    // truth for the quote the profile trades: discovery filters on it and the
    // balances panel denominates its estimated-value readout in it. (Order
    // amounts use each symbol's own exchange-info quote, not this column.)
    // Operator-settable per profile and live-reloadable (the discovery cron
    // re-reads it each tick).
    quoteAsset: text('quote_asset').notNull().default('USDT'),
    // Equity-benchmark mode for the dashboard's "vs holding" line: 'btc' (legacy
    // BTC hold) or 'basket' (equal-weight hold of the profile's own traded
    // symbols — the honest "did I beat the coins I picked" comparator). First-
    // class column, operator-settable, live-reloaded by the equity-snapshot cron.
    benchmarkMode: text('benchmark_mode').notNull().default('btc'),
    // Pinned backtest run used as the live scorecard's baseline (null = none).
    // The FK + ON DELETE SET NULL lives in the migration, not a Drizzle
    // `.references()`, to avoid a profiles <-> backtest_runs import cycle.
    baselineBacktestRunId: uuid('baseline_backtest_run_id'),
    // Profile-scoped auto-discovery settings, stored OUTSIDE `config` so the
    // strategy schema never sees them (invariant #1 — the worker reads this
    // column directly; the strategy is discovery-agnostic). null = discovery
    // disabled. Shape is validated by the discovery cron (Slice 3), not the DB.
    discoveryConfig: jsonb('discovery_config'),
    // Profile-scoped risk controls (daily-loss circuit breaker), stored OUTSIDE
    // `config` so the strategy never sees them (invariant #1 — enforcement is
    // worker-side, cross-symbol; the pure strategy stays per-(profile,symbol)).
    // null = no risk controls configured. Shape validated by @app/contracts
    // RiskConfigSchema at the API/worker boundary, not the DB.
    riskConfig: jsonb('risk_config'),
    // Profile-scoped live-enablement policy: the backtest-quality thresholds a
    // live profile is checked against (net profit factor, min trades, alpha-vs-hold,
    // max backtest age) and an on/off toggle, plus the advisory edge-decay monitor.
    // All advisory — enabling live is never blocked and no threshold pauses buys.
    // null = use the contract defaults. Shape validated by @app/contracts
    // EnablementPolicy at the API boundary, not the DB.
    enablementPolicy: jsonb('enablement_policy'),
    // Profile-scoped notification subscriptions (which event categories alert the
    // operator), stored OUTSIDE `config` so the strategy never sees them (invariant
    // #1 — the worker reads this column directly when an event fires). null = the
    // contract defaults (every event on). Shape validated by @app/contracts
    // ProfileNotifyEvents at the API/worker boundary, not the DB.
    notifyEvents: jsonb('notify_events'),
    actionLogRetentionDays: integer('action_log_retention_days'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('profiles_account_name_uniq').on(table.accountId, table.name),
    check(
      'profiles_action_log_retention_days_chk',
      sql`${table.actionLogRetentionDays} is null or ${table.actionLogRetentionDays} >= 1`,
    ),
  ],
);

export type ProfileRow = typeof profiles.$inferSelect;
export type ProfileInsert = typeof profiles.$inferInsert;
