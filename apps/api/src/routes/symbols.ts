import {
  asProfileId,
  ErrorEnvelope,
  ProfileSymbolList,
  ProfileSymbolResponse,
  SymbolCreate,
  SymbolPatch,
  SymbolReservePut,
  type SymbolSource,
} from '@app/contracts';
import { projections, repo } from '@app/db';
import { Decimal } from '@app/money';
import { mergeConfig } from '@app/strategy-core';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import {
  assertActionSupported,
  balanceQuantityForSymbol,
  enqueueApplyAvgEntryPrice,
} from 'lib/manual-orders.js';
import { assertOrderFeasibleForProfile, withDiagnostics } from 'lib/order-feasibility.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import { wipeSymbolRedis } from 'redis-helpers.js';
import { loadOrFetchExchangeInfo } from 'routes/exchange-info.js';
import { createReconfigureEnqueue } from '@app/core/queue';
import { requireOwnedProfile, scopeOf } from 'route-helpers.js';
import type { AnyStrategy } from '@app/strategy-core';
import { createApiHono, type ApiHono } from 'types.js';

// Cap on issue lines folded into a VALIDATION_FAILED message so a deeply
// malformed override does not produce an unbounded error string.
const MAX_OVERRIDE_ISSUES_SHOWN = 5;

/**
 * Validate a non-null per-symbol override before it is stored. Two checks:
 * the override is shape-valid against the strategy's `overrideConfigSchema`
 * (rejects unknown / profile-level keys, runs leaf refinements), and the
 * *effective* config — the override deep-merged onto the profile config —
 * is valid against the full `configSchema` (this is where cross-field
 * refinements such as the grid ordering rule are enforced). Throws
 * `VALIDATION_FAILED` with the first few issue paths on either failure.
 */
const validateOverride = (plugin: AnyStrategy, profileConfig: unknown, override: unknown): void => {
  const fail = (error: z.ZodError): never => {
    const { issues } = error;
    const shown = issues
      .slice(0, MAX_OVERRIDE_ISSUES_SHOWN)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    const overflow = issues.length - shown.length;
    const detail = shown.join('; ') + (overflow > 0 ? `; …and ${overflow} more` : '');
    throw new HttpError('VALIDATION_FAILED', `invalid symbol override — ${detail}`, issues);
  };
  const shape = plugin.overrideConfigSchema.safeParse(override);
  if (!shape.success) fail(shape.error);
  const merged = plugin.configSchema.safeParse(mergeConfig(profileConfig, override));
  if (!merged.success) fail(merged.error);
};

const ProfileIdParam = z.object({ profileId: z.uuid() });
const ProfileSymbolParam = z.object({
  profileId: z.uuid(),
  symbol: z.string().min(1).max(32),
});

// Project a stored symbol row onto the wire shape. `overrideConfig` null-coalesces
// (null = inherit profile defaults); shared by every handler that returns a symbol.
const toSymbolResponse = (row: {
  symbol: string;
  overrideConfig: unknown;
  source: SymbolSource;
  reserveBaseQuantity: string | null;
}): z.infer<typeof ProfileSymbolResponse> => ({
  symbol: row.symbol,
  overrideConfig: row.overrideConfig ?? null,
  source: row.source,
  reserveBaseQuantity: row.reserveBaseQuantity ?? null,
});

const listRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/symbols',
  tags: ['symbols'],
  request: { params: ProfileIdParam },
  responses: {
    200: { description: 'symbols', content: { 'application/json': { schema: ProfileSymbolList } } },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const getSymbolRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/symbols/{symbol}',
  tags: ['symbols'],
  request: { params: ProfileSymbolParam },
  responses: {
    200: {
      description: 'symbol',
      content: { 'application/json': { schema: ProfileSymbolResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const createSymbolRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/symbols',
  tags: ['symbols'],
  request: {
    params: ProfileIdParam,
    body: { content: { 'application/json': { schema: SymbolCreate } } },
  },
  responses: {
    201: {
      description: 'added',
      content: { 'application/json': { schema: ProfileSymbolResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    409: {
      description: 'symbol already managed by another profile on this account',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    422: {
      description: 'symbol not tradable on Binance',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

const patchSymbolRoute = createRoute({
  method: 'patch',
  path: '/profiles/{profileId}/symbols/{symbol}',
  tags: ['symbols'],
  request: {
    params: ProfileSymbolParam,
    body: { content: { 'application/json': { schema: SymbolPatch } } },
  },
  responses: {
    200: {
      description: 'updated',
      content: { 'application/json': { schema: ProfileSymbolResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const putReserveRoute = createRoute({
  method: 'put',
  path: '/profiles/{profileId}/symbols/{symbol}/reserve',
  tags: ['symbols'],
  request: {
    params: ProfileSymbolParam,
    body: { content: { 'application/json': { schema: SymbolReservePut } } },
  },
  responses: {
    200: {
      description: 'reserve set',
      content: { 'application/json': { schema: ProfileSymbolResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    422: {
      description: 'reserve exceeds the live base-asset holding',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    502: {
      description: 'no live balance snapshot to validate the reserve against',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

const deleteSymbolRoute = createRoute({
  method: 'delete',
  path: '/profiles/{profileId}/symbols/{symbol}',
  tags: ['symbols'],
  request: { params: ProfileSymbolParam },
  responses: {
    204: { description: 'wiped' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const pinSymbolRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/symbols/{symbol}/pin',
  tags: ['symbols'],
  request: { params: ProfileSymbolParam },
  responses: {
    200: {
      description: 'pinned',
      content: { 'application/json': { schema: ProfileSymbolResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const unpinSymbolRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/symbols/{symbol}/unpin',
  tags: ['symbols'],
  request: { params: ProfileSymbolParam },
  responses: {
    200: {
      description: 'returned to discovery (source set to auto)',
      content: { 'application/json': { schema: ProfileSymbolResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

export const symbolsRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles/*/symbols', requireUser());
  app.use('/profiles/*/symbols/*', requireUser());

  app.openapi(listRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const p = await scopeOf(c, di, profileId);
    const rows = await p.profileSymbols.listForProfile();
    return c.json(rows.map(toSymbolResponse), 200);
  });

  app.openapi(getSymbolRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const profileId = asProfileId(profileIdRaw);
    const p = await scopeOf(c, di, profileId);
    const row = await p.profileSymbols.findForSymbol(symbol);
    if (!row) throw new HttpError('NOT_FOUND', 'symbol');
    return c.json(toSymbolResponse(row), 200);
  });

  app.openapi(createSymbolRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const body = c.req.valid('json');
    const { p, profile } = await requireOwnedProfile(c, di, profileId);
    const { operatorId, accountId } = p.scope;
    // Reject a pair that does not exist (or is not TRADING) on Binance: an
    // accepted dead binding can never trade and DLQs the worker tick at
    // loadSymbolInfo. Validate against the same exchangeInfo cache the symbol
    // picker filters on, so the API enforces what the UI already does (#365).
    // The LISTING check stays on `live` deliberately: the symbol picker feeding
    // it is `GET /exchange-info`, which is operator-global and live-pinned, so
    // mode-scoping only this side would 422 a testnet operator on a pair they
    // just picked from the list. Aligning them means making the picker
    // account-scoped, which is a route + SPA change, not this one. The FILTER
    // read below is mode-scoped regardless — that is the actual defect, since
    // testnet's tickSize / lot / minNotional differ from production.
    const binanceMode = (await repo.accounts.binanceModeById(di.db, accountId)) ?? 'test';
    const exchange = await loadOrFetchExchangeInfo(di.redis.raw(), 'live');
    const listed = exchange.symbols.find((s) => s.symbol === body.symbol);
    if (listed === undefined || listed.status !== 'TRADING') {
      throw new HttpError('VALIDATION_FAILED', `symbol not tradable on Binance: ${body.symbol}`);
    }
    // Reject binding a symbol the profile's current config cannot trade — orders
    // that size below this symbol's exchange minimum, or a grid the balance can't
    // fund — before the bind is written, so an unfundable symbol never reaches
    // the worker tick.
    const saveDiagnostics = await assertOrderFeasibleForProfile(
      di,
      p,
      profile,
      profile.config,
      binanceMode,
      // A price is cached only while some profile is tracking the symbol, so a
      // pair nothing trades yet usually has none and its sizing check is
      // skipped. Report that here, unlike the other mutation boundaries: on the
      // one route dedicated to validating a new symbol, silence would claim a
      // check that did not run.
      { symbols: [body.symbol], fundFromAccountValue: true, reportMissingPrice: true },
    );
    // #496 combined "add a coin I already hold + cost basis". A cost basis only
    // means something to a strategy that manages a single position per symbol,
    // so gate it the same way the dedicated avg-entry-price route does — a
    // momentum/rebalance profile 422s here instead of silently seeding a ledger
    // row its strategy ignores. Gate before any write so an unsupported add is
    // rejected whole.
    if (body.avgEntryPrice !== undefined) {
      await assertActionSupported(di, p, 'avg-entry-price');
    }
    // Resolve the held quantity to size the cost-basis ledger BEFORE binding the
    // symbol, so a cold profile (no wallet snapshot, no ledger) fails fast with
    // 502 instead of leaving a half-added symbol behind. Omitted field → fresh add.
    const entryQuantity =
      body.avgEntryPrice !== undefined
        ? await balanceQuantityForSymbol(di, p, body.symbol)
        : undefined;
    const row = await p.profileSymbols.upsert(body.symbol, listed.baseAsset, {
      overrideConfig: null,
    });
    if (body.avgEntryPrice !== undefined && entryQuantity !== undefined) {
      await p.avgEntryPrices.upsert(body.symbol, {
        avgEntryPrice: body.avgEntryPrice,
        quantity: entryQuantity,
      });
    }
    // Bust the cached dashboard so the new symbol shows on the next read
    // instead of waiting out the projection's TTL.
    await projections.invalidateProfileDashboard(p.scope, di.redis.raw());
    // Resync the worker's in-memory profile snapshot so the new symbol is
    // ticked and gets technicals computed without a reboot. ProfileManager
    // reads symbols only at enable-time otherwise; a disabled profile needs
    // no signal (the next start re-reads symbols fresh from the DB).
    if (profile.enabled) {
      await createReconfigureEnqueue(di.queue)({ userId: operatorId, accountId, profileId });
      // Force-set the running strategy's cost basis so the held position is
      // managed immediately (#496). The reconfigure revive alone only converges
      // a brand-new symbol; the force-set is also correct for a re-add of a
      // symbol that already carries a position.
      if (body.avgEntryPrice !== undefined) {
        await enqueueApplyAvgEntryPrice(di, p, body.symbol);
      }
    }
    c.set('auditEvent', {
      event: 'add-symbol',
      payload: {
        profileId,
        symbol: body.symbol,
        ...(body.avgEntryPrice !== undefined && { avgEntryPrice: body.avgEntryPrice }),
      },
    });
    return c.json(withDiagnostics(toSymbolResponse(row), saveDiagnostics), 201);
  });

  app.openapi(patchSymbolRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const profileId = asProfileId(profileIdRaw);
    const body = c.req.valid('json');
    const { p, profile } = await requireOwnedProfile(c, di, profileId);
    const { operatorId, accountId } = p.scope;
    // A non-null override is validated against the profile's strategy
    // before it is stored: a partial config that produces an invalid
    // effective config must fail here, not silently corrupt the worker's
    // tick. A null override (reset to profile config) needs no validation.
    if (body.overrideConfig != null) {
      // Validate against the LIVE plugin's schema; a bumped strategy version
      // must not block per-symbol overrides on an existing profile (issue
      // #407). Only a genuinely-unregistered name fails.
      const resolved = di.strategies.describeForProfile(
        profile.strategyName,
        profile.strategyVersion,
      );
      if (resolved.status === 'unknown')
        throw new HttpError('VALIDATION_FAILED', 'strategy not registered for profile');
      validateOverride(resolved.strategy, profile.config, body.overrideConfig);
    }
    // Reuse the bound row's base asset on an override edit; fall back to
    // exchangeInfo on the rare patch of a not-yet-bound symbol (upsert creates
    // it). The exclusivity guard re-runs inside upsert either way.
    const existing = await p.profileSymbols.findForSymbol(symbol);
    let baseAsset = existing?.baseAsset;
    if (baseAsset === undefined) {
      const exchange = await loadOrFetchExchangeInfo(di.redis.raw(), 'live');
      const listed = exchange.symbols.find((s) => s.symbol === symbol);
      if (listed === undefined) {
        throw new HttpError('VALIDATION_FAILED', `symbol not listed on Binance: ${symbol}`);
      }
      baseAsset = listed.baseAsset;
    }
    const row = await p.profileSymbols.upsert(symbol, baseAsset, {
      overrideConfig: body.overrideConfig ?? null,
    });
    // Resync the worker so the edited per-symbol override is visible on the
    // next tick. The worker caches the resolved tick context across ticks
    // (config + merged override); the reconfigure job evicts that cache, so
    // without this signal the new override would not apply until the cache
    // TTL elapses. A disabled profile is not ticking, so no signal is needed.
    if (profile.enabled) {
      await createReconfigureEnqueue(di.queue)({ userId: operatorId, accountId, profileId });
    }
    c.set('auditEvent', {
      event: body.overrideConfig == null ? 'reset-symbol-config' : 'set-symbol-config',
      payload: { profileId, symbol },
    });
    return c.json(toSymbolResponse(row), 200);
  });

  // Set (or clear) the per-symbol reserve floor — the base-asset quantity the
  // bot must never sell below. Dedicated endpoint so writing the reserve never
  // disturbs the stored override (and vice versa). A positive reserve is
  // rejected when it exceeds the live base-asset holding: the reserve is "a
  // slice of what you already hold", and allowing more would let the bot buy
  // through the floor with quote cash. Holding is read from the cached wallet
  // snapshot (ledger fallback) — never a live Binance call from the API.
  app.openapi(putReserveRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const profileId = asProfileId(profileIdRaw);
    const { reserveBaseQuantity: reserve } = c.req.valid('json');
    const { p, profile } = await requireOwnedProfile(c, di, profileId);
    const { operatorId, accountId } = p.scope;
    // Resolve attachment first so an unattached symbol always 404s regardless of
    // the amount — the holding check below would otherwise mask it with a 422 or
    // 502 for a positive reserve on a symbol the profile never added.
    if ((await p.profileSymbols.findForSymbol(symbol)) === null) {
      throw new HttpError('NOT_FOUND', 'symbol');
    }
    if (reserve !== null && new Decimal(reserve).gt(0)) {
      // A cold profile with neither a wallet snapshot nor a ledger row throws
      // UPSTREAM_FAILED (502) here with a message telling the operator to enable
      // the profile first, so the bot can read the balance.
      const holding = await balanceQuantityForSymbol(di, p, symbol);
      if (new Decimal(reserve).gt(new Decimal(holding))) {
        throw new HttpError(
          'VALIDATION_FAILED',
          `reserve ${reserve} exceeds your ${symbol} holding of ${holding} — reserve at most what you already hold`,
        );
      }
    }
    const row = await p.profileSymbols.setReserve(symbol, reserve);
    if (!row) throw new HttpError('NOT_FOUND', 'symbol');
    // Resync the worker so the new reserve applies on the next tick: the tick
    // context carries the reserve and is cached across ticks; the reconfigure
    // job evicts that cache. A disabled profile is not ticking.
    if (profile.enabled) {
      await createReconfigureEnqueue(di.queue)({ userId: operatorId, accountId, profileId });
    }
    c.set('auditEvent', {
      event: reserve === null ? 'clear-symbol-reserve' : 'set-symbol-reserve',
      payload: { profileId, symbol, reserveBaseQuantity: reserve },
    });
    return c.json(toSymbolResponse(row), 200);
  });

  // Full-wipe DELETE removes all per-symbol traces:
  //   1. Drop every Redis key under tenant:<u>:profile:<p>:*<symbol>*
  //   2. Delete avg_entry_prices row
  //   3. Delete symbol_states row (durable strategy body) so a re-add cold-loads
  //      fresh from initialState instead of reviving a stale position
  //   4. Remove pending override_actions for the symbol
  //   5. Detach symbol from profile
  // Archive rows + historical orders survive intentionally. A processing
  // override_action (a worker mid-side-effect) survives step 3 by design,
  // but step 1 still drops its override:<symbol> cache key — a symbol wipe
  // is a wholesale teardown, unlike an override cancel which preserves the
  // cache for an in-flight row. The lingering DB row is resolved by the
  // worker's finalize/reaper path.
  app.openapi(deleteSymbolRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const profileId = asProfileId(profileIdRaw);
    const { p, profile } = await requireOwnedProfile(c, di, profileId);
    const { operatorId, accountId } = p.scope;
    await wipeSymbolRedis(di.redis, accountId, profileId, symbol);
    await p.avgEntryPrices.remove(symbol);
    await p.symbolStates.remove(symbol);
    await p.overrideActions.deletePendingForSymbol(symbol);
    await p.profileSymbols.remove(symbol);
    // `wipeSymbolRedis` only drops keys carrying the symbol name; the dashboard
    // cache key has no symbol, so bust it explicitly or the removed symbol
    // lingers in the list until the TTL.
    await projections.invalidateProfileDashboard(p.scope, di.redis.raw());
    // Resync the worker so it stops ticking the removed symbol and releases
    // its market subscription (ref-counted in ProfileManager). Disabled
    // profiles hold no in-memory snapshot, so no signal is needed.
    if (profile.enabled) {
      await createReconfigureEnqueue(di.queue)({ userId: operatorId, accountId, profileId });
    }
    return new Response(null, { status: 204 });
  });

  // Pin flips a discovery-rotated symbol (source='auto') to 'manual' so the
  // discovery cron stops reaping it. A deliberate operator "keep this coin"
  // action. Idempotent on an already-manual symbol. No worker resync needed:
  // source is discovery metadata, not strategy config — the tick is unchanged.
  app.openapi(pinSymbolRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const profileId = asProfileId(profileIdRaw);
    const p = await scopeOf(c, di, profileId);
    const row = await p.profileSymbols.setSource(symbol, 'manual');
    if (!row) throw new HttpError('NOT_FOUND', 'symbol');
    c.set('auditEvent', { event: 'pin-symbol', payload: { profileId, symbol } });
    return c.json(toSymbolResponse(row), 200);
  });

  // "Return to discovery": the inverse of pin — flip a manual symbol back to
  // `source='auto'` so the discovery cron manages it again (keeps it while it
  // qualifies, reaps it when its move fades). Idempotent on an already-auto
  // symbol. Like pin, source is discovery metadata, not strategy config, so no
  // worker resync is needed.
  app.openapi(unpinSymbolRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const profileId = asProfileId(profileIdRaw);
    const p = await scopeOf(c, di, profileId);
    const row = await p.profileSymbols.setSource(symbol, 'auto');
    if (!row) throw new HttpError('NOT_FOUND', 'symbol');
    c.set('auditEvent', { event: 'unpin-symbol', payload: { profileId, symbol } });
    return c.json(toSymbolResponse(row), 200);
  });

  return app;
};
