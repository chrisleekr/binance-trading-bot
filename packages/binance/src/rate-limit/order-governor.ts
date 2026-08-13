// Central per-ACCOUNT Binance order-rate governor.
//
// Binance meters order PLACEMENT against an `ORDERS` budget that is SEPARATE
// from `REQUEST_WEIGHT` and scoped differently: weight is per-IP, ORDERS is
// per-account (UID). Two accounts on the same host therefore have independent
// order budgets, so one governor per account — sharing a single bucket across N
// accounts would throttle each to 1/N of its real allowance.
//
// The budget is an UNFILLED order count: a placement adds one, a first fill
// (partial or full) subtracts one, and a cancel or an expiry changes nothing.
// So only placements are charged, and nothing is ever credited back.
//
// That makes the tally an upper bound on the orders THIS PROCESS knows about,
// and a lower bound on what Binance is actually counting. Both hold at once
// because they measure different things: we never credit a fill, so we sit
// above Binance's unfilled count for the flow we placed ourselves; but orders
// placed outside this process (the Binance UI) and a retried request that
// landed twice are invisible to us, so we sit below Binance's true total.
// The first bias errs toward throttling early rather than toward -1015; the
// second is what `observe` exists to correct.
//
// ORDERS is enforced over SEVERAL windows at once (spot publishes a 10-second
// and a 1-day row), and a reservation must fit in EVERY window, so this governor
// is multi-window where the weight governor is single-window.
//
// Limits are NOT hardcoded: they come from `exchangeInfo.rateLimits`, which
// differs by environment — live spot publishes 100/10s and 200000/1d, testnet
// publishes 50/10s and 160000/1d. A governor built with no windows is INERT
// (admits everything), which is the deliberate posture when limits cannot be
// read: invented numbers would be worse than none.
//
// Pure logic. Tests inject a `clock` and `sleep` so they advance time
// deterministically.

import { sleep as _defaultSleep } from '@app/core/sleep';

/** One Binance `ORDERS` row: a rolling window and the order count it admits. */
export interface OrderRateWindow {
  /** Window length in ms — 10_000 for SECOND/10, 86_400_000 for DAY/1. */
  readonly windowMs: number;
  /** Raw Binance limit for the window, before the utilisation haircut. */
  readonly limit: number;
}

export interface OrderRateGovernorOptions {
  /** The `ORDERS` rows from exchangeInfo. Empty ⇒ inert governor. */
  readonly windows: readonly OrderRateWindow[];
  /**
   * Lowercased response-header name → the window it reports on. Carried on the
   * governor rather than passed separately to the REST client so the two can
   * never desync: both come out of one `parseOrderRateLimits` call.
   */
  readonly headers?: ReadonlyMap<string, number>;
  /** Soft ceiling as a fraction of each window's limit; default 0.8. */
  readonly targetUtilisation?: number;
  /** Wall-clock source; tests inject a deterministic clock. */
  readonly clock?: { nowMs(): number };
  /** Sleep injected so tests can fast-forward without real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface OrderRateGovernor {
  /**
   * Block until `count` orders fit in EVERY window, then account them. For
   * order flow that must not be dropped — an exit or protective SELL. Getting
   * out late beats not getting out.
   *
   * Bounded: a CUMULATIVE wait longer than {@link MAX_RESERVE_WAIT_MS} throws
   * instead of sleeping it out. See that constant for why.
   */
  reserve(count: number, opts?: { signal?: AbortSignal | undefined }): Promise<void>;
  /**
   * Whether `count` orders fit in every window right now. A PEEK: it accounts
   * nothing, because every order is accounted exactly once, at the REST
   * admission point. Callers use it to decide whether to attempt order flow
   * that is an improvement rather than a necessity — re-pricing a resting stop,
   * where the existing order stays live and protective, so deferring a tick
   * beats blocking one.
   *
   * Inherently advisory: a concurrent reservation can consume the headroom
   * between the peek and the call. That downgrades a shed into a short block —
   * or, if what was lost was the last slot of a window too long to wait out,
   * into a pre-call refusal. Never into an over-admission, which is the only
   * direction that would cost a `-1015` ban.
   *
   * Total, unlike {@link OrderRateGovernor.reserve}: a `count` larger than a
   * window's whole ceiling answers `false` rather than throwing. A reservation
   * that can never be satisfied is a programming error worth surfacing; a peek
   * that can never be satisfied is just "no headroom", which is what the caller
   * already knows how to handle.
   */
  hasHeadroom(count: number): boolean;
  /**
   * Reconcile a window against Binance's authoritative count for it. Against
   * that total our tally is a LOWER bound: the operator may place orders in the
   * Binance UI, and a retried call may have landed without us seeing the
   * response. Tops the window up to `used` when we are behind, and never down
   * (see the header comment for why both bounds hold at once).
   * Unknown `windowMs` is ignored — an inert governor has nothing to reconcile.
   */
  observe(windowMs: number, used: number): void;
  /** Current rolling count in the given window; 0 for an unknown window. */
  used(windowMs: number): number;
  /** Post-haircut admission ceiling for the window; Infinity when unknown. */
  ceiling(windowMs: number): number;
  /** Response-header name → window, for reconciling a REST response. */
  readonly headerWindows: ReadonlyMap<string, number>;
}

const DEFAULT_UTILISATION = 0.8;

/**
 * Ceiling on the TOTAL time spent inside one {@link OrderRateGovernor.reserve}
 * call, measured from entry across every re-check.
 *
 * Each individual wait is "until the blocking window's oldest record ages out",
 * which for the DAY row is up to 24 hours. Sleeping that out would be the worst
 * available outcome: `reserve` is called from inside the tick's
 * per-(profile, symbol) chain, which is non-reentrant, so a parked reservation
 * stalls every later tick for that symbol behind it — no reconcile, no stop
 * re-price, no exit — with nothing surfaced to the operator. Throwing instead
 * turns it into an ordinary pre-call failure: the decision fails, the tick
 * ends, the alerting path runs, and the next tick re-emits the intent and
 * re-evaluates against a window that has since decayed.
 *
 * Cumulative rather than per-wait because the short windows would otherwise
 * escape the bound entirely: a 10-second window can never produce a single wait
 * over 60 seconds, so a per-wait check leaves it looping forever while an
 * operator placing orders by hand on the same UID keeps it saturated. There is
 * no queue and no fairness, so a waiter that keeps losing the re-check to a
 * sibling profile is starved with nothing to break it.
 */
export const MAX_RESERVE_WAIT_MS = 60_000;

/**
 * Thrown by {@link OrderRateGovernor.reserve} when the window it is waiting on
 * will not clear inside {@link MAX_RESERVE_WAIT_MS}.
 *
 * Its own type, not a bare `Error`, because the distinction is load-bearing at
 * the executor: this is refused BEFORE the request is signed, so the order
 * provably never reached Binance. A caller that cannot tell it apart from a
 * transport throw must assume the request may have landed and probe Binance to
 * find out, which for a placement can only ever resolve as `ambiguous` — the
 * worst outcome the executor can record. Typed, it is an ordinary retryable
 * pre-call refusal instead.
 */
export class OrderBudgetUnavailableError extends Error {
  readonly windowMs: number;
  readonly waitMs: number;

  constructor(windowMs: number, waitMs: number) {
    super(
      `OrderRateGovernor: ${windowMs}ms window is saturated for another ${waitMs}ms, which exceeds the ${MAX_RESERVE_WAIT_MS}ms reserve ceiling`,
    );
    this.name = 'OrderBudgetUnavailableError';
    this.windowMs = windowMs;
    this.waitMs = waitMs;
  }
}

interface WindowState {
  readonly windowMs: number;
  readonly ceiling: number;
  /** In-window records in insertion order, pruned lazily. */
  readonly records: { ts: number; count: number }[];
}

const UNIT_MS = new Map<string, number>([
  ['SECOND', 1_000],
  ['MINUTE', 60_000],
  ['HOUR', 3_600_000],
  ['DAY', 86_400_000],
]);

/**
 * Map a Binance `interval` / `intervalNum` pair to milliseconds, or `null` when
 * the pair is unrecognised. `parseOrderRateLimits` derives BOTH a window's key
 * and its response-header name from the same row, so an unmappable interval
 * must drop the whole row rather than yield a window no header can report on.
 */
export const intervalToMs = (interval: string, intervalNum: number): number | null => {
  // A Map, not an object literal: an object lookup walks the prototype chain, so
  // an interval named `constructor` or `toString` would resolve to an inherited
  // member instead of undefined and yield a NaN window that reads as mapped.
  const unit = UNIT_MS.get(interval);
  return unit === undefined || !Number.isFinite(intervalNum) || intervalNum <= 0
    ? null
    : unit * intervalNum;
};

/**
 * The response-header suffix Binance uses for a window: the interval count
 * followed by the lowercased first letter of the unit. Verified against the
 * live `REQUEST_WEIGHT MINUTE/1` row, which reports as `x-mbx-used-weight-1m`;
 * the `ORDERS SECOND/10` and `DAY/1` rows therefore report as
 * `x-mbx-order-count-10s` and `x-mbx-order-count-1d`.
 */
export const intervalSuffix = (interval: string, intervalNum: number): string =>
  `${intervalNum}${interval.charAt(0).toLowerCase()}`;

/** One `rateLimits` row as Binance publishes it in `/api/v3/exchangeInfo`. */
export interface RawRateLimit {
  readonly rateLimitType?: string;
  readonly interval?: string;
  readonly intervalNum?: number;
  readonly limit?: number;
}

export interface ParsedOrderRateLimits {
  /** Windows to build the governor with; empty ⇒ inert. */
  readonly windows: readonly OrderRateWindow[];
  /** Lowercased response-header name → the window it reports on. */
  readonly headers: ReadonlyMap<string, number>;
}

/**
 * Project the `ORDERS` rows out of an exchangeInfo `rateLimits` array into the
 * governor's windows plus the response headers that report them. Rows of any
 * other `rateLimitType`, and rows with an interval this code cannot map, are
 * skipped — an unrecognised row must not silently become an unbounded window.
 *
 * Returns empty on a missing / malformed array, which builds an INERT governor.
 * That is deliberate: no accounting is safer than accounting against numbers we
 * invented, and the live and testnet limits genuinely differ.
 */
export const parseOrderRateLimits = (rateLimits: unknown): ParsedOrderRateLimits => {
  const windows: OrderRateWindow[] = [];
  const headers = new Map<string, number>();
  if (!Array.isArray(rateLimits)) return { windows, headers };
  for (const row of rateLimits as readonly RawRateLimit[]) {
    if (row?.rateLimitType !== 'ORDERS') continue;
    const { interval, intervalNum, limit } = row;
    if (typeof interval !== 'string' || typeof intervalNum !== 'number') continue;
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) continue;
    const windowMs = intervalToMs(interval, intervalNum);
    if (windowMs === null) continue;
    windows.push({ windowMs, limit });
    headers.set(`x-mbx-order-count-${intervalSuffix(interval, intervalNum)}`, windowMs);
  }
  return { windows, headers };
};

export const createOrderRateGovernor = (opts: OrderRateGovernorOptions): OrderRateGovernor => {
  const utilisation = opts.targetUtilisation ?? DEFAULT_UTILISATION;
  if (!Number.isFinite(utilisation) || utilisation <= 0 || utilisation > 1) {
    throw new Error(
      `OrderRateGovernor: targetUtilisation must be in (0, 1], got ${String(utilisation)}`,
    );
  }
  const clock = opts.clock ?? { nowMs: () => Date.now() };
  const sleep = opts.sleep ?? _defaultSleep;

  const windows = new Map<number, WindowState>();
  for (const w of opts.windows) {
    if (!Number.isFinite(w.windowMs) || w.windowMs <= 0) {
      throw new Error(`OrderRateGovernor: windowMs must be positive, got ${String(w.windowMs)}`);
    }
    if (!Number.isFinite(w.limit) || w.limit <= 0) {
      throw new Error(`OrderRateGovernor: limit must be positive, got ${String(w.limit)}`);
    }
    // Floor, so the haircut can never round a small limit UP past the real one.
    // A limit small enough to floor to 0 would deadlock every reservation, so
    // it clamps to 1 — still below the real limit, and still forward progress.
    const ceiling = Math.max(1, Math.floor(w.limit * utilisation));
    windows.set(w.windowMs, { windowMs: w.windowMs, ceiling, records: [] });
  }

  const usedIn = (w: WindowState, now: number): number => {
    const horizon = now - w.windowMs;
    while (w.records.length > 0 && (w.records[0] as { ts: number }).ts <= horizon) {
      w.records.shift();
    }
    let total = 0;
    for (const r of w.records) total += r.count;
    return total;
  };

  /** The first window that cannot admit `count`, or null when all can. */
  const blockingWindow = (count: number, now: number): WindowState | null => {
    for (const w of windows.values()) {
      if (usedIn(w, now) + count > w.ceiling) return w;
    }
    return null;
  };

  const commit = (count: number, now: number): void => {
    for (const w of windows.values()) w.records.push({ ts: now, count });
  };

  const requirePositive = (count: number): void => {
    if (!Number.isFinite(count) || count <= 0) {
      throw new Error(`OrderRateGovernor: count must be positive, got ${String(count)}`);
    }
  };

  /** The first window whose whole ceiling is below `count`, or null when none is. */
  const unsatisfiableWindow = (count: number): WindowState | null => {
    for (const w of windows.values()) {
      if (count > w.ceiling) return w;
    }
    return null;
  };

  return {
    headerWindows: opts.headers ?? new Map<string, number>(),
    used: (windowMs) => {
      const w = windows.get(windowMs);
      return w === undefined ? 0 : usedIn(w, clock.nowMs());
    },
    ceiling: (windowMs) => windows.get(windowMs)?.ceiling ?? Number.POSITIVE_INFINITY,

    observe: (windowMs, used) => {
      const w = windows.get(windowMs);
      if (w === undefined || !Number.isFinite(used) || used < 0) return;
      const now = clock.nowMs();
      const local = usedIn(w, now);
      // Only ever top UP. A lower reading has several innocent causes: our own
      // reservation is accounted before the request lands, Binance counts
      // UNFILLED orders so a fill decrements theirs and not ours, and their
      // windows are fixed intervals that reset on a boundary while ours roll.
      // Trusting any of them would let a burst double-spend our window, and the
      // rolling model is deliberately the conservative side of that trade: it
      // admits at most the ceiling in ANY window-length span, where a fixed
      // window admits up to twice that across a boundary.
      if (used > local) w.records.push({ ts: now, count: used - local });
    },

    hasHeadroom: (count) => {
      requirePositive(count);
      return unsatisfiableWindow(count) === null && blockingWindow(count, clock.nowMs()) === null;
    },

    async reserve(count, reserveOpts) {
      requirePositive(count);
      const unsatisfiable = unsatisfiableWindow(count);
      if (unsatisfiable) {
        throw new Error(
          `OrderRateGovernor: count ${count} exceeds ceiling ${unsatisfiable.ceiling} for ${unsatisfiable.windowMs}ms window`,
        );
      }
      const signal = reserveOpts?.signal;
      // `throwIfAborted` surfaces the caller's own abort reason (a REST timeout
      // carries a TimeoutError), which a hand-rolled Error would erase.
      signal?.throwIfAborted();

      const deadline = clock.nowMs() + MAX_RESERVE_WAIT_MS;

      while (true) {
        const now = clock.nowMs();
        const blocked = blockingWindow(count, now);
        if (blocked === null) {
          commit(count, now);
          return;
        }
        // Wait until the blocking window's oldest record falls off, then
        // re-check: another window may bind next, or a concurrent reservation
        // may have landed in the meantime.
        const oldest = blocked.records[0];
        /* v8 ignore start -- reason: blockingWindow only returns a window whose in-window total exceeds the ceiling, which requires at least one record; the guard exists for noUncheckedIndexedAccess narrowing */
        if (!oldest) {
          commit(count, now);
          return;
        }
        /* v8 ignore stop -- reason: end of the unreachable empty-ring guard above */
        const waitMs = Math.max(1, oldest.ts + blocked.windowMs - now);
        // Against the wake time, not the sleep length: a short window's every
        // wait is short, so only the running total can bound it.
        if (now + waitMs > deadline) {
          throw new OrderBudgetUnavailableError(blocked.windowMs, waitMs);
        }
        if (signal) {
          let rejectAbort: (() => void) | undefined;
          const aborted = new Promise<void>((_, reject) => {
            // `signal.reason`, never a fresh Error: the caller's reason carries
            // WHY (a REST timeout arrives as a TimeoutError) and replacing it
            // erases that. No fallback needed — aborting always sets a reason,
            // defaulting to an AbortError DOMException when none is passed.
            rejectAbort = () => reject(signal.reason);
            signal.addEventListener('abort', rejectAbort, { once: true });
          });
          try {
            await Promise.race([sleep(waitMs), aborted]);
          } finally {
            /* v8 ignore start -- reason: the Promise executor runs synchronously and assigns rejectAbort before this finally, so it is always defined here */
            if (rejectAbort) signal.removeEventListener('abort', rejectAbort);
            /* v8 ignore stop -- reason: end of the unreachable rejectAbort-undefined guard above */
          }
        } else {
          await sleep(waitMs);
        }
      }
    },
  };
};
