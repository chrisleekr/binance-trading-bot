import type {
  AccountSnapshot,
  Decision,
  DecisionResult,
  ExecutorContext,
  OpenOrder,
} from '@app/strategy-core';
import {
  asProfileId,
  asUserId,
  isSymbolPermittedForAccount,
  projectPermissionSets,
  type ProfileId,
} from '@app/contracts';
import { sleep as realSleep } from '@app/core/sleep';
import {
  BinanceApiError,
  DEFAULT_RECV_WINDOW_MS,
  OrderBudgetUnavailableError,
  readSignedCallTiming,
  type BinanceMode,
  type OpenOrderDto,
} from '@app/binance';
import {
  classifyBinanceError,
  isSymbolNotPermittedError,
} from 'executor/binance-error-taxonomy.js';
import { emitEvent } from 'executor/event-emitter.js';
import { fundable } from 'executor/fundable.js';
import {
  buildAccountInfoKey,
  buildAccountPermissionsKey,
  buildOpenOrdersKey,
  buildSymbolInfoKey,
} from 'executor/redis-namespace.js';
import { parseAccountPermissions } from 'lib/account-permissions.js';
import { removeOpenOrder, upsertOpenOrder } from 'executor/open-orders-cache.js';
import { readCurrentWeight, recordWeight } from 'executor/weight-limiter.js';
import { parseAccountSnapshot } from 'tick/snapshot-loader.js';
import { emergencyNotify } from './emergency-notify.js';
import { enqueueReconcile, resolveBindings, type DecisionDeps } from './_types.js';

// Drizzle puts the PG driver error (e.g. the not-null violation) on `err.cause`,
// not the top-level message. Surface it so the action_log records the root cause.
const formatErrorChain = (err: unknown): string => {
  const e = err as { message?: string; cause?: unknown };
  const msg = e?.message ?? String(err);
  return e?.cause == null ? msg : `${msg} | cause: ${String(e.cause)}`;
};

// Order states that mean the order has left the book for good: it is removed
// from the cached open-orders list rather than upserted. A MARKET order that
// fills on placement lands here, so it is never added to the resting-order list.
const TERMINAL_ORDER_STATUSES = new Set(['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED']);

// Binance: "Order does not exist".
const ORDER_NOT_EXIST = -2013;

// Binance: "Account has insufficient balance for requested action".
const INSUFFICIENT_BALANCE = -2010;

/**
 * Slack on top of Binance's recv-window before a -2013 is believed. The window is
 * measured on BINANCE's clock and we wait on OURS; `timeOffsetMs` corrects for the
 * skew but is itself a stale measurement (0 until a resync ever ran), so the margin
 * covers that residual. Erring long only costs a few seconds on a rare path; erring
 * short duplicates a live order.
 */
const CLOCK_SKEW_MARGIN_MS = 1_000;

/**
 * The funding pre-flight sits on the money path, so its Redis read is
 * deadline-bounded: a stalled Redis must delay an order by at most this, never
 * hang the tick. Blowing the deadline degrades to an empty snapshot, which the
 * `fundable` selector treats as "cannot tell" and lets the order through.
 */
const ACCOUNT_SNAPSHOT_READ_TIMEOUT_MS = 500;

const readAccountSnapshot = async (
  deps: DecisionDeps,
  profileId: ProfileId,
): Promise<AccountSnapshot> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('account-info read timed out')),
        ACCOUNT_SNAPSHOT_READ_TIMEOUT_MS,
      );
    });
    const raw = await Promise.race([
      deps.redis.get(buildAccountInfoKey(deps.accountId, profileId)),
      deadline,
    ]);
    return parseAccountSnapshot(raw);
  } catch (err: unknown) {
    deps.logger.warn(
      { profileId, err: err },
      'place-order: account snapshot unreadable, funding pre-flight skipped',
    );
    return { balances: {}, readable: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Whether this account may trade this symbol at all, read from the two caches
 * the exchange-info refresh and the `/account` writers already maintain.
 *
 * Both halves fail open independently: an unreadable symbol entry, an unprimed
 * permissions key, or a stalled Redis yields an empty side, and the caller
 * treats either as "cannot tell" and lets the order through. The refusal below
 * is only ever raised on two positively-read values that provably do not
 * intersect.
 */
const readSymbolPermission = async (
  deps: DecisionDeps,
  mode: BinanceMode,
  symbol: string,
): Promise<{
  permissionSets: readonly (readonly string[])[] | null;
  accountPermissions: readonly string[];
}> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('symbol-permission read timed out')),
        ACCOUNT_SNAPSHOT_READ_TIMEOUT_MS,
      );
    });
    const [rawSymbol, rawPermissions] = await Promise.race([
      Promise.all([
        deps.redis.get(buildSymbolInfoKey(symbol, mode)),
        deps.redis.get(buildAccountPermissionsKey(deps.accountId)),
      ]),
      deadline,
    ]);
    const info =
      rawSymbol === null ? null : (JSON.parse(rawSymbol) as { permissionSets?: unknown });
    return {
      permissionSets: info === null ? null : projectPermissionSets(info.permissionSets),
      accountPermissions: parseAccountPermissions(rawPermissions),
    };
  } catch (err: unknown) {
    deps.logger.warn(
      { symbol, err: err },
      'place-order: symbol permissions unreadable, tradability pre-flight skipped',
    );
    return { permissionSets: null, accountPermissions: [] };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** What a single `getOrder` probe by our own clientOrderId established. */
type Probe =
  | { readonly kind: 'found'; readonly order: OpenOrderDto }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown'; readonly err: unknown };

/**
 * A placement whose response never arrived. The order may or may not be live, and
 * an unresolved `ambiguous` is the worst outcome we can record: nothing may ever
 * retry it (a retry could double the position) AND there is no local row, so the
 * order — if it exists — is invisible until the orphan sweep finds it.
 *
 * A probe by our own `clientOrderId` can collapse that ambiguity into a fact, but
 * only under two conditions that a naive read of the response does NOT give:
 *
 *  1. **"Absent" is not conclusive until the placement can no longer be admitted.**
 *     Binance forwards a signed request to the matching engine while
 *     `serverTime - timestamp <= recvWindow`, and a transport error (socket reset)
 *     can fire hundreds of ms into that window. A -2013 probed at t+300ms only says
 *     the order has not landed YET. Downgrading to `rejected` there tells the tick
 *     "safe to re-issue"; the next tick re-places while the original goes live —
 *     and for a MARKET order the first one FILLS, which frees the clientOrderId
 *     (Binance dedups only among OPEN orders), so the duplicate is accepted. Double
 *     position. So we wait out the rest of the window (plus a clock-skew margin)
 *     and probe again; only a still-absent order is provably never-landed.
 *
 *     The window runs from when the request was SIGNED, which is NOT when we called
 *     the client: the shared weight governor can hold a call for seconds before it
 *     signs, and a -1021 self-heal re-signs it after a `/time` round trip. Anchoring
 *     to our own pre-call reading would let the wait expire while the request is
 *     still admissible. The client reports the real instant on the thrown error
 *     ({@link readSignedCallTiming}); our own reading is only the fallback for a
 *     throw that never got as far as signing.
 *
 *  2. **A found order must be proven to be THIS attempt's.** clientOrderIds are
 *     unique only among OPEN orders and strategies reuse a stable one per
 *     (profile, symbol) across re-arms, so `GET /order?origClientOrderId=` can
 *     return an OLD, long-terminal namesake. `order.time` is the order's creation
 *     instant ON BINANCE'S CLOCK, so the identity test must compare it against the
 *     send instant expressed in THAT clock — `signedAtLocalMs + timeOffsetMs` — not
 *     against our own local reading. With our host running behind Binance, a raw
 *     local comparison would accept a namesake created in the skew window just
 *     BEFORE we sent.
 *
 * Verdicts, and why they lean the way they do — the three errors are NOT equally
 * priced: a false `ambiguous` costs one retry the strategy makes anyway; a false
 * `accepted` says "it is live, never re-issue" and silently drops a protective stop,
 * leaving the position unguarded; a false `rejected` duplicates a live order.
 * Ambiguous is therefore the only safe direction to err in.
 */
const resolveAmbiguousPlacement = async (
  deps: DecisionDeps,
  bindings: Awaited<ReturnType<typeof resolveBindings>>,
  ctx: ExecutorContext,
  decision: Extract<Decision, { type: 'place-order' }>,
  calledAtMs: number,
  cause: Error,
): Promise<DecisionResult> => {
  const userId = asUserId(ctx.userId);
  const profileId = asProfileId(ctx.profileId);
  const symbol = decision.intent.symbol;
  const sleep = deps.sleep ?? realSleep;

  // The instant the placement was SIGNED (local clock) and the correction from our
  // clock to Binance's, both straight from the client. Absent only when the throw
  // happened before signing (a governor abort) — in which case nothing was ever
  // transmitted and our own pre-call reading is an exact anchor anyway.
  const timing = readSignedCallTiming(cause);
  const signedAtLocalMs = timing?.signedAtLocalMs ?? calledAtMs;
  const timeOffsetMs = timing?.timeOffsetMs ?? 0;
  // The send instant on BINANCE's clock — the clock `order.time` is stamped in.
  const sentAtBinanceMs = signedAtLocalMs + timeOffsetMs;

  const probeOnce = async (): Promise<Probe> => {
    try {
      const order = await bindings.binance.getOrder({
        symbol,
        origClientOrderId: decision.intent.clientOrderId,
      });
      return { kind: 'found', order };
    } catch (err) {
      if (err instanceof BinanceApiError && err.code === ORDER_NOT_EXIST) return { kind: 'absent' };
      return { kind: 'unknown', err };
    } finally {
      await recordWeight(deps, deps.accountId, profileId, bindings.binance.ctx().weightUsed1m);
    }
  };

  let probe = await probeOnce();
  if (probe.kind === 'absent') {
    // Holding the per-(profile, symbol) chain for a few seconds on this rare
    // transport-error path is the correct trade against duplicating a live order.
    const remainingMs =
      signedAtLocalMs + DEFAULT_RECV_WINDOW_MS + CLOCK_SKEW_MARGIN_MS - deps.clock.nowMs();
    if (remainingMs > 0) {
      deps.logger.warn(
        { profileId, symbol, remainingMs },
        'place-order: the order is not on Binance yet, but it still could be — waiting out the recv-window before believing that',
      );
      await sleep(remainingMs);
      probe = await probeOnce();
    }
  }

  if (probe.kind === 'unknown') {
    deps.logger.error(
      {
        profileId,
        symbol,
        err: probe.err instanceof Error ? probe.err.message : String(probe.err),
      },
      'place-order: could not resolve an ambiguous placement; leaving it unretryable',
    );
    return {
      ok: false,
      retryable: true,
      phase: 'ambiguous',
      reason: `binance call failed: ${cause.message}`,
      cause,
    };
  }

  if (probe.kind === 'absent') {
    return {
      ok: false,
      retryable: true,
      phase: 'rejected',
      reason: `binance call failed and the order provably never landed: ${cause.message}`,
      cause,
    };
  }

  const probed = probe.order;
  if (probed.time < sentAtBinanceMs) {
    // A namesake from an earlier re-arm, not this attempt. We have proven nothing.
    deps.logger.error(
      { profileId, symbol, orderId: probed.orderId, orderTimeMs: probed.time, sentAtBinanceMs },
      'place-order: the probe matched an OLDER order sharing the clientOrderId; the placement stays unresolved',
    );
    return {
      ok: false,
      retryable: true,
      phase: 'ambiguous',
      reason: `binance response lost and the probe could not identify this attempt's order: ${cause.message}`,
      cause,
    };
  }

  // The order landed. Record it — best-effort, because failing to write the row
  // must not turn a known-live order back into an unknown one — with the status
  // the exchange actually reports (a MARKET order probed after the fact is FILLED,
  // not NEW).
  try {
    await bindings.persistence.persistTrackingOrder({
      userId,
      profileId,
      symbol,
      side: decision.intent.side,
      intent: decision.intent.reason,
      binanceOrderId: BigInt(probed.orderId),
      clientOrderId: probed.clientOrderId,
      status: probed.status,
      raw: probed,
      ...(decision.intent.meta !== undefined ? { meta: decision.intent.meta } : {}),
    });
  } catch (writeErr) {
    deps.logger.error(
      { profileId, symbol, orderId: probed.orderId, err: writeErr },
      'place-order: probe found the order live but recording it failed',
    );
  }
  // Mirror the happy-path dedup record: a MARKET order proven live by the probe
  // must also be remembered, or a later read-your-writes re-emit of it would not
  // be suppressed — the exact double-fill this guards, on the highest-risk
  // (transport-error) path.
  if (decision.params.type === 'MARKET') {
    await deps.placementDedup?.record(
      decision.intent.clientOrderId,
      `${deps.accountId}:${symbol}`,
      deps.clock.nowMs(),
    );
  }
  await emergencyNotify(deps, bindings, profileId, {
    severity: 'error',
    topic: 'order-bookkeeping-failed',
    title: 'Order placed but the response was lost',
    symbol,
    body: 'The connection dropped mid-order. The bot checked with Binance: the order DID reach the exchange, and has now been recorded. No action needed unless it repeats.',
    fields: [
      { label: 'Order ID', value: String(probed.orderId) },
      { label: 'Status', value: probed.status },
      { label: 'Error', value: cause.message },
    ],
  });
  return {
    ok: false,
    retryable: false,
    // Binance has the order; only our knowledge of it was lost. Landed means
    // un-re-issuable, exactly like the accepted-then-bookkeeping-failed path.
    phase: 'accepted',
    reason: `binance response lost; the order reached the exchange (${probed.status}): ${cause.message}`,
    cause,
  };
};

/**
 * Live order placement with three contract guarantees that the test
 * suite asserts byte-for-byte:
 *
 *  1. **Weight pre-check.** If the current minute bucket is already at
 *     or above the per-account ceiling, refuse the call with a
 *     retryable result; a notify fires so the operator sees throttle
 *     bursts. No Binance HTTP call happens.
 *  2. **-1021 recovery lives in the binance client.** Timestamp drift
 *     inside Binance's recv-window is resynced and retried once inside the
 *     client's `call()`, so a -1021 that reaches here is a persistent skew:
 *     the executor classifies it non-retryable rather than looping.
 *  3. **Bookkeeping failure is non-retryable.** Once Binance returned a
 *     200, the order is on the book; retrying would duplicate. Persist /
 *     Redis / emit failures must therefore mark `retryable: false` so the
 *     operator triages by hand.
 */
export const placeOrderHandler = async (
  deps: DecisionDeps,
  ctx: ExecutorContext,
  decision: Extract<Decision, { type: 'place-order' }>,
): Promise<DecisionResult> => {
  const userId = asUserId(ctx.userId);
  const profileId = asProfileId(ctx.profileId);
  const bindings = await resolveBindings(deps, userId, profileId);

  // Two independent single-key Redis GETs sitting directly ahead of the signed
  // order. Issued together so the placement's latency budget pays one round-trip
  // instead of two — the same budget the deadline notes above argue must stay
  // tight. Both are read FRESH rather than threaded from the tick's opening
  // snapshot: a concurrent `balanceUpdate` can land mid-tick, and the funding
  // pre-flight must see it. The weight read gates the throttle return below, so
  // the snapshot read is occasionally issued and discarded — one cheap GET on a
  // path that is already refusing to trade.
  const [weight, accountSnapshot] = await Promise.all([
    readCurrentWeight(deps, deps.accountId, profileId),
    readAccountSnapshot(deps, profileId),
  ]);
  if (weight >= bindings.weightLimit1m) {
    await emergencyNotify(deps, bindings, profileId, {
      severity: 'warn',
      topic: 'binance-weight-throttle',
      title: 'Binance rate limit — throttling',
      symbol: decision.intent.symbol,
      body: "Nearing Binance's API rate limit; the bot is slowing new orders to avoid a ban. No action needed unless this persists.",
      fields: [
        {
          label: 'Usage',
          value: `${weight} of ${bindings.weightLimit1m} (${Math.round((weight / bindings.weightLimit1m) * 100)}%)`,
        },
      ],
    });
    return {
      ok: false,
      retryable: true,
      // Refused here, before any HTTP call: the order provably never reached
      // Binance, so a caller may safely re-issue it once the bucket drains.
      phase: 'pre-call',
      reason: `weight-limit-throttle weight=${weight} limit=${bindings.weightLimit1m}`,
    };
  }

  // Tradability pre-flight. Binance gates each symbol on permission tags: the
  // account must hold at least one tag from EVERY set the symbol publishes.
  // When it does not, the placement is refused -2010 on every attempt, forever,
  // and the strategy re-derives it every tick, so this one symbol can burn the
  // account's entire request-weight budget and throttle every other profile on
  // it. Both inputs are readable here, before any HTTP call.
  //
  // No mode gate, unlike the API's bind guard: that one compares a live-pinned
  // symbol listing against whatever key pair the account holds, so it must
  // restrict itself to live accounts. Here BOTH sides are already mode-scoped
  // (the symbol-info key carries the mode, and the permissions are the
  // account's own), so the comparison never crosses environments. Testnet
  // publishes the single set `SPOT` on every symbol, which a testnet key pair
  // holds, so the cut is inert there rather than wrong.
  const permission = await readSymbolPermission(deps, bindings.mode, decision.intent.symbol);
  if (
    permission.permissionSets !== null &&
    permission.accountPermissions.length > 0 &&
    !isSymbolPermittedForAccount({
      permissionSets: permission.permissionSets,
      accountPermissions: permission.accountPermissions,
    })
  ) {
    // Windowed like the unfundable alert, and for a stronger reason: nothing the
    // bot does will ever clear this, so the re-emission is unbounded in time.
    const alertAllowed =
      (await deps.symbolNotPermittedThrottle?.allow(`${profileId}:${decision.intent.symbol}`)) ??
      true;
    if (alertAllowed) {
      await emergencyNotify(deps, bindings, profileId, {
        severity: 'error',
        topic: 'order-symbol-not-permitted',
        title: 'Symbol skipped — your Binance account cannot trade it',
        symbol: decision.intent.symbol,
        // Name the fix, because there is exactly one and the bot cannot do it:
        // this never clears on its own the way a balance shortfall does.
        body:
          `Binance will not accept orders for ${decision.intent.symbol} on this account: the ` +
          'symbol requires a trading permission your API key pair does not have. This does not ' +
          'clear by itself, so the bot will not send any order for it. Remove the symbol from ' +
          "this profile, or enable the required permission in your Binance account's settings.",
        fields: [
          {
            label: 'Action',
            value: `${decision.intent.side} ${decision.params.quantity} (${decision.params.type})`,
          },
          {
            label: 'Symbol needs',
            value: permission.permissionSets.map((s) => s.join(' or ')).join(' and '),
          },
          { label: 'Account has', value: permission.accountPermissions.join(', ') },
        ],
      });
    }
    return {
      ok: false,
      retryable: false,
      // Nothing was transmitted. Non-retryable because no retry can ever
      // succeed: the refusal is a property of the account, not of the moment.
      phase: 'pre-call',
      reason: `symbol not permitted for this account: ${decision.intent.symbol} requires ${permission.permissionSets
        .map((s) => s.join('|'))
        .join('+')}, account holds ${permission.accountPermissions.join(',')}`,
    };
  }

  // Funding pre-flight. A resting order LOCKS the balance it holds, so an order
  // sized from the wallet total is rejected -2010 by Binance on every attempt —
  // and a strategy that re-derives it each tick re-sends it forever. The wallet is
  // readable here, before any HTTP call, so such an order never reaches the wire.
  const funding = fundable({
    side: decision.intent.side,
    symbol: decision.intent.symbol,
    quoteAsset: bindings.quoteAsset,
    params: decision.params,
    account: accountSnapshot,
    // A cancel that already succeeded in THIS batch (the exit's `[cancel our stop,
    // place the SELL]`, a stop re-price) has given the base back, but the cached
    // snapshot lags. Without this credit the pre-flight would veto the exit itself.
    releasedInBatch: (asset) => deps.cancelLedger.releasedFor(asset),
  });
  if (funding.kind === 'shortfall') {
    // The strategy re-derives this order every tick until the operator frees the
    // coins, so the ALERT — not just its gap trace — is windowed per (profile,
    // symbol). Fleet-wide via a self-expiring SET NX PX key; a Redis fault fails
    // open (a duplicate alert beats a silent one).
    const alertAllowed =
      (await deps.unfundableThrottle?.allow(`${profileId}:${decision.intent.symbol}`)) ?? true;
    if (alertAllowed) {
      await emergencyNotify(deps, bindings, profileId, {
        severity: 'error',
        topic: 'order-unfundable',
        title: 'Order skipped — not enough free balance',
        symbol: decision.intent.symbol,
        // State the FACT (the wallet cannot fund this order, and by how much) and
        // offer the usual cause as a likelihood, not a certainty: the same shortfall
        // can be a resting SELL holding the coins, a resting BUY holding the cash, or
        // a manual withdrawal, and an alert that asserts the wrong one sends the
        // operator looking for an order that does not exist.
        body:
          `The bot could not place this order: it needs ${funding.required} ${funding.asset} ` +
          `but only ${funding.free} is free to spend. The usual cause is another order still ` +
          'resting on Binance holding the balance — check your open orders there and cancel ' +
          'the one you no longer want. Until the balance is free, the bot will not send this ' +
          'order.',
        fields: [
          {
            label: 'Action',
            value: `${decision.intent.side} ${decision.params.quantity} (${decision.params.type})`,
          },
          { label: 'Needs', value: `${funding.required} ${funding.asset}` },
          { label: 'Available', value: `${funding.free} ${funding.asset}` },
        ],
      });
    }
    return {
      ok: false,
      retryable: false,
      // Nothing was transmitted, so nothing can be live. Non-retryable because
      // re-sending an order the wallet still cannot fund IS the rejection storm.
      phase: 'pre-call',
      reason: `unfundable ${decision.intent.side} ${decision.intent.symbol}: needs ${funding.required} ${funding.asset}, free ${funding.free} — shortfall`,
    };
  }

  // Placement dedup (see executor/placement-dedup). A MARKET order fills+closes
  // instantly, freeing its clientOrderId, so a re-emitted identical MARKET order
  // — a tick that lost read-your-writes and re-derived a just-filled entry — is
  // accepted by Binance and fills AGAIN. A SELL is an exit: forget this symbol's
  // entry records so a legitimate re-entry after the close (same stable entry
  // clientOrderId) is never suppressed. A MARKET BUY seen within the window is a
  // duplicate — suppress it and report success (the order this decision wanted IS
  // on the exchange, so the tick advances rather than retrying). MARKET-only
  // leaves resting stop-limit repricing (legit same-id cancel+replace) untouched.
  const symbolKey = `${deps.accountId}:${decision.intent.symbol}`;
  if (decision.intent.side === 'SELL') {
    await deps.placementDedup?.forgetSymbol(symbolKey, deps.clock.nowMs());
  } else if (
    decision.params.type === 'MARKET' &&
    (await deps.placementDedup?.seenRecently(
      decision.intent.clientOrderId,
      symbolKey,
      deps.clock.nowMs(),
    )) === true
  ) {
    deps.logger.warn(
      { profileId, symbol: decision.intent.symbol, clientOrderId: decision.intent.clientOrderId },
      'place-order: suppressed a duplicate MARKET placement (same clientOrderId within the dedup window) — a just-filled order was re-emitted',
    );
    return { ok: true };
  }

  let dto: Awaited<ReturnType<typeof bindings.binance.placeOrder>>;
  // When we CALLED the client — a fallback anchor only. The request is not signed
  // until the weight governor admits it, which can be seconds later, and Binance's
  // admission window runs from the SIGNED instant. The client reports that instant
  // on the thrown error; this reading is what we fall back to when it never signed.
  const calledAtMs = deps.clock.nowMs();
  try {
    dto = await bindings.binance.placeOrder({
      symbol: decision.intent.symbol,
      side: decision.intent.side,
      type: decision.params.type,
      quantity: decision.params.quantity,
      newClientOrderId: decision.intent.clientOrderId,
      ...(decision.params.price !== undefined ? { price: decision.params.price } : {}),
      ...(decision.params.stopPrice !== undefined ? { stopPrice: decision.params.stopPrice } : {}),
      ...(decision.params.trailingDelta !== undefined
        ? { trailingDelta: decision.params.trailingDelta }
        : {}),
      ...(decision.params.timeInForce !== undefined
        ? { timeInForce: decision.params.timeInForce }
        : {}),
    });
  } catch (err) {
    await recordWeight(deps, deps.accountId, profileId, bindings.binance.ctx().weightUsed1m);
    if (err instanceof OrderBudgetUnavailableError) {
      // Refused at the ORDERS admission gate, before the request was signed, so
      // it provably never reached Binance. Classified ahead of the transport
      // branch below precisely so it does NOT probe: a probe of an order that
      // was never sent can only resolve `ambiguous`, which is unretryable and
      // would leave the placement permanently stranded over a rate limit that
      // clears by itself.
      return {
        ok: false,
        retryable: true,
        phase: 'pre-call',
        // The same condition the executor's pre-batch peek sheds silently,
        // reached instead by losing the race between that peek and this
        // reservation. A deferrable order has to classify identically either
        // way, or the alert the shed exists to suppress fires on timing alone.
        // A NON-deferrable refusal keeps alerting: that order's absence really
        // does leave the position less protected.
        ...(decision.intent.deferrable === true ? { deferred: true as const } : {}),
        reason: `order-budget-exhausted window=${err.windowMs}ms wait=${err.waitMs}ms`,
      };
    }
    if (!(err instanceof BinanceApiError)) {
      // A transport-level throw (socket hang-up, timeout, DNS) tells us the
      // response never arrived — NOT that the request never landed. Rather than
      // leave that permanently unknowable (and permanently un-retryable, and with
      // NO local row for an order that may be live), ask Binance which it was.
      // The clientOrderId is ours, so the probe can find the order — but only
      // once the recv-window has closed and only if the order it returns is
      // provably this attempt's. See `resolveAmbiguousPlacement`.
      return resolveAmbiguousPlacement(deps, bindings, ctx, decision, calledAtMs, err as Error);
    }
    const classified = classifyBinanceError(err);
    // A SELL Binance refuses for want of balance is the loudest possible signal
    // that the wallet no longer holds what the strategy thinks it does: the
    // position was very likely already sold (a fill the user stream never
    // delivered). Schedule the converge pass. It changes nothing about THIS
    // decision — a -2010 stays non-retryable, because a SELL that retries against
    // a balance that is not coming back would loop forever — it only repairs the
    // state that produced the impossible order. The "does the state even claim a
    // position?" judgement lives in the job (the reconcile no-ops when state
    // already agrees with the wallet), not here, so no StatePort on the hot path.
    // -2010 is an umbrella code, and one of its other meanings is "this symbol
    // is not permitted for this account". That says nothing about the wallet, so
    // it must NOT enqueue a converge pass: the balance is fine, the symbol is
    // simply untradeable, and a reconcile per tick would add queue churn to a
    // condition only the operator can clear.
    if (
      err.code === INSUFFICIENT_BALANCE &&
      decision.intent.side === 'SELL' &&
      !isSymbolNotPermittedError(err)
    ) {
      await enqueueReconcile(deps, profileId, decision.intent.symbol, 'place-2010-insufficient', {
        clientOrderId: decision.intent.clientOrderId,
      });
    }
    if (classified.emergency) {
      await emergencyNotify(deps, bindings, profileId, {
        severity: 'error',
        topic: 'binance-emergency',
        title: 'Binance order error',
        symbol: decision.intent.symbol,
        body: 'The bot hit a Binance error and backed off safely. The order was not placed.',
        fields: [
          { label: 'Action', value: `${decision.intent.side} (${decision.params.type})` },
          { label: 'Error', value: `${err.code ?? 'n/a'} — ${err.message}` },
        ],
      });
    }
    return classified.result.ok ? classified.result : { ...classified.result, cause: err };
  }

  // Order accepted by Binance. Bookkeeping failures must NOT trigger a retry,
  // a retry would place a duplicate live order. Mark failures as non-retryable.
  await recordWeight(deps, deps.accountId, profileId, bindings.binance.ctx().weightUsed1m);
  // Record the accepted MARKET clientOrderId so the next tick's duplicate guard
  // above suppresses a re-emit of this just-placed order. On ACCEPT (not the
  // bookkeeping below) so it stands even if persistence then fails.
  if (decision.params.type === 'MARKET') {
    await deps.placementDedup?.record(decision.intent.clientOrderId, symbolKey, deps.clock.nowMs());
  }
  // An accepted order without a status is by definition resting/NEW. Default it
  // rather than throw: the order is already live on Binance, this is the money path.
  const status = dto.status ?? 'NEW';
  const persisted = {
    userId,
    profileId,
    symbol: decision.intent.symbol,
    side: decision.intent.side,
    intent: decision.intent.reason,
    binanceOrderId: BigInt(dto.orderId),
    clientOrderId: dto.clientOrderId,
    status,
    raw: dto,
    ...(decision.intent.meta !== undefined ? { meta: decision.intent.meta } : {}),
  };
  try {
    await bindings.persistence.persistOrder(persisted, {
      // The row currently holding this live slot may only be stamped CANCELED if
      // no cancel we attempted this tick left it resting on the exchange.
      closePrevious: !deps.cancelLedger.hasUnresolved(
        decision.intent.symbol,
        decision.intent.reason,
      ),
    });
    // Maintain the shared open-orders snapshot in place instead of DELeting it,
    // so a sibling profile's next tick reads the new resting order without a REST
    // cold-load. A terminal placement (a MARKET that filled) is removed, not
    // added. Best-effort: a cache-write failure must NOT fail a placement already
    // accepted by Binance and committed to Postgres — the TTL cold-load self-heals.
    try {
      const key = buildOpenOrdersKey(deps.accountId, decision.intent.symbol);
      if (TERMINAL_ORDER_STATUSES.has(status)) {
        await removeOpenOrder(deps.redis, key, dto.orderId);
      } else {
        const cached: OpenOrder = {
          orderId: dto.orderId,
          clientOrderId: dto.clientOrderId,
          symbol: decision.intent.symbol,
          side: decision.intent.side,
          type: decision.params.type,
          status: status as OpenOrder['status'],
          // A STOP_LOSS has no limit leg at all, so there is no price to record.
          // The empty string is the same "absent" sentinel the snapshot adapter
          // already uses for a missing stopPrice: every reader parses it to
          // "unknown" rather than to zero. Fabricating '0' is what puts a stop
          // priced at nothing in front of the operator.
          price: decision.params.type === 'STOP_LOSS' ? '' : (decision.params.price ?? '0'),
          origQty: decision.params.quantity,
          executedQty: '0',
          cummulativeQuoteQty: '0',
          ...(decision.params.stopPrice !== undefined
            ? { stopPrice: decision.params.stopPrice }
            : {}),
          ...(decision.params.trailingDelta !== undefined
            ? { trailingDelta: decision.params.trailingDelta }
            : {}),
          ...(decision.params.timeInForce !== undefined
            ? { timeInForce: decision.params.timeInForce }
            : {}),
          transactTimeMs: deps.clock.nowMs(),
          updateTimeMs: deps.clock.nowMs(),
        };
        await upsertOpenOrder(deps.redis, key, cached);
      }
    } catch (cacheErr) {
      deps.logger.warn(
        { profileId, orderId: dto.orderId, err: cacheErr },
        'place-order: open-orders cache upsert failed; next tick cold-loads',
      );
    }
    await emitEvent(deps, deps.accountId, profileId, 'orders', {
      orderId: dto.orderId,
      clientOrderId: dto.clientOrderId,
      status,
    });
    return { ok: true };
  } catch (err) {
    const errMsg = formatErrorChain(err);
    deps.logger.error(
      { profileId, orderId: dto.orderId, err },
      'place-order: post-submit bookkeeping failed (order already accepted)',
    );
    // The order IS live on the exchange. Before anything else, get a durable row
    // carrying its Binance orderId written: without one the user-data stream
    // cannot reconcile the fill and the operator's only trace is an orphan alert.
    // `insertTracking` writes under a reserved per-order intent, so it never
    // contends for (or closes) the strategy's live slot — which is what makes it
    // land even when the failure above WAS that slot refusing to be reused, the
    // single most likely way to get here. Best-effort: it is a recovery path, and
    // its own failure must not mask the original error or change the result below.
    try {
      await bindings.persistence.persistTrackingOrder(persisted);
    } catch (trackErr) {
      deps.logger.error(
        { profileId, orderId: dto.orderId, err: trackErr },
        'place-order: failed to record a tracking row for the live order',
      );
    }
    // No silent failures: the order is live on the exchange but the bot
    // failed to record it. Surface it both to the operator (notify) and
    // to the durable action log so the orphan is recoverable. Both are
    // best-effort — a notify or log failure must not mask the original
    // bookkeeping error or change the non-retryable result below.
    await emergencyNotify(deps, bindings, profileId, {
      severity: 'error',
      topic: 'order-bookkeeping-failed',
      title: 'Order placed but not recorded',
      symbol: decision.intent.symbol,
      body: 'An order is live on Binance but the bot failed to save it locally. Check and reconcile manually.',
      fields: [
        { label: 'Order ID', value: String(dto.orderId) },
        { label: 'Error', value: errMsg },
      ],
    });
    try {
      await bindings.persistence.recordBookkeepingFailure({
        symbol: decision.intent.symbol,
        orderId: dto.orderId,
        err: errMsg,
      });
    } catch (logErr) {
      deps.logger.error(
        { profileId, orderId: dto.orderId, err: logErr },
        'place-order: failed to write bookkeeping-failure action_log',
      );
    }
    return {
      ok: false,
      retryable: false,
      // Binance said yes; only the local write failed. The order is live, so no
      // caller may re-issue it — that would double the position.
      phase: 'accepted',
      reason: `order accepted but bookkeeping failed: ${errMsg}`,
      cause: err,
    };
  }
};
