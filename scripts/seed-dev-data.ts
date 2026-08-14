#!/usr/bin/env bun
// Dev-only bootstrap + data seeder for a local stack that has no Binance
// connection. Two jobs:
//
//   1. Bootstrap. On an empty database it creates the operator through Better
//      Auth, so the stored password hash is the one sign-up would have written,
//      and adds one profile per registered strategy. A database that already
//      has an operator is adopted as-is: existing accounts and profiles are
//      reused, never replaced.
//   2. Data. Orders, open positions, and the Redis market data the UI reads.
//      Every number is derived from a hash of the symbol, so coins differ from
//      each other the way a real account does while staying identical between
//      runs.
//
// Orders never fill on their own without a Binance connection, so this stands
// in for the history the worker would have accumulated.
//
// Closed-trade archive rows are written only on the docs stack (SEED_DOCS_STACK),
// whose database is disposable. They carry the orders that produced them, so
// realised P/L agrees with the order panels — but nothing distinguishes a seeded
// archive row from a real one afterwards, and that ledger is unrecoverable once
// deleted, so the seeder leaves a dev database's archive history alone.
//
// Repeatable: each profile's orders and positions are wiped and rewritten, so a
// re-run lands the same data.
//
// Run: `bun run seed:dev`

import { writeFile } from 'node:fs/promises';

import { createAuth } from '@app/api';
import {
  asAccountId,
  asProfileId,
  asUserId,
  TechnicalsSignalSchema,
  type AccountId,
  type ProfileId,
  type UserId,
} from '@app/contracts';
import { resolveGitSha } from '@app/core/git-sha';
import {
  accountRepo,
  assertTestDatabaseUrl,
  createDb,
  createPool,
  createRedis,
  dashboardAggregateCacheKey,
  GLOBAL_KEYS,
  ORPHAN_SNAPSHOT_TTL_S,
  profileRepo,
  repo,
  schema,
  type Database,
} from '@app/db';
import { buildStrategyRegistry } from '@app/strategy-registry';
// The one orphan fixture that has to be ADOPTABLE needs an id trailing-trade
// will still claim. The scheme is the plugin's own, so the id is minted by the
// plugin rather than written out as a literal that would rot silently the day
// the hash or a suffix changes — the same reason the api's adoption tests build
// their fixtures this way. This is a dev seeder, not `apps/{api,worker}`, so
// invariant #1's no-plugin-import rule does not reach it.
import { firstBuyClientOrderId } from '@app/strategy-trailing-trade';
import { eq } from 'drizzle-orm';

const HOUR_MS = 3_600_000;
// Fixed base for synthetic binance order ids so re-runs do not drift.
const SEED_ORDER_BASE = 9_000_000_000;

// Credentials the bootstrap creates on an empty database. The screenshot
// capture logs in with the same pair.
const OPERATOR_EMAIL = process.env['SEED_OPERATOR_EMAIL'] ?? 'docs@example.com';
const OPERATOR_PASSWORD = process.env['SEED_OPERATOR_PASSWORD'] ?? 'docs-screenshot-pw-1234';

/**
 * Set only by `scripts/docs/screenshots.ts`, which points this script at a
 * disposable database it owns.
 *
 * Without it the seeder treats the target as the operator's real dev database:
 * it refuses a live-mode account and never creates one. That matters because the
 * fake wallet balances and prices written below land on the same Redis keys a
 * running worker reads for sizing and exit decisions, so seeding a live account
 * would have it act on holdings and prices that do not exist.
 */
const DOCS_STACK = process.env['SEED_DOCS_STACK'] === '1';
const APP_E2E = process.env['SEED_APP_E2E'] === '1';

// Plausible reference prices per base asset, so dummy numbers read sanely and
// the pool doubles as the distinct-base allocation order.
const REF_PRICES: Record<string, number> = {
  BTC: 68_000,
  ETH: 2_100,
  BNB: 580,
  SOL: 150,
  AVAX: 27,
  LINK: 11,
  ATOM: 4.8,
  DOT: 4.2,
  XRP: 0.52,
  ADA: 0.38,
  DOGE: 0.12,
};
const BASE_POOL = Object.keys(REF_PRICES);

/**
 * Symbol for the adoptable orphan fixture. Deliberately outside `REF_PRICES`, so
 * no profile is ever allocated its base: adoption binds the base asset to the
 * adopting profile and is refused when a sibling already manages it. It is also
 * the realistic story for an orphan — a pair dropped from the profile while its
 * buy stayed resting on the exchange.
 */
const ORPHAN_ADOPTABLE_SYMBOL = 'LTCUSDT';

/**
 * How many symbols each profile gets when it tracks none yet. Validated because
 * `Number('')` is 0 and `Number('four')` is NaN — both silently disable the cap
 * in the allocation loop rather than failing.
 */
const SYMBOLS_PER_PROFILE = (() => {
  const raw = process.env['SEED_SYMBOLS_PER_PROFILE'];
  if (raw === undefined) return 4;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`[seed] SEED_SYMBOLS_PER_PROFILE must be a positive integer, got "${raw}"`);
    process.exit(1);
  }
  return parsed;
})();

/**
 * Instant every seeded timestamp is measured back from. The screenshot capture
 * freezes the browser clock to the same value; without that the page clock and
 * the data disagree and every rendered age clamps to "0s ago".
 */
const NOW_MS = (() => {
  const raw = process.env['SEED_NOW_MS'];
  if (raw === undefined) return Date.now();
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`[seed] SEED_NOW_MS must be a positive epoch-ms value, got "${raw}"`);
    process.exit(1);
  }
  return parsed;
})();

// Intervals the technicals cron would have committed. Mirrors the ranking the
// health route sorts by, so the health pill lists a full set.
const TECHNICAL_INTERVALS = ['5m', '15m', '1h', '4h', '1d'] as const;

// Global market-data keys are shared by every account on a Redis instance, and
// Redis SET drops whatever TTL the real writer set. Mirroring the writers' own
// lifetimes means a seeded key expires like a real one instead of pinning fake
// state forever — critically for the heartbeat, where key-present IS the
// liveness signal, so a permanent one would report a dead worker as live.
const TICKER_TTL_S = 600;
const TECHNICALS_TTL_S = 600;
const WORKER_STATUS_TTL_S = 120;

/**
 * Live reference prices, replacing the hardcoded table when Binance is
 * reachable.
 *
 * The symbol workspace reads its 24h stats and its candle chart LIVE from
 * Binance's public endpoints — the API has no seeded path for either. Seeding
 * positions against a stale hardcoded price therefore put an entry of "@ 68,000"
 * next to a chart and a 24h range from a completely different market, which is
 * the "seed data does not match" the docs review flagged.
 *
 * Unauthenticated endpoint, so no credentials are involved. Any failure falls
 * back to the table above: the seeder has to work offline, and a wrong-but-
 * plausible price is better than no seed at all.
 */
async function resolveRefPrices(): Promise<void> {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price', {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`ticker/price returned ${res.status}`);
    const rows = (await res.json()) as { symbol: string; price: string }[];
    const bySymbol = new Map(rows.map((r) => [r.symbol, Number(r.price)]));
    let updated = 0;
    for (const base of BASE_POOL) {
      const live = bySymbol.get(`${base}USDT`);
      // Guard on finite AND positive: a malformed row parses to NaN, and Number
      // spreads NaN silently through every derived size and price below.
      if (live !== undefined && Number.isFinite(live) && live > 0) {
        REF_PRICES[base] = live;
        updated += 1;
      }
    }
    console.log(`[seed] reference prices: ${updated}/${BASE_POOL.length} from live Binance`);
  } catch (err) {
    console.log(
      `[seed] reference prices: using the built-in table ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

const refPrice = (base: string): number => REF_PRICES[base] ?? 1.5;

/** Base asset of a pair, given the profile's quote. */
const baseOf = (symbol: string, quote: string): string =>
  symbol.endsWith(quote) ? symbol.slice(0, -quote.length) : symbol;

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic variation
// ─────────────────────────────────────────────────────────────────────────────
//
// A seed that gives every coin the same drift, the same order count and the
// same profit reads as obviously fabricated: identical "+2.00" on every row.
// These derive each number from an FNV-1a hash of the symbol plus a field name,
// so coins differ from each other but a re-run reproduces the same account.

const hashOf = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
};

/** Stable fraction in [0,1) for one field of one symbol. */
const unit = (key: string, field: string): number => (hashOf(`${key}:${field}`) % 10_000) / 10_000;

/** Stable value in [min,max). */
const between = (key: string, field: string, min: number, max: number): number =>
  min + unit(key, field) * (max - min);

/** Stable integer in [min,max]. */
const intBetween = (key: string, field: string, min: number, max: number): number =>
  min + Math.floor(unit(key, field) * (max - min + 1));

/**
 * Round to the price precision Binance's tick size would impose at this
 * magnitude. Raw float marks render as `0.3797606` next to `66,181.34`, which
 * no exchange would ever quote.
 */
const tick = (price: number): string => {
  const dp = price >= 1000 ? 2 : price >= 1 ? 3 : price >= 0.01 ? 5 : 7;
  return price.toFixed(dp);
};

interface Holding {
  readonly symbol: string;
  readonly base: string;
  /**
   * Price to publish on the ticker key. The live reference price itself, never a
   * drifted one: the symbol workspace reads its 24h stats live from Binance, so
   * anything else shows two prices for one coin on the same screen. Entries
   * carry the per-coin drift instead.
   */
  readonly mark: number;
  /** Wallet balance to publish. Zero means the symbol is tracked but not held. */
  readonly quantity: number;
}
interface SeededProfile {
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
  readonly strategyName: string;
  /**
   * The owning account's `binance_mode`. Carried because the orphan fixture has
   * to be stamped with it: the api refuses to attribute an orphan whose mode
   * differs from the account, so a hardcoded mode makes every row unadoptable on
   * whichever stack does not happen to match.
   */
  readonly binanceMode: string;
  readonly quote: string;
  readonly holdings: readonly Holding[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

interface Operator {
  readonly operatorId: UserId;
  readonly accountId: AccountId;
  /** True when this run created the operator, so placeholder credentials are safe to add. */
  readonly bootstrapped: boolean;
}

/**
 * Create the operator on an empty database, or adopt the existing one.
 *
 * Sign-up runs through Better Auth rather than a direct row insert: the
 * password column has to hold the hash Better Auth's own verifier expects, and
 * its `user.create` hook is what materialises the domain `users` row and the
 * first account in the same transaction. Reimplementing either here would drift
 * the moment auth config changes.
 */
async function ensureOperator(db: Database): Promise<Operator> {
  const existing = await repo.users.count(db);
  // Adopting an existing operator would seed the journey against whatever state
  // that operator already has, so the app-e2e lane demands a database it owns.
  if (APP_E2E && existing !== 0) {
    throw new Error('SEED_APP_E2E requires an empty database and refuses an existing operator');
  }
  if (existing >= 1) {
    const [row] = await db.select().from(schema.users).limit(1);
    if (!row) throw new Error('user count > 0 but no row returned');
    const operatorId = asUserId(row.id);
    const accounts = await repo.accounts.listForOwner(db, operatorId);
    const account = accounts[0];
    if (!account) throw new Error(`operator ${row.email} has no account`);
    console.log(`[seed] operator ${row.email} adopted (account "${account.name}")`);
    return { operatorId, accountId: asAccountId(account.id), bootstrapped: false };
  }

  const authSecret = process.env['AUTH_SECRET'];
  if (!authSecret) {
    console.error('[seed] AUTH_SECRET is not set — required to create the first operator');
    process.exit(1);
  }
  const auth = createAuth({
    db,
    webOrigins: (process.env['WEB_ORIGIN'] ?? 'http://localhost:5173').split(','),
    authSecret,
    isProduction: false,
  });
  await auth.api.signUpEmail({
    body: { email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD, name: 'Operator' },
  });

  const created = await repo.users.findByEmail(db, OPERATOR_EMAIL);
  if (!created) throw new Error(`sign-up did not produce a domain user for ${OPERATOR_EMAIL}`);
  const operatorId = asUserId(created.id);
  const accounts = await repo.accounts.listForOwner(db, operatorId);
  const account = accounts[0];
  if (!account) throw new Error('sign-up did not produce a default account');

  // The at-a-glance ticker sums live+enabled profiles only, so a testnet account
  // renders a permanently empty strip in every screenshot. Only the docs stack
  // trades that for a live-mode account, and only on a database it owns: Better
  // Auth deliberately bootstraps `test` ("no real money until the operator adds
  // live keys"), and silently inverting that on an operator's own database would
  // arm a real-money account they never asked for.
  if (DOCS_STACK) {
    await db
      .update(schema.accounts)
      .set({ binanceMode: 'live' })
      .where(eq(schema.accounts.id, account.id));
  }

  // Password intentionally not echoed — the docs driver inherits this stdout.
  console.log(`[seed] operator ${OPERATOR_EMAIL} created (password: $SEED_OPERATOR_PASSWORD)`);
  return { operatorId, accountId: asAccountId(account.id), bootstrapped: true };
}

/**
 * Give a bootstrapped account a key row so the dashboard stops offering
 * "configure API key" on every profile. Deliberately not applied to an adopted
 * database: a worker running against a real dev account would start signing
 * Binance calls with this placeholder.
 */
async function ensurePlaceholderApiKey(db: Database, op: Operator): Promise<void> {
  const a = await accountRepo(db, op.operatorId, op.accountId);
  if (await a.apiKeys.findForAccount()) return;
  // `pending`, not `ok`: the dashboard only checks that a key row exists, so a
  // fabricated "verified" buys nothing and would break the repo's rule that an
  // unverified key is never reported as verified.
  await a.apiKeys.upsert({
    label: 'Seeded placeholder',
    key: 'SEED-PLACEHOLDER-NOT-A-REAL-BINANCE-KEY',
    secret: 'SEED-PLACEHOLDER-NOT-A-REAL-BINANCE-SECRET',
    last4: 'SEED',
    verificationStatus: 'pending',
    verifiedAt: null,
  });
  console.log('[seed] placeholder api key added');
}

/**
 * Per-strategy config overlays applied on top of the plugin defaults, on every
 * bootstrap — not only the docs stack.
 *
 * The defaults are deliberately inert — an empty grid ladder, a rebalance
 * basket with nothing in it — which is right for a real first-run profile and
 * wrong for a documentation screenshot: the panels that document those features
 * render their "nothing configured yet" empty state instead of the feature.
 * Parsed through the plugin's own schema below, so an overlay that no longer
 * fits the schema fails the seed loudly rather than storing an invalid config.
 */
const SEED_CONFIG_OVERLAY: Record<string, (defaults: Record<string, unknown>) => unknown> = {
  'trailing-trade': (d) => ({
    ...d,
    buy: {
      ...(d['buy'] as Record<string, unknown>),
      // Two rungs: the entry, then one averaging-down step 2% lower. Enough for
      // the grid ladder panel to draw a real ladder and a projection.
      //
      // 2%, not the 3% that reads as the rounder number: the default
      // `sell.stopLossPercentage` is 0.97, so a rung at 0.97 lands exactly on the
      // stop — the signal panel then prints one price twice, and the config it
      // documents is one whose second buy could never fill before the stop exits.
      gridLevels: [
        { triggerPercentage: '1', maxPurchaseAmount: '15' },
        { triggerPercentage: '0.98', maxPurchaseAmount: '30' },
      ],
      maxSymbolExposureQuote: '60',
    },
  }),
  rebalance: (d) => ({
    ...d,
    enabled: true,
    basketBudgetQuote: '1000',
    targets: [
      { symbol: 'ADAUSDT', weight: '0.5' },
      { symbol: 'XRPUSDT', weight: '0.3' },
      { symbol: 'DOGEUSDT', weight: '0.2' },
    ],
  }),
};

/**
 * One enabled profile per registered strategy, so every strategy's config
 * surface is reachable. Config and initial state come from the plugin itself,
 * which is the same path the create-profile route takes.
 */
async function ensureProfiles(db: Database, op: Operator): Promise<void> {
  const a = await accountRepo(db, op.operatorId, op.accountId);
  const existing = await a.profiles.listForAccount();
  const byStrategy = new Set(existing.map((p) => p.strategyName));
  const registry = buildStrategyRegistry();

  for (const plugin of registry.list()) {
    if (byStrategy.has(plugin.name)) continue;
    const overlay = SEED_CONFIG_OVERLAY[plugin.name];
    const config = overlay
      ? plugin.configSchema.parse(overlay(plugin.defaultConfig as Record<string, unknown>))
      : plugin.defaultConfig;
    await a.profiles.insert({
      name: plugin.displayName,
      strategyName: plugin.name,
      strategyVersion: plugin.version,
      config: config as Record<string, unknown>,
      state: plugin.initialState(config as never),
      enabled: true,
    });
    console.log(`[seed] profile "${plugin.displayName}" created`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Redis market data
// ─────────────────────────────────────────────────────────────────────────────

/** Recommendation buckets, ordered so a higher drift maps to a stronger verdict. */
const RECOMMENDATIONS = ['STRONG_SELL', 'SELL', 'NEUTRAL', 'BUY', 'STRONG_BUY'] as const;

/**
 * A technicals verdict for one symbol and interval, shaped by the symbol's own
 * drift so the panel agrees with the direction the price is moving. Parsed
 * through the contract schema, so a schema change fails the seed here instead
 * of rendering an unreadable panel.
 */
const technicalsSignal = (symbol: string, interval: string, nowMs: number): string => {
  const bucket = intBetween(symbol, `rec:${interval}`, 0, RECOMMENDATIONS.length - 1);
  const recommendation = RECOMMENDATIONS[bucket] ?? 'NEUTRAL';
  const signal = TechnicalsSignalSchema.parse({
    symbol,
    recommendation,
    maRecommendation: RECOMMENDATIONS[intBetween(symbol, `ma:${interval}`, 0, 4)] ?? 'NEUTRAL',
    oscRecommendation: RECOMMENDATIONS[intBetween(symbol, `osc:${interval}`, 0, 4)] ?? 'NEUTRAL',
    receivedAtMs: nowMs - intBetween(symbol, `age:${interval}`, 5, 90) * 1_000,
    indicators: null,
  });
  return JSON.stringify(signal);
};

/**
 * Market data the UI reads from Redis rather than Postgres: per-symbol ticker
 * price, the USD price map, per-profile wallet balances, per-profile tick
 * metadata, worker heartbeats and technicals output. The worker normally writes
 * all of it from Binance, so without it the UI shows em-dashes for price, a
 * "bot down" banner, "technicals silent", and "Awaiting first tick" on every
 * profile. Seeding it keeps the whole stack renderable with no credentials.
 */
async function seedRedis(seeded: readonly SeededProfile[]): Promise<void> {
  const url = process.env['REDIS_URL'];
  if (!url) {
    console.log('[seed] REDIS_URL not set — skipping market-data seed');
    return;
  }
  const nowMs = NOW_MS;
  const redis = createRedis(url);
  try {
    const raw = redis.raw();
    const prices: Record<string, string> = {};
    // Marks by base asset, collected as the ticker keys are written. The
    // market-trend card below prices off this rather than re-deriving a drift,
    // so the two cards on the dashboard cannot disagree about BTC.
    const markByBase = new Map<string, number>();
    for (const { quote, holdings } of seeded) {
      prices[quote] = '1';
      for (const h of holdings) {
        prices[h.base] = tick(h.mark);
        markByBase.set(h.base, h.mark);
        await raw.set(
          GLOBAL_KEYS.ticker(h.symbol),
          JSON.stringify({ price: tick(h.mark) }),
          'EX',
          TICKER_TTL_S,
        );
        for (const interval of TECHNICAL_INTERVALS) {
          await raw.set(
            GLOBAL_KEYS.technicals(h.symbol, interval),
            technicalsSignal(h.symbol, interval, nowMs),
            'EX',
            TECHNICALS_TTL_S,
          );
        }
      }
    }
    await raw.set(GLOBAL_KEYS.usdPriceMap(), JSON.stringify({ prices }));

    // Dashboard "Market trend" card. One global key written by the market-trend
    // cron; without it the card sits on "Getting the latest market data…".
    //
    // Priced off the SAME mark the ticker above published, not an independent
    // draw. The two cards sit inches apart on the dashboard, so an independent
    // random walk showed BTC at two different prices on one screen. A coin no
    // profile tracks has no mark, so it falls back to the reference price
    // rather than re-spelling the drift formula with a second range.
    const proxy = (symbol: string, base: string): Record<string, string> => {
      const price = markByBase.get(base) ?? refPrice(base);
      return {
        symbol,
        price: tick(price),
        sma50: tick(price / (1 + between(symbol, 'sma', -0.05, 0.08))),
        regime: 'neutral',
      };
    };
    await redis.forGlobal().set(
      'marketTrend',
      JSON.stringify({
        computedAtMs: nowMs - 45_000,
        symbols: [proxy('BTCUSDT', 'BTC'), proxy('ETHUSDT', 'ETH')],
        breadth: { upCount: 61, total: 148, percentUp: 41.2 },
      }),
      {},
    );

    // Per-interval compute receipts. Absent keys are what the UI reads as
    // "technicals silent", so the pill stays amber however fresh the ratings are.
    const symbolCount = seeded.reduce((n, p) => n + p.holdings.length, 0);
    for (const interval of TECHNICAL_INTERVALS) {
      await raw.set(
        GLOBAL_KEYS.technicalsComputeStatus(interval),
        JSON.stringify({
          interval,
          fetchedAtMs: nowMs - 30_000,
          requested: symbolCount,
          written: symbolCount,
          skippedErrored: 0,
          skippedInvalid: 0,
          latencyMs: 400 + intBetween(interval, 'latency', 0, 600),
          lastFreshAtMs: nowMs - 30_000,
        }),
      );
    }

    for (const { accountId, profileId, quote, holdings } of seeded) {
      const scope = { accountId, profileId };
      const balances: Record<string, { free: string; locked: string }> = {
        // Spendable quote cash, so the equity and sizing previews are non-zero.
        [quote]: { free: '5000.00000000', locked: '0.00000000' },
      };
      for (const h of holdings) {
        if (h.quantity <= 0) continue;
        balances[h.base] = { free: h.quantity.toFixed(8), locked: '0.00000000' };
      }
      await redis.forProfile(scope).set('accountInfo', JSON.stringify({ balances }), {});
      // Without this the dashboard reads every profile as never having ticked
      // and offers "Awaiting first tick · configure API key" under each row.
      await redis.forProfile(scope).set(
        'profileTickMeta',
        JSON.stringify({
          lastTickAt: new Date(nowMs - intBetween(profileId, 'tick', 4, 50) * 1_000).toISOString(),
          lastTickLatencyMs: intBetween(profileId, 'latency', 90, 480),
          lastTickError: null,
        }),
        {},
      );
      // The dashboard projection caches its own rollup; a stale entry would
      // survive this reseed and show the previous run's numbers.
      await redis.forProfile(scope).del('dashboardCache');
      // The ACCOUNT-scoped aggregate has its own cache key, separate from the
      // per-profile one. Missing it left the dashboard, and anything reading the
      // aggregate, serving the previous run's rollup — positions included.
      await raw.del(dashboardAggregateCacheKey(accountId));
    }

    // Dust-transfer page. Written by the `dust-snapshot` cron from Binance's
    // own eligible set, so an unseeded key leaves the page permanently empty.
    // The assets are deliberately NOT ones a profile trades: dust is what is
    // left over from coins you are no longer in, which is the whole point of
    // the screen.
    //
    // `estimatedBTC` must clear Binance's 0.001 BTC dust minimum, which the page
    // filters on: seeded below it, every row is hidden and the screen documents
    // its empty state instead of the feature. At a ~60k BTC these are roughly
    // $70-$190 of leftovers, which is what real dust looks like.
    const DUST = [
      { asset: 'TRX', free: '4130.00000000', btc: '0.00214000', eligible: true },
      { asset: 'VET', free: '1830.00000000', btc: '0.00312000', eligible: true },
      { asset: 'ALGO', free: '124.50000000', btc: '0.00118000', eligible: true },
      // Binance refuses some assets whatever their value; one ineligible row is
      // what documents the greyed-out state.
      { asset: 'ONE', free: '6400.00000000', btc: '0.00164000', eligible: false },
    ];
    for (const { accountId, profileId } of seeded) {
      await redis.forProfile({ accountId, profileId }).set(
        'dustEligible',
        JSON.stringify({
          assets: DUST.map((d) => ({
            asset: d.asset,
            free: d.free,
            locked: '0.00000000',
            estimatedBTC: d.btc,
            canDustTransfer: d.eligible,
          })),
          fetchedAt: new Date(nowMs - 90_000).toISOString(),
        }),
        {},
      );
    }

    // Orphan-orders page: orders open on Binance that no local row tracks.
    // Account-global, written by the `orphan-orders-detect` cron.
    //
    // Three rows, one per outcome the page can reach, because a set that only
    // shows refusals documents a screen headed "Orders to adopt" on which Adopt
    // never appears:
    //
    //   1. ADOPTABLE   — a trailing-trade grid buy the strategy can still claim.
    //   2. UNRECOGNISED — placed by hand on Binance; no strategy claims it.
    //   3. BLOCKED SELL — unclaimed AND holding coin, the worst case.
    //
    // Adoptability is not a flag on the row: the api asks each strategy whether
    // its own clientOrderId scheme emitted this id for this (profile, symbol).
    // So row 1 has to carry a REAL id, minted by the strategy that owns the
    // scheme — a hand-written lookalike would silently stop matching the day the
    // hash or a suffix changes, and the page would quietly lose its Adopt state.
    const accountIds = [...new Set(seeded.map((s) => s.accountId))];
    for (const accountId of accountIds) {
      const forAccount = seeded.filter((s) => s.accountId === accountId);
      const tt = forAccount.find((s) => s.strategyName === 'trailing-trade');
      // On the docs stack the bootstrap creates one profile per registered
      // strategy, so a missing trailing-trade profile means the fixture cannot do
      // its job and the screenshot would document a page whose primary action
      // never appears. On an adopted dev database that profile may legitimately
      // not exist — say so and ship the two refusals rather than abort a run that
      // has already rewritten every order and position.
      if (!tt && DOCS_STACK) {
        throw new Error(`[seed] account ${accountId} has no trailing-trade profile`);
      }
      if (!tt) {
        console.log(
          `[seed] account ${accountId}: no trailing-trade profile — ` +
            'orphan fixture ships without an adoptable row',
        );
      }
      // The FIRST-BUY id, not a grid-level one. Attribution enumerates grid ids
      // only up to the profile's configured level count, so a level-1 id stops
      // being claimable the moment a profile has fewer than two rungs — true on
      // any dev database the bootstrap did not create. The first-buy id has no
      // config dependency and attributes to the same `grid-buy` intent, so the
      // page copy is identical and the fixture cannot silently stop working.
      //
      // Stamped with the ACCOUNT's mode, never a literal: attribution refuses an
      // orphan whose mode differs from the account, so a hardcoded `live` makes
      // every row unadoptable on a dev stack, whose account stays `test`.
      // Absent rather than defaulted — `forAccount` is filtered from the same
      // list `accountIds` was derived from, so an empty one is a real bug and
      // defaulting it would silently stamp the wrong mode.
      const mode = forAccount[0]?.binanceMode;
      if (mode === undefined) throw new Error(`[seed] account ${accountId} has no seeded profile`);
      const adoptable = tt
        ? [
            {
              orderId: '38217449021',
              accountId,
              symbol: ORPHAN_ADOPTABLE_SYMBOL,
              side: 'BUY',
              type: 'LIMIT',
              price: '61.40000000',
              origQty: '0.32000000',
              status: 'NEW',
              clientOrderId: firstBuyClientOrderId(tt.profileId, ORPHAN_ADOPTABLE_SYMBOL),
              timeMs: nowMs - 5 * HOUR_MS,
              mode,
            },
          ]
        : [];

      // Written through the typed op so it carries ORPHAN_SNAPSHOT_TTL_S. That
      // TTL is the only thing stopping a stale orphan set being served as
      // current, so a seeded key without one is immortal by construction.
      await redis.forGlobal().set(
        'orphanSnapshot',
        JSON.stringify({
          computedAtMs: nowMs - 120_000,
          orphans: [
            ...adoptable,
            {
              orderId: '38217486135',
              accountId,
              symbol: 'FILUSDT',
              side: 'BUY',
              type: 'LIMIT',
              price: '3.11000000',
              origQty: '9.40000000',
              status: 'NEW',
              clientOrderId: 'web_a41f0c2d9b6e4f',
              timeMs: nowMs - 19 * HOUR_MS,
              mode,
            },
            {
              orderId: '38217512884',
              accountId,
              symbol: 'TRXUSDT',
              side: 'SELL',
              type: 'LIMIT',
              price: '0.14820000',
              origQty: '410.00000000',
              status: 'NEW',
              clientOrderId: 'ttb-grid-sell-legacy-01',
              timeMs: nowMs - 31 * HOUR_MS,
              mode,
            },
          ],
        }),
        { ttlSeconds: ORPHAN_SNAPSHOT_TTL_S },
        accountId,
      );
    }

    // Clears the "BOT DOWN — RESTART WORKER" banner and the "study down" build
    // note. Bare keys, no scope prefix. The SHA is resolved the same way the api
    // resolves its own, otherwise the two disagree and the UI trades the down
    // banner for "restart needed". `bootedAt` is now rather than an hour back:
    // the status bar reads a boot that predates the newest applied migration as
    // schema lag and raises the same "restart needed" pill.
    const heartbeat = JSON.stringify({
      sha: resolveGitSha(process.env['GIT_SHA']),
      bootedAt: new Date(nowMs).toISOString(),
    });
    await raw.set('worker:status', heartbeat, 'EX', WORKER_STATUS_TTL_S);
    await raw.set('worker:study-status', heartbeat, 'EX', WORKER_STATUS_TTL_S);

    console.log(
      `[seed] redis: ${Object.keys(prices).length} price(s), ${seeded.length} wallet(s), ` +
        `${TECHNICAL_INTERVALS.length} technicals interval(s)`,
    );
  } finally {
    await redis.quit();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Action logs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The per-symbol Logs tab reads `action_logs`. The worker writes one row only
 * when a symbol's entry-blocker REASON changes, so a healthy profile emits a
 * handful a day — and a freshly seeded database emits none at all, leaving the
 * tab documenting "No log entries in the last 24 hours".
 *
 * These mirror the shape the worker writes (reason in `ctx`, plain-language
 * message) for the last day, so the tab shows what an operator would actually
 * read there.
 */
const LOG_LINES: readonly { level: string; msg: string; reason: string }[] = [
  { level: 'info', msg: 'buy order placed', reason: 'grid-buy-placed' },
  {
    level: 'info',
    msg: 'not buying: waiting for the price to dip to your buy trigger',
    reason: 'awaiting-trigger-price',
  },
  { level: 'info', msg: 'trailing stop armed', reason: 'trail-armed' },
  {
    level: 'warn',
    msg: 'not buying: the technical rating is bearish on 1h',
    reason: 'technicals',
  },
  { level: 'info', msg: 'sell order placed at the trailing stop', reason: 'grid-sell-placed' },
  {
    level: 'info',
    msg: 'not buying: this symbol is at its exposure cap',
    reason: 'risk-caps',
  },
];

async function seedActionLogs(db: Database, seeded: readonly SeededProfile[]): Promise<void> {
  let written = 0;
  for (const { profileId, holdings } of seeded) {
    await db.delete(schema.actionLogs).where(eq(schema.actionLogs.profileId, profileId));
    const rows = [];
    for (const h of holdings) {
      // Spread back from `now` so the tab's "last 24 hours" default window is
      // populated and the ordering is meaningful rather than all one instant.
      for (const [i, line] of LOG_LINES.entries()) {
        const minutesAgo = intBetween(h.symbol, `log${i}`, 3, 22 * 60);
        rows.push({
          time: new Date(NOW_MS - minutesAgo * 60_000),
          profileId,
          symbol: h.symbol,
          level: line.level,
          msg: line.msg,
          ctx: { seed: true, reason: line.reason, symbol: h.symbol },
        });
      }
    }
    if (rows.length > 0) {
      await db.insert(schema.actionLogs).values(rows);
      written += rows.length;
    }
  }
  console.log(`[seed] action logs: ${written} row(s)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Guards
// ─────────────────────────────────────────────────────────────────────────────

/** Local-only DB host, unless the operator explicitly opts out. */
function assertSafeTarget(connectionString: string): void {
  if (APP_E2E) return;
  if (process.env['SEED_ALLOW_REMOTE'] === '1') return;
  const host = (() => {
    try {
      return new URL(connectionString).hostname;
    } catch {
      return '';
    }
  })();
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    console.error(
      `[seed] refusing to seed non-local DB host "${host}" — ` +
        'this script wipes rows. Set SEED_ALLOW_REMOTE=1 to override.',
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    console.error('[seed] refusing to run with NODE_ENV=production');
    process.exit(1);
  }
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    console.error('[seed] DATABASE_URL is not set');
    process.exit(1);
  }
  if (APP_E2E) {
    assertTestDatabaseUrl(connectionString);
    if (!process.env['SEED_MANIFEST_PATH']) {
      throw new Error('SEED_MANIFEST_PATH is required when SEED_APP_E2E=1');
    }
  }
  assertSafeTarget(connectionString);
  console.log(`[seed] target: ${connectionString.replace(/:[^:@/]+@/, ':***@')}`);

  // Before anything price-derived: entry prices, order prices, wallet balances
  // and the market-trend card all key off this table.
  if (!APP_E2E) await resolveRefPrices();

  const pool = createPool({ kind: 'admin', connectionString });
  const db = createDb(pool);

  try {
    // Queried against `accounts`, not the profiles join below: an account can be
    // live-mode with no profiles yet, and the Redis keys this script overwrites
    // (tickers, technicals, the worker heartbeat) are instance-global, so they
    // would still reach a live worker.
    const liveAccounts = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.binanceMode, 'live'))
      .limit(1);

    const op = await ensureOperator(db);

    // SEED_DOCS_STACK disarms the live-account refusal and licenses the archive
    // wipe, so it must be proven rather than trusted: the docs database only ever
    // holds the operator this script created. A mistyped DOCS_DATABASE_URL
    // pointing at a real database is otherwise a fully-disarmed seeder.
    if (DOCS_STACK && !op.bootstrapped) {
      const [owner] = await db.select({ email: schema.users.email }).from(schema.users).limit(1);
      if (owner?.email !== OPERATOR_EMAIL) {
        console.error(
          `[seed] refusing: SEED_DOCS_STACK is set but this database belongs to ` +
            `"${owner?.email ?? 'unknown'}", not the docs operator (${OPERATOR_EMAIL}).`,
        );
        process.exit(1);
      }
    }

    if (op.bootstrapped) {
      await ensurePlaceholderApiKey(db, op);
      // Only on a database this run created. Adding an enabled, symbol-bound
      // profile to an operator's existing account is not adoption — the worker
      // would pick it up on its next reconfigure and start trading coins they
      // never chose.
      await ensureProfiles(db, op);
    }

    if (APP_E2E) {
      const account = await accountRepo(db, op.operatorId, op.accountId);
      const profiles = await account.profiles.listForAccount();
      const first = profiles[0];
      if (!first) throw new Error('app-e2e seed produced no profile');
      for (const profile of profiles) {
        const scoped = await profileRepo(db, op.operatorId, op.accountId, asProfileId(profile.id));
        await scoped.profile.setEnabled(false);
      }
      // Shell-sourceable so the harness can export these straight into
      // Playwright's environment, the same channel the Binance fixture uses.
      await writeFile(
        process.env['SEED_MANIFEST_PATH']!,
        [
          `export E2E_USER_EMAIL=${JSON.stringify(OPERATOR_EMAIL)}`,
          `export E2E_USER_PASSWORD=${JSON.stringify(OPERATOR_PASSWORD)}`,
          `export E2E_ACCOUNT_ID=${JSON.stringify(op.accountId)}`,
          `export E2E_PROFILE_ID=${JSON.stringify(first.id)}`,
          '',
        ].join('\n'),
      );
      return;
    }

    // Every profile's plugin, resolved BEFORE the loop below starts deleting
    // rows. Seeded strategy state comes from the plugin rather than a literal
    // this file would have to keep in step with the strategy's schema — and a
    // profile whose strategy is no longer registered has to stop the run while
    // the database is still intact, not halfway through rewriting it.
    const strategies = buildStrategyRegistry();
    const pluginByProfile: Record<string, ReturnType<typeof strategies.list>[number]> = {};

    // A profile no longer carries the operator id: ownership runs
    // profile -> account -> user, so the owner is only reachable by joining
    // accounts. ProfileScope needs all three ids to prove the chain.
    // Ordered so the allocation below is reproducible: without ORDER BY,
    // Postgres owes no particular row order and which profile claims a base
    // asset can change between runs.
    const rows = await db
      .select({
        profile: schema.profiles,
        ownerId: schema.accounts.ownerId,
        accountId: schema.accounts.id,
        binanceMode: schema.accounts.binanceMode,
      })
      .from(schema.profiles)
      .innerJoin(schema.accounts, eq(schema.profiles.accountId, schema.accounts.id))
      .orderBy(schema.profiles.createdAt, schema.profiles.id);
    if (rows.length === 0) {
      console.log('[seed] no profiles found — create one first, then re-run');
      return;
    }

    // Resolved here, before the first delete: a profile whose strategy left the
    // registry cannot be seeded, and finding that out mid-loop would leave the
    // database half-wiped.
    for (const { profile } of rows) {
      const plugin = strategies.get(profile.strategyName);
      if (!plugin) {
        throw new Error(
          `[seed] profile ${profile.id}: strategy "${profile.strategyName}" is not registered`,
        );
      }
      pluginByProfile[profile.id] = plugin;
    }

    // The wallet balances and prices seeded below land on the Redis keys the
    // worker reads for sizing and exits, and the wipe removes closed-trade
    // history. Against a live account that is real money acting on invented
    // state, so refuse unless this is the docs stack's own database.
    if (!DOCS_STACK && liveAccounts.length > 0) {
      console.error(
        '[seed] refusing: this database holds a live-mode account. Seeding writes fake ' +
          'balances and prices to the keys the worker trades on. Use `bun run docs:screenshots`, ' +
          'which seeds its own disposable database.',
      );
      process.exit(1);
    }

    // Profiles that pin a symbol in config are allocated first, otherwise a
    // pool-fed profile can take the pinned base and leave the pinned profile
    // tracking a pair its own config does not name.
    rows.sort(
      (a, b) =>
        Number(Boolean((b.profile.config as { symbol?: string }).symbol)) -
        Number(Boolean((a.profile.config as { symbol?: string }).symbol)),
    );

    const seeded: SeededProfile[] = [];

    // A base asset belongs to at most one profile per account, so allocation has
    // to be tracked across profiles — per account, which is the scope the repo's
    // exclusivity guard enforces. Collected up front rather than as each profile
    // is reached: a profile that already holds BTC but sorts last would otherwise
    // not have claimed it before an earlier profile draws from the pool.
    const usedBasesByAccount = new Map<string, Set<string>>();
    for (const row of await db
      .select({ accountId: schema.profiles.accountId, baseAsset: schema.profileSymbols.baseAsset })
      .from(schema.profileSymbols)
      .innerJoin(schema.profiles, eq(schema.profileSymbols.profileId, schema.profiles.id))) {
      const set = usedBasesByAccount.get(row.accountId) ?? new Set<string>();
      set.add(row.baseAsset.toUpperCase());
      usedBasesByAccount.set(row.accountId, set);
    }

    // Quote assets are the other half of the guard: a profile that SETTLES in a
    // base spends it off the same wallet line, so binding that base elsewhere on
    // the account collides too. A profile can also never trade its own quote.
    const quotesByAccount = new Map<string, Set<string>>();
    for (const row of await db
      .select({ accountId: schema.profiles.accountId, quoteAsset: schema.profiles.quoteAsset })
      .from(schema.profiles)) {
      const set = quotesByAccount.get(row.accountId) ?? new Set<string>();
      set.add(row.quoteAsset.toUpperCase());
      quotesByAccount.set(row.accountId, set);
    }

    let orderSeq = 0;
    for (const { profile, ownerId, accountId, binanceMode } of rows) {
      const p = await profileRepo(
        db,
        asUserId(ownerId),
        asAccountId(accountId),
        asProfileId(profile.id),
      );

      // Symbols the profile tracks; if none, attach the profile's own pair.
      // `config` is jsonb — the loose cast is intentional for a dev seed.
      const quote = profile.quoteAsset;
      // Stored back into the map, not a throwaway: on a fresh database the
      // account has no bindings yet, and a per-profile Set would lose every
      // claim the previous profile made and hand out the same base twice.
      let usedBases = usedBasesByAccount.get(accountId);
      if (!usedBases) {
        usedBases = new Set<string>();
        usedBasesByAccount.set(accountId, usedBases);
      }
      const siblingQuotes = quotesByAccount.get(accountId) ?? new Set<string>();
      // `baseAsset` comes off the stored column, not from slicing the quote off
      // the pair: the exclusivity guard keys on that column, and a pair whose
      // quote differs from the profile's (BTCFDUSD on a USDT profile) would
      // otherwise leave BTC looking free and collide on the next allocation.
      const bound = await p.profileSymbols.listForProfile();
      let symbols = bound.map((s) => s.symbol);

      if (symbols.length === 0) {
        // Honour a config-pinned pair first (trailing-trade), then top up from
        // the pool. The base, not the pair, is what the exclusivity guard keys
        // on, so each pick has to be globally unused across profiles.
        const pinned = (profile.config as { symbol?: string }).symbol;
        const picked: string[] = [];
        const take = (raw: string): void => {
          const base = raw.toUpperCase();
          if (picked.length >= SYMBOLS_PER_PROFILE) return;
          // Every case the repo's bind guard rejects: a sibling already trades
          // this base, a sibling settles in it, or it is this profile's own quote.
          if (usedBases.has(base) || siblingQuotes.has(base)) return;
          usedBases.add(base);
          picked.push(base);
        };
        if (pinned) take(baseOf(pinned, quote));
        for (const base of BASE_POOL) take(base);

        if (picked.length === 0) {
          console.log(`[seed] ${profile.name}: no free base asset left, skipped`);
          continue;
        }
        for (const base of picked) {
          await p.profileSymbols.upsert(`${base}${quote}`, base, { overrideConfig: null });
        }
        symbols = picked.map((base) => `${base}${quote}`);
      }

      // Wipe prior seed so a re-run lands the same set of rows. Deliberately
      // after allocation: a profile skipped for want of a free base asset above
      // would otherwise be left emptied and never repopulated. Scoped by the
      // profile id the proven `ProfileScope` carries.
      await db.delete(schema.orders).where(eq(schema.orders.profileId, p.scope.profileId));
      await db
        .delete(schema.avgEntryPrices)
        .where(eq(schema.avgEntryPrices.profileId, p.scope.profileId));
      // Strategy state is written per symbol below, so without this a re-run that
      // allocates a different symbol set strands the previous run's slices —
      // rows nothing points at, on a script whose contract is "a re-run lands the
      // same data".
      await p.symbolStates.removeAllForProfile();
      // Archive rows are seeded (and therefore wiped) only on the docs stack's
      // disposable database. `trade_archive` is the realised-P/L ledger and the
      // only record of a completed cycle: the fee roll-up and decomposition are
      // computed at archive time and cannot be re-derived from Binance later, so
      // a real row deleted here is gone. Nothing distinguishes a seeded row from
      // a real one afterwards — `breakdown` is schema-constrained to decimal
      // strings — so the seeder never touches archive history it did not create.
      if (DOCS_STACK) {
        await db
          .delete(schema.tradeArchive)
          .where(eq(schema.tradeArchive.profileId, p.scope.profileId));
      }

      const now = NOW_MS;
      const holdings: Holding[] = [];
      let closedCount = 0;
      for (const symbol of symbols) {
        const base = baseOf(symbol, quote);
        const price = refPrice(base);
        // Position size varies per coin: an account where every entry cost the
        // same round number reads as generated.
        const buyQuote = Math.round(between(symbol, 'size', 60, 260));
        const baseQty = buyQuote / price;

        // Closed round trips, spread across the last week so the today, week and
        // all-time P/L widgets each have something to report. Mostly winners
        // with real losers mixed in, as a working grid would produce.
        const tradeCount = intBetween(symbol, 'trades', 2, 4);
        for (let n = 0; n < tradeCount; n++) {
          // The most recent trade of each coin closes within the last hour. The
          // "realised today" widgets cut on the operator's UTC day, so a set
          // whose newest trade is hours old reports a flat zero for most of the
          // morning in any zone ahead of UTC.
          //
          // Each trade draws from its own non-overlapping band. `trade_archive`
          // is uniquely indexed on (profile, symbol, cycle_end) and its insert is
          // ON CONFLICT DO NOTHING, so two trades of one coin hashing into the
          // same millisecond would silently collapse into one row rather than
          // fail — deterministically, for whatever symbol happened to collide.
          const soldHoursAgo =
            n === 0
              ? between(symbol, 'sold0', 0.1, 0.8)
              : between(symbol, `sold${n}`, 8 + (n - 1) * 40, 8 + n * 40);
          const profitPct = between(symbol, `pnl${n}`, -0.035, 0.055);
          const tradeQuote = Math.round(between(symbol, `spend${n}`, 50, 240));
          const tradeQty = tradeQuote / price;
          // Rounded to cents: these land in `numeric(38,18)` columns and render
          // verbatim, so raw float residue shows up as "182.947876000000007934"
          // in the archive table.
          const profit = Number((tradeQuote * profitPct).toFixed(2));
          const sellQuote = Number((tradeQuote + profit).toFixed(2));
          const sellClosedAt = new Date(now - soldHoursAgo * HOUR_MS);
          // The buy that opened the cycle sits a plausible hold time earlier.
          const closedBase = sellClosedAt.getTime() - between(symbol, `hold${n}`, 1, 20) * HOUR_MS;

          // `createdAt` is set explicitly, not left to `defaultNow()`. The order
          // history table renders the creation time, so defaulting stamped every
          // seeded order with the same second and the panel read as one batch
          // dumped at boot rather than a week of trading.
          await p.orders.insert({
            symbol,
            side: 'BUY',
            intent: 'grid-buy',
            binanceOrderId: BigInt(SEED_ORDER_BASE + ++orderSeq),
            clientOrderId: `seed-${symbol}-buy-${n}`,
            status: 'FILLED',
            raw: { seed: true, origQty: tradeQty.toFixed(8), price: price.toFixed(8) },
            createdAt: new Date(closedBase),
            closedAt: new Date(closedBase),
          });
          await p.orders.insert({
            symbol,
            side: 'SELL',
            intent: 'grid-sell',
            binanceOrderId: BigInt(SEED_ORDER_BASE + ++orderSeq),
            clientOrderId: `seed-${symbol}-sell-${n}`,
            status: 'FILLED',
            raw: {
              seed: true,
              origQty: tradeQty.toFixed(8),
              price: (sellQuote / tradeQty).toFixed(8),
            },
            realizedPnl: profit.toFixed(8),
            costBasisQuote: tradeQuote.toFixed(8),
            createdAt: sellClosedAt,
            closedAt: sellClosedAt,
          });

          // The archive row is what the realised-P/L widgets and the archive
          // page read. It carries the two orders above, so the page's detail
          // view agrees with the order history rather than showing a bare total.
          // Docs stack only, paired with the wipe above: on a dev database these
          // rows cannot be told apart from real ones later, so a re-run would
          // either accumulate them forever or risk deleting genuine history.
          if (DOCS_STACK) {
            const archived = await p.tradeArchive.insert({
              symbol,
              baseAsset: base,
              quoteAsset: quote,
              totalBuyQuote: tradeQuote.toFixed(18),
              totalSellQuote: sellQuote.toFixed(18),
              profit: profit.toFixed(18),
              profitPercent: (profitPct * 100).toFixed(10),
              breakdown: {
                'grid-buy:BUY': tradeQuote.toFixed(8),
                'grid-sell:SELL': sellQuote.toFixed(8),
              },
              orders: [
                {
                  side: 'BUY',
                  intent: 'grid-buy',
                  quote: tradeQuote.toFixed(8),
                  price: price.toFixed(8),
                },
                {
                  side: 'SELL',
                  intent: 'grid-sell',
                  quote: sellQuote.toFixed(8),
                  price: (sellQuote / tradeQty).toFixed(8),
                },
              ],
              fees: {},
              feesQuote: (tradeQuote * 0.001).toFixed(4),
              source: 'manual',
              archivedAt: sellClosedAt,
              cycleEnd: sellClosedAt,
            });
            // A null return is the conflict path: the bands above are meant to
            // make that unreachable, so surface it rather than under-report.
            if (!archived) {
              throw new Error(`[seed] ${symbol} trade ${n}: cycleEnd collision — bands overlap`);
            }
          }
          closedCount += 1;
        }

        // Where the position was opened, a couple of percent either side of the
        // mark so unrealised P/L is a mix of gains and losses rather than the
        // same figure on every row.
        //
        // The drift belongs on the ENTRY, not on the mark. The mark is what gets
        // published to the ticker key, and the symbol workspace fetches its own
        // 24h stats live from Binance on that very screen — so a drifted mark
        // puts two different prices for one coin side by side, and marks the
        // position's P/L at a price the header is not showing.
        const entryPrice = price / (1 + between(symbol, 'drift', -0.025, 0.03));

        // Roughly two coins in three are held, so the positions panel and the
        // watching-only rows both have content.
        const held = unit(symbol, 'held') > 0.35;
        if (held) {
          await p.avgEntryPrices.upsert(symbol, {
            avgEntryPrice: String(entryPrice),
            quantity: String(baseQty.toFixed(8)),
          });
        }

        // A per-(profile, symbol) strategy state slice, which only a tick writes.
        // Without one the workspace's Signal panel reads "no signal — strategy
        // state unavailable", which documents a fault rather than the panel.
        //
        // Every tracked symbol, not just the held ones: a running worker writes a
        // slice on every tick regardless of position, so seeding only the held
        // ones models a state the real system never produces — and leaves the
        // fault message on screen for the watching-only symbols.
        //
        // The position is folded in through the plugin's OWN adapter, not by
        // naming any strategy's state fields here (invariant #1). It has to be:
        // for momentum and rebalance the open position LIVES in this body, so a
        // bare `initialState` next to a seeded `avg_entry_prices` row renders a
        // header that says "holding" above a signal panel that says "flat".
        // `setAvgEntryPrice` / `setHeldQuantity` return null when they reject the
        // body, so each step falls back to the value it was given.
        const plugin = pluginByProfile[profile.id];
        const initial = plugin.initialState(profile.config as never);
        const withEntry = held
          ? (plugin.position.setAvgEntryPrice(initial, String(entryPrice)) ?? initial)
          : initial;
        const withPosition = held
          ? (plugin.position.setHeldQuantity(withEntry, baseQty.toFixed(8)) ?? withEntry)
          : withEntry;
        await p.symbolStates.upsert(symbol, {
          state: withPosition as Record<string, unknown>,
          strategyVersion: plugin.version,
        });

        // Resting orders. `orders_one_live_per_intent` allows at most one open
        // order per (profile, symbol, intent), so a varied order count comes
        // from which intents are armed, not from stacking rungs of one intent:
        // an averaging-down buy, a take-profit sell once a position exists, and
        // a protective stop under some of those positions.
        const resting: { intent: string; side: 'BUY' | 'SELL'; price: number; qty: number }[] = [];
        if (unit(symbol, 'buy-armed') > 0.2) {
          const restPrice = price * 0.985;
          resting.push({
            intent: 'grid-buy',
            side: 'BUY',
            price: restPrice,
            qty: buyQuote / restPrice,
          });
        }
        if (held) {
          // Sell-side quantities come off what is actually HELD, never off the
          // entry budget. Sizing a sell from `buyQuote / price` produced resting
          // sells for MORE coin than the position contained — a state Binance
          // would reject outright, and the first thing a reader notices when the
          // panels are read side by side.
          resting.push({
            intent: 'grid-sell',
            side: 'SELL',
            price: price * 1.035,
            qty: baseQty,
          });
          if (unit(symbol, 'stop-armed') > 0.6) {
            // A protective stop covers the position too, so the two sells sum to
            // twice the holding on paper. That is what live looks like: only one
            // of them can ever fill, and the strategy cancels the other.
            resting.push({
              intent: 'protective-stop',
              side: 'SELL',
              price: price * 0.94,
              qty: baseQty,
            });
          }
        }
        for (const order of resting) {
          await p.orders.insert({
            symbol,
            side: order.side,
            intent: order.intent,
            binanceOrderId: BigInt(SEED_ORDER_BASE + ++orderSeq),
            clientOrderId: `seed-${symbol}-${order.intent}`,
            status: 'NEW',
            raw: {
              seed: true,
              origQty: order.qty.toFixed(8),
              price: order.price.toFixed(8),
            },
            createdAt: new Date(now - intBetween(symbol, `rest:${order.intent}`, 5, 300) * 60_000),
          });
        }
        holdings.push({ symbol, base, mark: price, quantity: held ? baseQty : 0 });
      }
      seeded.push({
        accountId: asAccountId(accountId),
        profileId: asProfileId(profile.id),
        strategyName: profile.strategyName,
        binanceMode,
        quote,
        holdings,
      });

      const heldCount = holdings.filter((h) => h.quantity > 0).length;
      console.log(
        `[seed] ${profile.name}: ${symbols.length} symbol(s), ${heldCount} position(s), ` +
          `${closedCount} closed trade(s)`,
      );
    }
    await seedActionLogs(db, seeded);
    await seedRedis(seeded);
    console.log('[seed] done');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('[seed]', err);
  process.exit(1);
});
