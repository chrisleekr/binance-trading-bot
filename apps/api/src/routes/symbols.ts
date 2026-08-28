import {
  asProfileId,
  ErrorEnvelope,
  ProfileSymbolList,
  ProfileSymbolResponse,
  SymbolCreate,
  SymbolPatch,
  type SymbolSource,
  isSymbolPermittedForAccount,
  parseAccountPermissions,
} from '@app/contracts';
import { accountPermissionsKey, projections, repo } from '@app/db';
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
  pinned: boolean;
  pinnedAt: Date | null;
}): z.infer<typeof ProfileSymbolResponse> => ({
  symbol: row.symbol,
  overrideConfig: row.overrideConfig ?? null,
  source: row.source,
  pinned: row.pinned,
  pinnedAt: row.pinnedAt?.toISOString() ?? null,
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
      description: 'returned to discovery (pin cleared; provenance unchanged)',
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
    // picker filters on, so the API enforces what the UI already does.
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
    // TRADING is not the same as tradable BY THIS ACCOUNT. Binance also gates
    // each symbol on permission tags, and an account that lacks them has every
    // order refused -2010 forever, which the tick re-derives and re-sends until
    // the account's request-weight budget is gone. Reject the bind instead, so
    // the operator learns it here rather than from a stalled profile.
    //
    // Only checked for a live account: the listing above is live-pinned, and a
    // testnet key pair's tags are not comparable with a live symbol's sets.
    // Fails open on an unreadable or empty permission cache, matching the
    // worker's pre-flight: a signal that cannot be read is never a refusal. A
    // FAILING read degrades the same way as an absent key, so a Redis fault
    // costs the operator this check rather than the whole bind.
    if (binanceMode === 'live') {
      const accountPermissions = parseAccountPermissions(
        await di.redis
          .raw()
          .get(accountPermissionsKey(accountId))
          .catch((err: unknown) => {
            di.logger.warn(
              { accountId, err: err },
              'symbols: account-permissions read failed; tradability check skipped',
            );
            return null;
          }),
      );
      if (
        !isSymbolPermittedForAccount({ permissionSets: listed.permissionSets, accountPermissions })
      ) {
        throw new HttpError(
          'VALIDATION_FAILED',
          `your Binance account is not permitted to trade ${body.symbol}: it requires ${listed.permissionSets
            ?.map((s) => s.join(' or '))
            .join(' and ')}, and your API key pair has ${accountPermissions.join(', ')}`,
        );
      }
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
    // The manual-add path combines "add a coin I already hold" with a cost basis. A cost basis only
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
    // The operator chose this coin, so both facts are written explicitly rather than left to a column default: `manual` provenance, and a pin so discovery cannot rotate it away. Stamped now, which distinguishes it from a pin the rollout backfilled and could not date.
    const row = await p.profileSymbols.upsert(body.symbol, listed.baseAsset, {
      overrideConfig: null,
      source: 'manual',
      pinned: true,
      pinnedAt: new Date(),
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
      // managed immediately. The reconfigure revive alone only converges
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
      // must not block per-symbol overrides on an existing profile. Only a
      // genuinely-unregistered name fails.
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
    // The CREATE branch of this route is an operator authoring a binding by writing an override to a symbol they had not bound yet, so it stamps provenance and a pin exactly as the POST does. Omitting them would leave the new row rotatable, and discovery would eventually delete the operator's own override along with the symbol's condition rows and strategy state. On an EXISTING row both fields are left absent so `upsert`'s conditional spread cannot disturb provenance or a pin the operator has since released.
    const row = await p.profileSymbols.upsert(symbol, baseAsset, {
      overrideConfig: body.overrideConfig ?? null,
      ...(existing ? {} : { source: 'manual' as const, pinned: true, pinnedAt: new Date() }),
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

  // Full-wipe DELETE removes all per-symbol traces:
  //   1. Drop every Redis key under tenant:<u>:profile:<p>:*<symbol>*
  //   2. Detach the symbol, which tears down its DB state in one transaction:
  //      condition_states, symbol_states (so a re-add cold-loads fresh from
  //      initialState instead of reviving a stale position), avg_entry_prices
  //      and the pending override_actions.
  // Only the Redis half is the route's own work: the DB half belongs to the
  // binding and every unbind path inherits it, which is why there is nothing
  // here to keep in step with the discovery reap.
  // Archive rows + historical orders survive intentionally. A processing
  // override_action (a worker mid-side-effect) survives the detach by design,
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

  // Pin protects a symbol from the discovery cron's reap. A deliberate operator "keep this coin" action, idempotent on an already-pinned symbol. It leaves `source` alone: pinning a coin discovery rotated in does not make the operator its author, and the archive's provenance column would start lying if it did. No worker resync needed — the pin is discovery metadata, not strategy config, so the tick is unchanged.
  app.openapi(pinSymbolRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const profileId = asProfileId(profileIdRaw);
    const p = await scopeOf(c, di, profileId);
    const row = await p.profileSymbols.setPinned(symbol, true, new Date());
    if (!row) throw new HttpError('NOT_FOUND', 'symbol');
    c.set('auditEvent', { event: 'pin-symbol', payload: { profileId, symbol } });
    return c.json(toSymbolResponse(row), 200);
  });

  // "Return to discovery": the inverse of pin — clear the protection so the discovery cron manages the symbol again (keeps it while it qualifies, reaps it when its move fades). Idempotent on an already-unpinned symbol. `source` is again untouched: the operator releasing a coin does not retroactively make discovery the one who added it.
  app.openapi(unpinSymbolRoute, async (c) => {
    const { profileId: profileIdRaw, symbol } = c.req.valid('param');
    const profileId = asProfileId(profileIdRaw);
    const p = await scopeOf(c, di, profileId);
    const row = await p.profileSymbols.setPinned(symbol, false, new Date());
    if (!row) throw new HttpError('NOT_FOUND', 'symbol');
    c.set('auditEvent', { event: 'unpin-symbol', payload: { profileId, symbol } });
    return c.json(toSymbolResponse(row), 200);
  });

  return app;
};
