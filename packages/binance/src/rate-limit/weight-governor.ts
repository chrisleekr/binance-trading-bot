// Central per-IP Binance weight governor.
//
// Every REST call into Binance consumes weight against a per-IP budget
// (spot REST limit = 6000/min; the `budget` option sets the cap and defaults
// to a conservative 1200). When the rolling 60-second sum of outstanding
// weight approaches the budget, callers must wait rather than 429 — which
// knocks the bot offline until the soft window resets.
//
// `reserve(cost, opts?)` is the single point of admission. Callers
// declare the cost they're about to spend (per the Binance docs), the
// governor accounts it into the rolling window, and the call proceeds
// once the in-window total leaves enough headroom. The governor never
// makes a call — it only schedules.
//
// Pure logic. Tests inject a `clock` and `sleep` so they advance time
// deterministically.

import { sleep as _defaultSleep } from '@app/core/sleep';

export interface ReserveOptions {
  /**
   * Abort the reservation — a waiting reserve rejects with
   * `'WeightGovernor: aborted'`.
   */
  readonly signal?: AbortSignal;
  /**
   * Order placement/cancellation. A priority reservation admits against the
   * full `ceiling`, ahead of the reserved-headroom band that bulk reads (the
   * discovery / technicals crons) leave free — so an urgent protective SELL is
   * not stalled up to ~60s behind a cron weight burst near the ceiling. Still
   * bounded by the real per-IP budget: priority reorders within the budget, it
   * does not raise it.
   */
  readonly priority?: boolean;
}

export interface WeightGovernor {
  /**
   * Block until at least `cost` weight is available within the rolling
   * 60-second window, then account the cost. `opts.signal` aborts a waiting
   * reservation; `opts.priority` admits against the full ceiling (see
   * {@link ReserveOptions}).
   */
  reserve(cost: number, opts?: ReserveOptions): Promise<void>;
  /** Current rolling usage in the last 60 seconds. */
  used(): number;
  /** Configured budget ceiling (post-utilisation cap). */
  ceiling(): number;
}

export interface WeightGovernorOptions {
  /** Per-IP weight budget. Default 1200 (conservative); Binance's real spot REST limit is 6000/min. */
  readonly budget?: number;
  /** Soft ceiling as a fraction of `budget`; default 0.8. */
  readonly targetUtilisation?: number;
  /**
   * Weight kept free at the top of the window for priority (order)
   * reservations: non-priority callers admit against `ceiling - orderReserve`,
   * priority callers against the full `ceiling`. Default 0 (band off — every
   * caller uses the full ceiling, identical to having no priority lane). The
   * production governor opts in (e.g. 8 — above the 2-weight place+cancel pair,
   * well below an 80-weight bulk read). Must be in `[0, ceiling)`, so a tiny
   * test budget that doesn't ask for a band is unaffected.
   */
  readonly orderReserve?: number;
  /** Wall-clock source; tests inject a deterministic clock. */
  readonly clock?: { nowMs(): number };
  /** Sleep injected so tests can fast-forward time without real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export const WINDOW_MS = 60_000;

const DEFAULT_BUDGET = 1200;
const DEFAULT_UTILISATION = 0.8;
// Band off by default; the production governor opts in (see WeightGovernorOptions).
const DEFAULT_ORDER_RESERVE = 0;

/**
 * Validated, defaulted governor config. Shared by the in-process and the
 * Redis-backed governor so the budget / utilisation / orderReserve rules
 * live in exactly one place.
 */
export interface ResolvedWeightGovernorConfig {
  readonly budget: number;
  readonly ceiling: number;
  readonly orderReserve: number;
  readonly clock: { nowMs(): number };
  readonly sleep: (ms: number) => Promise<void>;
}

/** Resolve defaults and validate the governor options; throws on invalid input. */
export const resolveWeightGovernorConfig = (
  opts: WeightGovernorOptions = {},
): ResolvedWeightGovernorConfig => {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const utilisation = opts.targetUtilisation ?? DEFAULT_UTILISATION;
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error(`WeightGovernor: budget must be positive, got ${String(budget)}`);
  }
  if (!Number.isFinite(utilisation) || utilisation <= 0 || utilisation > 1) {
    throw new Error(
      `WeightGovernor: targetUtilisation must be in (0, 1], got ${String(utilisation)}`,
    );
  }
  const ceiling = Math.floor(budget * utilisation);
  const orderReserve = opts.orderReserve ?? DEFAULT_ORDER_RESERVE;
  if (!Number.isFinite(orderReserve) || orderReserve < 0 || orderReserve >= ceiling) {
    throw new Error(
      `WeightGovernor: orderReserve must be in [0, ceiling=${ceiling}), got ${String(orderReserve)}`,
    );
  }
  const clock = opts.clock ?? { nowMs: () => Date.now() };
  const sleep = opts.sleep ?? _defaultSleep;
  return { budget, ceiling, orderReserve, clock, sleep };
};

/**
 * Admission ceiling for one call. Orders (priority) admit against the full
 * ceiling; bulk reads leave the top `orderReserve` band free — unless a single
 * bulk call is itself larger than that band, in which case it falls back to the
 * full ceiling so it can never deadlock.
 */
export const computeAdmissionLimit = (
  ceiling: number,
  orderReserve: number,
  cost: number,
  priority: boolean,
): number => (priority || cost > ceiling - orderReserve ? ceiling : ceiling - orderReserve);

export const createWeightGovernor = (opts: WeightGovernorOptions = {}): WeightGovernor => {
  const { budget, ceiling, orderReserve, clock, sleep } = resolveWeightGovernorConfig(opts);

  // Ring of in-window records — kept in insertion order. Old entries
  // are pruned lazily on every `reserve` to stay O(1) amortised.
  const records: { ts: number; cost: number }[] = [];

  const prune = (now: number): void => {
    const horizon = now - WINDOW_MS;
    while (records.length > 0 && (records[0] as { ts: number }).ts <= horizon) {
      records.shift();
    }
  };

  const usedNow = (now: number): number => {
    prune(now);
    let total = 0;
    for (const r of records) total += r.cost;
    return total;
  };

  return {
    used: () => usedNow(clock.nowMs()),
    ceiling: () => ceiling,
    async reserve(cost, opts) {
      const signal = opts?.signal;
      const priority = opts?.priority ?? false;
      if (!Number.isFinite(cost) || cost < 0) {
        throw new Error(`WeightGovernor: cost must be non-negative, got ${String(cost)}`);
      }
      if (cost > ceiling) {
        throw new Error(
          `WeightGovernor: cost ${cost} exceeds soft ceiling ${ceiling} (budget=${budget})`,
        );
      }
      if (signal?.aborted) {
        throw new Error('WeightGovernor: aborted');
      }
      // Admission limit: priority (order) calls use the full ceiling; bulk
      // reads use `ceiling - orderReserve`, leaving the top band free for an
      // order. A single bulk call larger than that band falls back to the full
      // ceiling (it is still within the real budget) so it can never deadlock.
      const limit = computeAdmissionLimit(ceiling, orderReserve, cost, priority);
      // Loop until there is enough headroom. Each iteration waits at
      // most until the oldest in-window record falls off the rolling
      // window, then re-checks usage (other reservations may have
      // landed in the meantime).

      while (true) {
        const now = clock.nowMs();
        const used = usedNow(now);
        if (used + cost <= limit) {
          records.push({ ts: now, cost });
          return;
        }
        const oldest = records[0];
        // `usedNow` pruned already, so an empty ring here is unreachable
        // given used > 0; the guard satisfies the type-narrowing.
        /* v8 ignore start -- reason: reaching here requires used > 0, which means the ring is non-empty, so records[0] is always defined; guard exists only for noUncheckedIndexedAccess narrowing */
        if (!oldest) {
          records.push({ ts: now, cost });
          return;
        }
        /* v8 ignore stop -- reason: end of the unreachable empty-ring guard above */
        const waitMs = Math.max(1, oldest.ts + WINDOW_MS - now);
        if (signal) {
          let rejectAbort: (() => void) | undefined;
          const aborted = new Promise<void>((_, reject) => {
            rejectAbort = () => reject(new Error('WeightGovernor: aborted'));
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
