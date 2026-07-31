import {
  type AccountId,
  AdoptOrphanRequestSchema,
  AdoptOrphanResponseSchema,
  asProfileId,
  isRestingSell,
  ErrorEnvelope,
  OrphanOrdersResponseSchema,
  OrphanSnapshotSchema,
  unwrapId,
  type OrphanOrderView,
  type OrphanSnapshot,
} from '@app/contracts';
import { createReconfigureEnqueue } from '@app/core/queue';
import { GLOBAL_KEYS, ORPHAN_SNAPSHOT_TTL_S, repo } from '@app/db';
import { createRoute } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import { accountScopeOf, requireOwnedProfile } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';
import { loadOrFetchExchangeInfo } from './exchange-info.js';

// An adopted order lands in the OWNING STRATEGY'S OWN SLOT, named by that
// strategy's `attributeOrder` — never a blanket `manual` intent.
//
// What makes adoption safe is the DESTINATION, not the row. A strategy reads its
// open orders from Binance, so it recognises its own clientOrderId and resumes
// managing the order. A FOREIGN strategy handed that same order cannot recognise
// it, cannot reprice or cancel it, and simply leaves the base asset locked while
// its own protective stop is refused for want of free balance on every tick,
// forever. The intent therefore just has to name the slot the true owner actually
// manages, so its next cancel/replace accounts for the row.

/**
 * Read one account's current orphan snapshot. Returns null on a cold cache
 * (cron has not run yet) or a malformed/blank payload — the route treats all
 * three as "no orphans known", never a 500.
 */
const readSnapshot = async (di: DI, accountId: AccountId): Promise<OrphanSnapshot | null> => {
  const raw = await di.redis.raw().get(GLOBAL_KEYS.orphanSnapshot(accountId));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const res = OrphanSnapshotSchema.safeParse(parsed);
  return res.success ? res.data : null;
};

/** One profile that PROVED it placed the order, plus the slot it manages it in. */
interface OrphanOwner {
  readonly id: string;
  readonly name: string;
  readonly intent: string;
}

/** A profile row as `profiles.listForAccount` returns it, narrowed to what attribution reads. */
interface AttributableProfile {
  readonly id: string;
  readonly name: string;
  readonly strategyName: string;
  readonly config: unknown;
}

/**
 * Every profile on the account whose STRATEGY proves it emitted this
 * clientOrderId for this symbol.
 *
 * Attribution is strategy-owned (the id scheme belongs to the plugin), so it is
 * reached only through the registry — `apps/api` never imports a strategy package
 * (core invariant #1). A strategy with no `attributeOrder`, or one whose stored
 * config no longer parses, simply cannot claim: it drops out of the search rather
 * than throwing, because failing to attribute is a refusal, never a 500.
 *
 * Mode gates the whole search: an orphan on the live account cannot belong to a
 * profile on testnet — they are different Binance accounts.
 */
const attributeOrphan = (
  di: DI,
  profiles: readonly AttributableProfile[],
  accountMode: string,
  orphan: { readonly clientOrderId: string; readonly symbol: string; readonly mode: string },
): OrphanOwner[] => {
  if (accountMode !== orphan.mode) return [];
  const owners: OrphanOwner[] = [];
  for (const pr of profiles) {
    const strategy = di.strategies.get(pr.strategyName);
    if (!strategy?.attributeOrder) continue;
    const parsed = strategy.configSchema.safeParse(pr.config);
    if (!parsed.success) continue;
    const match = strategy.attributeOrder({
      clientOrderId: orphan.clientOrderId,
      profileId: pr.id,
      symbol: orphan.symbol,
      config: parsed.data,
    });
    if (match) owners.push({ id: pr.id, name: pr.name, intent: match.intent });
  }
  return owners;
};

const getRoute = createRoute({
  method: 'get',
  path: '/orphan-orders',
  tags: ['orphan-orders'],
  responses: {
    200: {
      description: 'orphan orders + owning-profile hints',
      content: { 'application/json': { schema: OrphanOrdersResponseSchema } },
    },
  },
});

const adoptRoute = createRoute({
  method: 'post',
  path: '/orphan-orders/adopt',
  tags: ['orphan-orders'],
  request: {
    body: { content: { 'application/json': { schema: AdoptOrphanRequestSchema } } },
  },
  responses: {
    201: {
      description: 'adopted',
      content: { 'application/json': { schema: AdoptOrphanResponseSchema } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    409: { description: 'CONFLICT', content: { 'application/json': { schema: ErrorEnvelope } } },
    422: {
      description: 'VALIDATION_FAILED',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

export const orphanOrdersRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/orphan-orders', requireUser());
  app.use('/orphan-orders/*', requireUser());

  app.openapi(getRoute, async (c) => {
    const a = await accountScopeOf(c, di);
    const snapshot = await readSnapshot(di, a.scope.accountId);
    const [profiles, storedMode] = await Promise.all([
      a.profiles.listForAccount(),
      repo.accounts.binanceModeById(di.db, a.scope.accountId),
    ]);
    // binance_mode lives on the account now; every profile under it shares the
    // same environment, so an orphan on the other env matches no profile here.
    const accountMode = storedMode ?? 'test';

    // The snapshot key is already per account; the filter is the belt to that
    // brace. An orphan is only ever adoptable into a profile of the account whose
    // key pair found it, so serving another account's row here would be both a
    // leak and a dead pre-selection.
    const orphans: OrphanOrderView[] = (snapshot?.orphans ?? [])
      .filter((o) => o.accountId === unwrapId(a.scope.accountId))
      .map((o) => {
        // Exactly one claimant ⇒ that profile placed it and the page offers Adopt.
        // Zero (an order no strategy on this account can prove it emitted) or more
        // than one (ambiguous, never guess) ⇒ the page offers cancel-or-leave. The
        // adopt route re-derives this itself; it does not trust the client.
        const owners = attributeOrphan(di, profiles, accountMode, o);
        const owner = owners.length === 1 ? owners[0] : undefined;
        return {
          ...o,
          ownerProfileId: owner?.id ?? null,
          ownerProfileName: owner?.name ?? null,
        };
      });

    return c.json({ computedAtMs: snapshot?.computedAtMs ?? null, orphans }, 200);
  });

  app.openapi(adoptRoute, async (c) => {
    const { orderId, mode } = c.req.valid('json');

    // The account is the scope; the PROFILE is derived below, never supplied. An
    // operator cannot pick where a lost order goes, because the only safe
    // destination is the profile that placed it — and the clientOrderId already
    // says which one that is.
    const a = await accountScopeOf(c, di);
    const accountId = a.scope.accountId;

    // Adoption is valid only for an order still flagged as an orphan ON THIS
    // ACCOUNT. An order id is unique only within one Binance account, so matching
    // by id alone would happily adopt a sibling account's order into this profile
    // — a tracking row for an order that does not exist on this account's book.
    // A miss means the order was adopted or cancelled since the operator loaded
    // the list: 409 rather than insert a row for a vanished order.
    const snapshot = await readSnapshot(di, accountId);
    const orphan = snapshot?.orphans.find(
      (o) =>
        o.orderId === orderId &&
        o.mode === mode &&
        // Symmetric with the GET handler's filter: the snapshot key is already per
        // account, and this is the belt to that brace — on the handler that WRITES.
        o.accountId === unwrapId(accountId),
    );
    if (!orphan) throw new HttpError('CONFLICT', 'order is no longer an orphan');

    let binanceOrderId: bigint;
    try {
      binanceOrderId = BigInt(orderId);
    } catch {
      throw new HttpError('VALIDATION_FAILED', 'orderId is not an integer');
    }

    const accountMode = (await repo.accounts.binanceModeById(di.db, accountId)) ?? 'test';

    // Mode safety: an orphan on the live account cannot belong to a testnet
    // profile (or vice versa) — they are different Binance accounts, so the
    // tracking row would reference an order id that does not exist on the profile's
    // account and the reaper would immediately close it as stale. `attributeOrphan`
    // gates on this too; keep the explicit check so the operator gets the specific
    // reason rather than a generic "no profile placed this".
    if (accountMode !== orphan.mode) {
      throw new HttpError('CONFLICT', `order is on the ${orphan.mode} account, not this account's`);
    }

    // Derive the owner. Letting the operator choose is what produced the
    // production failure this gate exists for: trailing-trade's protective stops
    // were adopted into a MOMENTUM profile, which could not recognise, reprice, or
    // cancel them — so they rested on Binance locking the base asset while
    // momentum's own stop was refused -2010 on every tick for three days.
    const owners = attributeOrphan(di, await a.profiles.listForAccount(), accountMode, orphan);
    if (owners.length === 0) {
      // Nothing can adopt it. A RESTING SELL in this state is the worse case and
      // gets the specific message: it is holding the operator's coins, so the true
      // owner (whoever that is) cannot fund a protective stop for them and Binance
      // answers -2010 to every attempt, forever. Cancelling it on Binance frees the
      // base and lets the strategy protect the position itself.
      //
      // Note this refusal is scoped to the ZERO-claimant case ON PURPOSE. Adopting
      // a resting SELL into the profile that PLACED it is safe by construction (see
      // the single-owner path below), so a blanket refusal here would make an
      // orphaned protective stop — which IS a resting SELL — permanently
      // un-adoptable.
      if (isRestingSell(orphan)) {
        throw new HttpError(
          'CONFLICT',
          'This sell order is resting on Binance and is holding your coins, so the bot could not place its own protective stop for them. Cancel it on Binance first, then adopt the position.',
          { side: orphan.side, status: orphan.status, symbol: orphan.symbol },
        );
      }
      // Not a strategy order (or one whose id folds runtime data no strategy can
      // re-derive). There is nothing to adopt it INTO: leave it on Binance or
      // cancel it there. Adopting it "somewhere" is what caused the incident.
      throw new HttpError(
        'CONFLICT',
        'no profile on this account placed this order, so it cannot be adopted — cancel it on Binance or leave it alone',
      );
    }
    if (owners.length > 1) {
      throw new HttpError(
        'CONFLICT',
        `more than one profile claims this order (${owners.map((o) => o.name).join(', ')}) — refusing to guess`,
      );
    }
    // Exactly one claimant: the profile PROVED it emitted this clientOrderId. Adopt
    // it, resting SELL or not.
    //
    // A resting SELL is safe here by construction, under the same reasoning that
    // makes it unsafe anywhere else. The danger is a strategy that does not
    // recognise the order: it cannot reprice or cancel it, so the base stays locked
    // and its own stop is refused -2010 forever. The TRUE owner has none of that —
    // it matches its own deterministic id via `findRestingProtectiveStop`, so it
    // will not place a duplicate, and `findForeignRestingSell` does not flag it as
    // foreign precisely because the id IS its own. The base being locked by the
    // profile's OWN stop is not a fault; it is the correct protected state.
    const owner = owners[0]!;
    const profileId = asProfileId(owner.id);
    const adoptedIntent = owner.intent;

    // Re-prove ownership of the DERIVED profile through the scope layer (core
    // invariant #4): attribution says which profile placed the order, the scope
    // says the operator owns that profile.
    const { p, profile } = await requireOwnedProfile(c, di, profileId);
    const { operatorId } = p.scope;

    // Idempotency: refuse if a profile already tracks this exchange order live
    // (a double-submit, or the snapshot lagging a fresh adoption). Scoped to the
    // orphan's mode — a same-numbered id tracked on the OTHER account is a
    // different order and must not block this adopt.
    const liveIds = (await repo.orders.listLiveBinanceOrderIdsByAccount(di.db))
      .filter((r) => r.accountId === unwrapId(accountId))
      .map((r) => r.binanceOrderId);
    if (liveIds.includes(binanceOrderId)) {
      throw new HttpError('CONFLICT', 'order is already adopted');
    }

    // The owning strategy's slot for this symbol is already held by a live row:
    // block rather than clobber its tracking row. The rare two-orphans-on-one-slot
    // case surfaces a clear conflict instead of silently dropping one.
    const existing = await p.orders.findLive(orphan.symbol, adoptedIntent);
    if (existing) {
      throw new HttpError('CONFLICT', `a ${adoptedIntent} order is already tracked on this symbol`);
    }

    // Resolve the orphan symbol's base asset (the shared wallet line) for the
    // exclusivity check below. exchangeInfo is keyed per Binance environment, so
    // read the orphan's own mode.
    const exchange = await loadOrFetchExchangeInfo(di.redis.raw(), orphan.mode);
    const listed = exchange.symbols.find((s) => s.symbol === orphan.symbol);
    if (!listed) {
      throw new HttpError('VALIDATION_FAILED', `symbol not listed on Binance: ${orphan.symbol}`);
    }
    const baseAsset = listed.baseAsset;

    // Base-asset exclusivity: a base asset another profile on this account
    // already manages cannot be adopted here. Check BEFORE the order insert so a
    // conflict 409s cleanly without leaving a tracked order with no binding
    // (the `profileSymbols.upsert` below would otherwise throw post-insert).
    // Both halves the upsert enforces are mirrored here: a sibling already
    // trading the base, and a sibling that settles (quotes) in it.
    const sibling = await repo.profileSymbols.findOwningSiblingByBase(
      di.db,
      accountId,
      baseAsset,
      p.scope.profileId,
    );
    if (sibling) {
      throw new HttpError(
        'CONFLICT',
        `base asset ${baseAsset} is managed by profile "${sibling.name}" on this account`,
      );
    }
    const quoter = await repo.profileSymbols.findSiblingQuotingBase(
      di.db,
      accountId,
      baseAsset,
      p.scope.profileId,
    );
    if (quoter) {
      throw new HttpError(
        'CONFLICT',
        `base asset ${baseAsset} is the settlement asset of profile "${quoter.name}" on this account`,
      );
    }

    let row;
    try {
      row = await p.orders.insert({
        symbol: orphan.symbol,
        side: orphan.side,
        intent: adoptedIntent,
        binanceOrderId,
        clientOrderId: orphan.clientOrderId,
        status: orphan.status,
        raw: orphan,
      });
    } catch (err) {
      // Close the TOCTOU window on the partial unique index
      // `orders_one_live_per_intent (profile_id, symbol, intent)`: if a
      // concurrent adopt (or the owning strategy's own order) took the
      // (symbol, intent) slot between the findLive check and here, Postgres raises
      // 23505. Remap to the same 409 the pre-check returns, not a misleading 500.
      if ((err as { code?: string }).code === '23505') {
        throw new HttpError(
          'CONFLICT',
          `a ${adoptedIntent} order is already tracked on this symbol`,
        );
      }
      throw err;
    }

    // The order is tracked now, so it is no longer an orphan. Evict it from every
    // piece of the detector's state SYNCHRONOUSLY: the snapshot (or the adopt list
    // keeps showing it until the next 10-minute tick), and the seen / alerted sets
    // (or its stale membership silently suppresses a genuine re-alert if it ever
    // becomes an orphan again). Best-effort — the adoption itself has committed,
    // and a Redis failure here only means a stale UI until the next tick.
    try {
      const remaining = (snapshot?.orphans ?? []).filter((o) => o.orderId !== orderId);
      // An explicit TTL, never `KEEPTTL`: Redis keeps the TTL of an EXISTING key,
      // but this key may have expired between the read above and now — and SET on
      // a missing key with KEEPTTL creates it PERSISTENT, defeating the whole point
      // of the TTL (a dead worker must stop serving a stale set the operator might
      // act on). Rewriting the cron's own TTL is the honest thing: the snapshot is
      // exactly as fresh as the read it came from.
      await di.redis.raw().set(
        GLOBAL_KEYS.orphanSnapshot(accountId),
        JSON.stringify({
          computedAtMs: snapshot?.computedAtMs ?? Date.now(),
          orphans: remaining,
        }),
        'EX',
        ORPHAN_SNAPSHOT_TTL_S,
      );
      // The dedup sets are per account, so the member is the bare order id.
      await di.redis.raw().srem(GLOBAL_KEYS.orphanAlerted(accountId), orderId);
      await di.redis.raw().srem(GLOBAL_KEYS.orphanSeen(accountId), orderId);
    } catch (err) {
      di.logger.warn(
        { accountId, orderId, err: err },
        'adopt-orphan: failed to evict the adopted order from the detector snapshot',
      );
    }

    // Subscribe so the strategy manages the symbol from now on (mirrors the
    // fill-adopter's orphan recovery). Only when not already bound, so an
    // existing source='auto' binding is left intact.
    const bound = await p.profileSymbols.findForSymbol(orphan.symbol);
    if (!bound) await p.profileSymbols.upsert(orphan.symbol, baseAsset, { source: 'manual' });

    // Signal the worker to pick up the new subscription without a reboot
    // (matches add-symbol). A disabled profile re-reads symbols on next enable.
    if (profile.enabled) {
      await createReconfigureEnqueue(di.queue)({ userId: operatorId, accountId, profileId });
    }

    c.set('auditEvent', {
      event: 'adopt-orphan-order',
      payload: { profileId, symbol: orphan.symbol, orderId },
    });
    return c.json(
      { id: row.id, symbol: row.symbol, profileId: unwrapId(profileId), binanceOrderId: orderId },
      201,
    );
  });

  return app;
};
