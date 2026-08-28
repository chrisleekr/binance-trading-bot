import {
  AccountInfoSnapshot,
  DAILY_ENTRY_HALT_REASON,
  decimalAdd,
  MANUAL_OVERRIDE_TTL_SECONDS,
  type ManualOverridePayload,
  type OperatorAction,
} from '@app/contracts';
import { z } from 'zod';
import { Decimal } from '@app/money';
import { GLOBAL_KEYS, profileKey, type ProfileRepo } from '@app/db';
import type { DI } from 'di.js';
import { isEntryHaltedFailOpen } from 'lib/entry-halt.js';
import { HttpError } from 'middleware/error.js';
import { errorMessage } from '@app/core/error';

/**
 * Reject an operator action the profile's strategy does not support, before
 * any override row is written or tick enqueued. Reads the generic
 * `capabilities.operatorActions` set off the registered strategy — it never
 * branches on a concrete strategy name, so adding a strategy needs no edit
 * here. A momentum force-buy (momentum declares no operator actions) 422s
 * instead of writing a row the tick would silently drop.
 */
export const assertActionSupported = async (
  di: DI,
  p: ProfileRepo,
  action: OperatorAction,
): Promise<void> => {
  const profile = await p.profile.findById();
  if (!profile) throw new HttpError('NOT_FOUND', 'profile');
  // Gate on the LIVE plugin, not the stored version. A profile whose strategy
  // has bumped since it was created still runs the live plugin in tick(); only
  // a genuinely-unregistered name is rejected.
  const resolved = di.strategies.describeForProfile(profile.strategyName, profile.strategyVersion);
  if (resolved.status === 'unknown') {
    throw new HttpError('STRATEGY_NOT_REGISTERED', `strategy ${resolved.name} is not registered`);
  }
  const strategy = resolved.strategy;
  if (!strategy.capabilities.operatorActions.includes(action)) {
    throw new HttpError(
      'ACTION_UNSUPPORTED',
      `strategy ${profile.strategyName} does not support the ${action} action`,
    );
  }
};

/**
 * Refuse a BUY-side operator action while the daily-loss breaker is armed.
 *
 * A fast-fail UX shortcut, NOT the enforcement point. The WORKER is authoritative:
 * it re-checks the breaker on the tick and drops the emitted BUY, which is the
 * check that actually holds — this one keys off the REQUEST's `side`, the worker's
 * off the side of the decision the strategy emits, and a strategy is free to emit
 * something other than what the request literally named. So the worker is the
 * backstop and this is only here to spare the operator a 202 followed, minutes
 * later, by a rejection: refusing now means no row, no Redis key, and an immediate
 * answer they can act on. It fails open for the same reason: the worker still
 * enforces the halt, so a flag-read blip must not be what stops the operator.
 *
 * Exits are never gated: the breaker pauses new risk, it never traps the operator
 * in a position.
 */
export const assertEntryNotHalted = async (di: DI, p: ProfileRepo): Promise<void> => {
  if (await isEntryHaltedFailOpen(di, p.scope)) {
    throw new HttpError('CONFLICT', DAILY_ENTRY_HALT_REASON);
  }
};

/**
 * Whether a ledger quantity string is a usable size: parses to a finite
 * Decimal strictly greater than zero. An unparseable string returns false
 * rather than throwing, so a malformed row is treated as no row.
 */
const isPositiveQuantity = (quantity: string): boolean => {
  try {
    return new Decimal(quantity).isFinite() && new Decimal(quantity).gt(0);
  } catch {
    return false;
  }
};

/**
 * Held quantity for a symbol's base asset, as a decimal string, for sizing
 * the operator's avg-entry-price write. Source precedence:
 *
 * 1. The worker-maintained `account-info` snapshot (with the global
 *    `symbol-info` for base-asset resolution) — freshest wallet truth,
 *    free+locked for the base asset. Only present for an enabled, ticking
 *    profile.
 * 2. Else the existing `avg_entry_prices` ledger row's quantity, but only
 *    when that quantity parses > 0. A disabled or just-adopted profile has
 *    no account-info snapshot, but adopt reconstructs the ledger and the
 *    worker reconciles held quantity from the wallet each tick, so the
 *    ledger quantity is a safe, plugin-agnostic size source — the operator
 *    is correcting the PRICE, not the size. A zero-quantity ledger row is a
 *    "price marker" treated as flat everywhere (`quantity > 0`); reusing it
 *    would size the write to 0 and make the operator's correction a silent
 *    no-op, so it is treated as no row and falls through.
 * 3. Else `UPSTREAM_FAILED`: no live wallet snapshot and no usable ledger
 *    row to size against.
 *
 * A present account-info snapshot with no `symbol-info` snapshot yet also
 * throws `UPSTREAM_FAILED` — the ledger fallback is reached only when
 * account-info itself is absent. Throws `UPSTREAM_FAILED` too on a
 * present-but-malformed account-info / symbol-info snapshot or an
 * unparseable balance amount.
 */
export const balanceQuantityForSymbol = async (
  di: DI,
  p: ProfileRepo,
  symbol: string,
): Promise<string> => {
  // Reads the profile-scoped `account-info` JSON written by the worker user
  // stream. This key uses a write-through freshness model: it is refreshed
  // on every executionReport / balanceUpdate WS event, with the
  // `account-snapshot-safety` cron polling every 5s and re-fetching from
  // Binance when no WS event has landed in the prior 30s.
  const r = di.redis.raw();
  const { accountId, profileId } = p.scope;
  const accountInfoKey = profileKey({ accountId, profileId }, 'accountInfo');
  // Read the canonical (live) symbol-info keyspace for `baseAsset` only.
  // `baseAsset` is mode-invariant — BTCUSDT resolves to BTC on both testnet and
  // production — so the mode-specific tickSize / lot filters (namespaced per
  // `binanceMode`) are irrelevant here and the live key is the right read for
  // every mode. A test-mode profile binds production-listed symbols (the worker
  // feeds all modes from the production market stream), so the live key is present.
  const symbolInfoKey = GLOBAL_KEYS.symbolInfo(symbol, 'live');
  const [accInfoRaw, symbolInfoRaw] = await Promise.all([
    r.get(accountInfoKey),
    r.get(symbolInfoKey),
  ]);

  // No live wallet snapshot: fall back to the cost-basis ledger. symbol-info
  // is irrelevant here — the ledger row already carries the quantity. Reuse the
  // already-resolved scope; ownership was proven at the route boundary.
  if (!accInfoRaw) {
    const ledger = await p.avgEntryPrices.findBySymbol(symbol);
    // A zero-quantity ledger row is a price marker treated as flat
    // everywhere; sizing the write to it would make the operator's
    // correction a silent no-op. An unparseable quantity is equally
    // unusable. Either way, fall through to the clear 502 rather than
    // returning a value that quietly does nothing.
    if (ledger && isPositiveQuantity(ledger.quantity)) return ledger.quantity;
    throw new HttpError(
      'UPSTREAM_FAILED',
      'no live balance snapshot and no cost-basis ledger to size against — enable the profile (or let the bot reconcile) so a balance can be read',
    );
  }
  if (!symbolInfoRaw) {
    throw new HttpError('UPSTREAM_FAILED', 'symbol info not yet snapshot');
  }
  // Validate both snapshots rather than casting — `account-info` against the
  // shared `AccountInfoSnapshot` contract, and the `baseAsset` slice of
  // `symbol-info` we depend on — so a drifted shape surfaces as a clean 502
  // rather than an undefined lookup ("no balance for undefined").
  let accInfo: AccountInfoSnapshot;
  let sInfo: { baseAsset: string };
  try {
    accInfo = AccountInfoSnapshot.parse(JSON.parse(accInfoRaw));
    sInfo = z.object({ baseAsset: z.string().min(1) }).parse(JSON.parse(symbolInfoRaw));
  } catch (err) {
    throw new HttpError('UPSTREAM_FAILED', 'snapshot json malformed', err);
  }
  const bal = accInfo.balances[sInfo.baseAsset];
  if (!bal) {
    throw new HttpError('UPSTREAM_FAILED', `no balance for ${sInfo.baseAsset}`);
  }
  // Sum free + locked with decimal.js precision and return the asset
  // quantity itself. `avg_entry_prices.quantity` is a numeric(38,18)
  // column, so a fixed-point-scaled integer would land 1e18x too large.
  try {
    return decimalAdd(bal.free, bal.locked);
  } catch (err) {
    throw new HttpError('UPSTREAM_FAILED', 'balance snapshot has a malformed amount', err);
  }
};

/**
 * Raised when `writeOverrideAndEnqueue`'s post-enqueue-failure rollback
 * could not complete, so the Redis `override` key may still be live. The
 * caller MUST NOT mark the `override_actions` row consumed on this error:
 * a later market-data tick can still pick up the override and execute it,
 * so the row is genuinely still pending, not abandoned.
 */
export class OverrideRollbackError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OverrideRollbackError';
  }
}

/**
 * Enqueue a strategy `tick` for an operator-initiated re-evaluation.
 *
 * MUST use `di.tickQueue`, not `di.queue`. `di.queue` is the pipeline
 * fan-out queue whose worker only handles subscribe/unsubscribe/verify-key;
 * a `tick` name posted there routes to the unknown-job-name throw path and
 * DLQs.
 *
 * `event: 'resync'` is the canonical "re-evaluate from scratch" tag the
 * worker's `mapEventToTrigger` recognises; `payload.reason: 'manual'`
 * carries the operator-initiation context through to the audit log.
 * `enqueuedAtMs` is required for the audit shipper's `payload.enqueuedAtMs`
 * field; sending it as `undefined` would land in the audit stream as a
 * hole and break any monitor keyed on the field.
 */
export const enqueueTick = async (di: DI, p: ProfileRepo, symbol: string): Promise<void> => {
  const { operatorId, accountId, profileId } = p.scope;
  const now = Date.now();
  await di.tickQueue.add(
    'tick',
    {
      userId: operatorId,
      accountId,
      profileId,
      symbol,
      event: 'resync',
      enqueuedAtMs: now,
      payload: { reason: 'manual' },
    },
    { jobId: `tick:${profileId}:${symbol}:${now}` },
  );
};

/**
 * Enqueue the worker `apply-avg-entry-price` job that force-sets the running
 * strategy's cost basis from the `avg_entry_prices` ledger.
 *
 * MUST use `di.queue` (the pipeline queue), not `di.tickQueue`: a plain tick
 * never converges the ledger into `state.avgEntryPrice`, and the boot/reconfigure
 * revive refuses to overwrite a populated state, so the dedicated force-set job
 * is the only path that makes an operator's price reach the running strategy. A
 * unique jobId per call (no coalescing) so each operator write applies the
 * latest ledger value. Shared by the set/delete routes and the combined
 * add-symbol path so the job name + id format live in one place.
 */
export const enqueueApplyAvgEntryPrice = async (
  di: DI,
  p: ProfileRepo,
  symbol: string,
): Promise<void> => {
  const { operatorId, accountId, profileId } = p.scope;
  await di.queue.add(
    'apply-avg-entry-price',
    { userId: operatorId, accountId, profileId, symbol },
    { jobId: `apply-aep:${profileId}:${symbol}:${Date.now()}` },
  );
};

/**
 * Atomic-ish override write + tick enqueue. The Redis write commits first
 * (worker bundle-builder reads it via GETDEL), then the tick is enqueued.
 * If the enqueue throws, the Redis row is deleted so a market-data WS
 * tick firing later does not pick up an orphaned override and fire an
 * order the operator was told failed. The DB `override_actions` row
 * stays as audit history regardless; the override row is marked consumed
 * after the worker actually processes the tick.
 *
 * If that rollback delete itself fails, the override may still be live —
 * this throws {@link OverrideRollbackError} so the caller leaves the
 * `override_actions` row pending rather than marking it consumed.
 */
export const writeOverrideAndEnqueue = async (
  di: DI,
  p: ProfileRepo,
  symbol: string,
  payload: ManualOverridePayload,
): Promise<void> => {
  const { accountId, profileId } = p.scope;
  const scope = { kind: 'profile' as const, accountId, profileId };
  const ops = di.redis.forProfile(scope);
  await ops.set(
    'override',
    JSON.stringify(payload),
    { ttlSeconds: MANUAL_OVERRIDE_TTL_SECONDS },
    symbol,
  );
  try {
    await enqueueTick(di, p, symbol);
  } catch (err) {
    try {
      // Compare-and-delete: only roll back if the value we wrote is still
      // the live override. A concurrent operator click could have written
      // a newer override between our SET and this catch; deleting it
      // blindly would silently drop the operator's most recent intent.
      const current = await ops.get('override', symbol);
      if (current !== null) {
        let stored: { overrideActionId?: string } | null = null;
        try {
          stored = JSON.parse(current) as { overrideActionId?: string };
        } catch {
          // Malformed payload (hand-edited Redis): leave alone.
        }
        if (stored && stored.overrideActionId === payload.overrideActionId) {
          await ops.del('override', symbol);
        }
      }
    } catch (rollbackErr) {
      // The rollback get/del failed — our override may still be live in
      // Redis. Signal the caller to leave the override_actions row
      // pending; a later tick can still consume the override. The message
      // keeps the root-cause enqueue failure; `cause` carries the rollback
      // failure, which is what left the override live.
      throw new OverrideRollbackError(
        `override enqueue failed (${errorMessage(err)}) and the Redis rollback did not complete`,
        { cause: rollbackErr },
      );
    }
    throw err;
  }
};

/**
 * Run `body` after a fresh `override_actions` row has been recorded, and settle
 * that row if `body` throws. Without this, a failed enqueue leaves a stale
 * "pending" row that the SPA's `GET /override` keeps surfacing indefinitely —
 * the operator sees a stuck indicator for an action that never actually started.
 *
 * It settles as `rejected`, not merely consumed: a row closed out with no
 * outcome reads on the symbol page exactly like one that succeeded, which is the
 * lie this whole path exists to avoid. Best-effort, because the primary error
 * already failed the operator's request and a second failure must not mask the
 * first.
 *
 * Exception: an {@link OverrideRollbackError} means the Redis override may still
 * be live, so the row is genuinely still pending — it is left alone and the
 * failure logged loudly. Settling it there would hide a row whose override a
 * later tick can still execute.
 */
export const runOverrideOrRollbackDb = async (
  di: DI,
  p: ProfileRepo,
  actionId: string,
  body: () => Promise<void>,
): Promise<void> => {
  const { profileId } = p.scope;
  try {
    await body();
  } catch (err) {
    if (err instanceof OverrideRollbackError) {
      di.logger.error(
        { profileId, actionId },
        'override rollback failed: Redis override may still be live; override_actions row left pending',
      );
      throw err;
    }
    try {
      await p.overrideActions.settle(actionId, {
        status: 'rejected',
        reason: 'the bot could not be reached to run this action',
      });
    } catch (settleErr) {
      di.logger.warn(
        { profileId, actionId, err: settleErr },
        'override rollback: settle failed; row may surface as stuck pending until manual cleanup',
      );
    }
    throw err;
  }
};
