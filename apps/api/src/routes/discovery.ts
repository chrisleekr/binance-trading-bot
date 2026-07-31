import {
  AccountInfoSnapshot,
  asProfileId,
  ClosedTradesQuery,
  type DecimalString,
  decimalMul,
  type DiscoveryActivityEntry,
  DiscoveryConfigSchema,
  DiscoveryDashboardResponse,
  type DiscoveryHolding,
  DiscoveryScoreboardResponse,
  DiscoveryUniverse,
  type EntryBlockerResponse,
  ErrorEnvelope,
  readAccountExposureCap,
  unwrapId,
} from '@app/contracts';
import { Decimal } from '@app/money';
import { GLOBAL_KEYS, profileKey, projections, repo, type ProfileRepo } from '@app/db';
import type { Logger } from 'pino';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { periodWindow } from 'lib/period-window.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import { requireOwnedProfile, scopeOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

const DAY_MS = 86_400_000;
// Recent action-log rows scanned for discovery events, and the max surfaced.
const ACTIVITY_SCAN = 200;
const ACTIVITY_MAX = 20;

const ProfileIdParam = z.object({ profileId: z.uuid() });

/** Project recent action-log rows to the discovery activity feed (adds/removes only). */
const toActivity = (
  rows: readonly { time: Date; symbol: string | null; msg: string; ctx: unknown }[],
): DiscoveryActivityEntry[] => {
  const out: DiscoveryActivityEntry[] = [];
  for (const r of rows) {
    const ctx = r.ctx as { source?: unknown; action?: unknown } | null;
    if (!ctx || ctx.source !== 'auto' || r.symbol === null) continue;
    if (ctx.action !== 'add' && ctx.action !== 'remove') continue;
    out.push({ time: r.time.toISOString(), symbol: r.symbol, action: ctx.action, msg: r.msg });
    if (out.length >= ACTIVITY_MAX) break;
  }
  return out;
};

/** Parse the cron-persisted universe snapshot; a malformed/absent value yields
 *  null. A present-but-unparseable value is logged (not silently swallowed): it
 *  signals a worker→api payload drift that would otherwise null the dashboard
 *  universe forever with no trace (invariant #2). */
const readUniverse = (raw: string | null, logger: Logger): DiscoveryUniverse | null => {
  if (!raw) return null;
  try {
    return DiscoveryUniverse.parse(JSON.parse(raw));
  } catch (err) {
    logger.warn(
      { err: err },
      'discovery universe snapshot failed to parse — dashboard universe shown empty',
    );
    return null; // stale/corrupt snapshot must not break the dashboard
  }
};

/**
 * Cost-basis rows for the auto symbols that currently hold a position, so the
 * dashboard can distinguish "holding" from "subscribed-but-waiting-for-entry".
 * A symbol with no cost-basis row (or zero quantity) is flat and omitted. The
 * deployed cost basis (`avgEntryPrice × quantity`) is computed here so the
 * web boundary never does money math on `number`.
 */
const buildHoldings = async (
  p: ProfileRepo,
  autoSymbols: readonly string[],
): Promise<DiscoveryHolding[]> => {
  const rows = await p.avgEntryPrices.findBySymbols(autoSymbols);
  const out: DiscoveryHolding[] = [];
  for (const r of rows) {
    if (!(Number(r.quantity) > 0)) continue;
    out.push({
      symbol: r.symbol,
      quantity: r.quantity as DecimalString,
      avgEntryPrice: r.avgEntryPrice as DecimalString,
      quoteCostBasis: decimalMul(r.avgEntryPrice, r.quantity),
    });
  }
  return out;
};

/**
 * Per-symbol entry-blocker map for the auto symbols, read from persisted
 * strategy state in one batch query. A symbol whose state omits a blocker (or
 * has none) is absent from the map, so the universe enrichment reads it as null.
 */
const buildEntryBlockers = async (
  p: ProfileRepo,
  autoSymbols: readonly string[],
): Promise<Map<string, EntryBlockerResponse>> => {
  const rows = await p.symbolStates.findBySymbols(autoSymbols);
  const out = new Map<string, EntryBlockerResponse>();
  for (const r of rows) {
    const blocker = projections.readEntryBlocker(r.state);
    if (blocker) out.set(r.symbol, blocker);
  }
  return out;
};

/**
 * Free + locked quote-asset cash from the worker's account-info cache, for the
 * exposure-gauge equity figure. Degrades to 0 when the snapshot is absent or
 * malformed — the gauge is informational, so it must not 500 the dashboard.
 */
const readQuoteCash = async (di: DI, p: ProfileRepo, quoteAsset: string): Promise<Decimal> => {
  const raw = await di.redis.raw().get(profileKey(p.scope, 'accountInfo'));
  if (!raw) return new Decimal(0);
  try {
    const info = AccountInfoSnapshot.parse(JSON.parse(raw));
    const bal = info.balances[quoteAsset];
    return bal ? new Decimal(bal.free).add(bal.locked) : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
};

/**
 * Resolve the account-wide exposure cap to a quote ceiling for the dashboard
 * gauge. An `amount` cap is the amount; a `percent` cap is `pct × equity`
 * (equity = quote cash + deployed cost-basis); off/absent → null. The strategy
 * resolves the same percent against live equity at tick time (the enforcing
 * site); this mirrors it for display. The worker/api cannot import the strategy
 * package, so the cap is duck-read via `readAccountExposureCap`.
 */
const resolveGaugeCap = (config: unknown, equity: Decimal): DecimalString | null => {
  const cap = readAccountExposureCap(config);
  if (cap.mode === 'amount') return cap.amount as DecimalString;
  if (cap.mode === 'percent' && cap.percent !== null) {
    return new Decimal(cap.percent).mul(equity).toString() as DecimalString;
  }
  return null;
};

/** Compute the discovery operator-dashboard payload for a resolved profile. */
const buildDashboard = async (
  di: DI,
  p: ProfileRepo,
  profile: { config: unknown; discoveryConfig?: unknown; quoteAsset: string },
): Promise<DiscoveryDashboardResponse> => {
  // A stored config that fails validation (e.g. an out-of-band DB edit wrote an
  // out-of-range value) must not 500 the whole dashboard. Fall back to safe
  // defaults with enabled:false — mirroring the cron, which also treats an
  // unparseable config as disabled — and flag it so the UI can warn. Logged at
  // WARN, never silently swallowed (invariant #2).
  const parsedConfig = DiscoveryConfigSchema.safeParse(profile.discoveryConfig ?? {});
  const configInvalid = !parsedConfig.success;
  let config: DiscoveryDashboardResponse['config'];
  if (parsedConfig.success) {
    config = parsedConfig.data;
  } else {
    // Log only the structural locator (which field, what kind of error), never
    // the raw issue objects — robust against a future zod default that echoes
    // the rejected input into the issue, which would land stored values in logs.
    di.logger.warn(
      {
        profileId: unwrapId(p.scope.profileId),
        issuePaths: parsedConfig.error.issues.map((i) => ({
          path: i.path.join('.'),
          code: i.code,
        })),
      },
      'stored discovery_config failed validation — dashboard shows safe defaults until re-saved',
    );
    // enabled:false is explicit (the schema default happens to match) to make the
    // paused posture obvious and decouple it from the default.
    config = { ...DiscoveryConfigSchema.parse({}), enabled: false };
  }
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
  const epoch = new Date(0);
  const [all, last7, deployed, symbols, logs, rawExplain, quoteCash] = await Promise.all([
    p.tradeArchive.sumProfitInRangeForSource(epoch, now, 'auto'),
    p.tradeArchive.sumProfitInRangeForSource(sevenDaysAgo, now, 'auto'),
    // Scoped to this profile's mode + quote asset so the gauge's equity matches
    // what the strategy enforces at tick time (a live profile's gauge must not
    // count test-mode practice positions or a different quote unit).
    repo.avgEntryPrices.sumDeployedQuoteForAccount(di.db, p.scope.accountId, profile.quoteAsset),
    p.profileSymbols.listForProfile(),
    p.actionLogs.listRecent(ACTIVITY_SCAN),
    di.redis.raw().get(GLOBAL_KEYS.discoveryExplain(unwrapId(p.scope.profileId))),
    readQuoteCash(di, p, profile.quoteAsset),
  ]);
  // Account equity for resolving a percent exposure cap: quote cash + deployed
  // cost-basis (mirrors the strategy's tick-time equity).
  const equity = quoteCash.add(new Decimal(deployed));
  const autoSymbols = symbols.filter((s) => s.source === 'auto').map((s) => s.symbol);
  const [holdings, entryBlockers] = await Promise.all([
    buildHoldings(p, autoSymbols),
    buildEntryBlockers(p, autoSymbols),
  ]);
  const autoSet = new Set(autoSymbols);
  // The Redis snapshot the cron writes has every candidate's entryBlocker null
  // (it predates per-symbol state); enrich auto candidates from live state here
  // so the dashboard glosses why a held auto pick isn't entering. Non-auto rows
  // stay null — discovery doesn't manage their entry.
  const parsedUniverse = readUniverse(rawExplain, di.logger);
  const universe = parsedUniverse
    ? {
        ...parsedUniverse,
        candidates: parsedUniverse.candidates.map((c) => ({
          ...c,
          entryBlocker: autoSet.has(c.symbol) ? (entryBlockers.get(c.symbol) ?? null) : null,
        })),
      }
    : null;
  return {
    config,
    configInvalid,
    quoteAsset: profile.quoteAsset,
    scoreboard: {
      realizedProfit: all.totalProfit as DecimalString,
      realizedProfitPercent: all.totalProfitPercent as DecimalString,
      totalFees: all.totalFees as DecimalString,
      netProfit: all.netProfit as DecimalString,
      tradeCount: all.tradeCount,
      winRate: all.tradeCount > 0 ? all.wins / all.tradeCount : 0,
      realizedProfit7d: last7.totalProfit as DecimalString,
      netProfit7d: last7.netProfit as DecimalString,
      tradeCount7d: last7.tradeCount,
    },
    gauge: {
      deployedQuote: deployed as DecimalString,
      maxAccountExposureQuote: resolveGaugeCap(profile.config, equity),
      autoSymbolCount: autoSymbols.length,
    },
    universe,
    holdings,
    autoSymbols,
    activity: toActivity(logs),
  };
};

const getRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/discovery',
  tags: ['discovery'],
  request: { params: ProfileIdParam },
  responses: {
    200: {
      description: 'discovery dashboard',
      content: { 'application/json': { schema: DiscoveryDashboardResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/profiles/{profileId}/discovery-config',
  tags: ['discovery'],
  request: {
    params: ProfileIdParam,
    body: { content: { 'application/json': { schema: DiscoveryConfigSchema } } },
  },
  responses: {
    200: {
      description: 'updated',
      content: { 'application/json': { schema: DiscoveryDashboardResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

// Period-ranged discovery scoreboard for the Home KPI strip's D/W/M/All toggle
// (#504). Only the trade-archive aggregates are time-rangeable; the gauge cards
// (deployed cost, exposure cap, holdings) are "now" values served by the full
// dashboard endpoint, so this stays a small, separate query rather than
// re-fetching the whole dashboard (universe + activity) on every toggle.
const scoreboardRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/discovery-scoreboard',
  tags: ['discovery'],
  request: { params: ProfileIdParam, query: ClosedTradesQuery },
  responses: {
    200: {
      description: 'period-ranged discovery scoreboard',
      content: { 'application/json': { schema: DiscoveryScoreboardResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

export const discoveryRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles/*/discovery', requireUser());
  app.use('/profiles/*/discovery-config', requireUser());
  app.use('/profiles/*/discovery-scoreboard', requireUser());

  app.openapi(getRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { p, profile } = await requireOwnedProfile(c, di, profileId);
    return c.json(await buildDashboard(di, p, profile), 200);
  });

  app.openapi(scoreboardRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { period, tz } = c.req.valid('query');
    const { from, to } = periodWindow(period, tz, new Date());
    const p = await scopeOf(c, di, profileId);
    // One grouped pass yields every source's slice; the top-level fields stay
    // attributed to `auto` (discovery) so the existing strip cells are unchanged,
    // and the by-source band reads the whole array.
    const ranged = await p.tradeArchive.sumProfitInRangeBySource(from, to);
    const auto = ranged.find((r) => r.source === 'auto');
    return c.json(
      {
        period,
        tz,
        from: from.toISOString(),
        to: to.toISOString(),
        realizedProfit: (auto?.totalProfit ?? '0') as DecimalString,
        realizedProfitPercent: (auto?.totalProfitPercent ?? '0') as DecimalString,
        totalFees: (auto?.totalFees ?? '0') as DecimalString,
        netProfit: (auto?.netProfit ?? '0') as DecimalString,
        tradeCount: auto?.tradeCount ?? 0,
        winRate: auto && auto.tradeCount > 0 ? auto.wins / auto.tradeCount : 0,
        bySource: ranged.map((r) => ({
          source: r.source,
          realizedProfit: r.totalProfit as DecimalString,
          totalFees: r.totalFees as DecimalString,
          netProfit: r.netProfit as DecimalString,
          tradeCount: r.tradeCount,
          wins: r.wins,
          losses: r.losses,
          grossProfit: r.grossProfit as DecimalString,
          grossLoss: r.grossLoss as DecimalString,
        })),
      },
      200,
    );
  });

  // Writing the discovery config needs no worker resync: the cron reads the
  // `discovery_config` column directly each tick. Pausing (enabled:false) and
  // editing the blocklist both flow through here.
  app.openapi(patchRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const body = c.req.valid('json');
    const p = await scopeOf(c, di, profileId);
    const updated = await p.profile.setDiscoveryConfig(body);
    if (!updated) throw new HttpError('NOT_FOUND', 'profile');
    c.set('auditEvent', { event: 'set-discovery-config', payload: { profileId } });
    return c.json(await buildDashboard(di, p, updated), 200);
  });

  return app;
};
