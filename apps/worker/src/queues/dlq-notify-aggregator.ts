// Burst-aggregating notifier for dead-lettered jobs.
//
// A systemic failure (Postgres or Redis briefly unreachable) fails the tick job
// for EVERY (profile, symbol) at once. The old per-job throttle keyed on the raw
// error message, but a Drizzle query error embeds the per-symbol query params
// (`params: <profileId>,<SYMBOL>,1`), so every symbol produced a distinct key and
// the dedup never fired — the operator got one Slack message per symbol per
// cycle, a storm.
//
// This groups failures by ERROR CLASS (the message with volatile params/ids
// stripped) and debounces a burst into ONE notification carrying the count:
// "84 tick jobs failed: <class>". After emitting, a per-class cooldown suppresses
// further alerts (still counting them) so a persistent outage alerts at most once
// per cooldown, not once per failure. persist + publish stay per-job upstream —
// no DLQ data is ever dropped; only the operator notification is grouped.

import type { DlqJobData } from './job-payloads.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Stable per-incident key: `<queue>  <error class>`. Drops the ORM's `params:`
 * tail (which carries the symbol + ids) and collapses UUIDs, so the same failure
 * across every symbol maps to ONE key. Bounded length keeps the key-map small.
 */
export const dlqErrorClassKey = (data: DlqJobData): string => {
  const raw = data.errorName ? `${data.errorName}: ${data.errorMessage}` : data.errorMessage;
  // Drop Drizzle's per-call `\nparams: ...` tail (the volatile symbol + ids).
  const [head = raw] = raw.split('\nparams:');
  const normalized = head.replace(UUID_RE, '<id>').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `${data.fromQueue}  ${normalized}`;
};

/** One grouped incident handed to {@link DlqNotifyAggregatorDeps.emit}. */
export interface DlqGroup {
  /** Normalized class key ({@link dlqErrorClassKey}). */
  readonly key: string;
  /** Failures collected in this burst (≥ 1). */
  readonly count: number;
  /** A representative failure — its queue/error/jobId illustrate the group. */
  readonly sample: DlqJobData;
}

/** Cancelable timer handle so tests can drive flushes deterministically. */
export interface TimerHandle {
  clear(): void;
}

export interface DlqNotifyAggregatorDeps {
  /** Collect a burst this long before emitting, so a storm folds into one alert. */
  readonly debounceMs: number;
  /** After an emit, suppress further alerts for the same class this long. */
  readonly cooldownMs: number;
  readonly nowMs: () => number;
  /** Injected scheduler (production: `setTimeout`); lets tests fire flushes by hand. */
  readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  /** Send the grouped notification. MUST NOT throw (a notifier outage cannot re-fail the DLQ). */
  readonly emit: (group: DlqGroup) => void;
}

export interface DlqNotifyAggregator {
  /** Feed one dead-lettered job. Never throws; scheduling/emit are decoupled from the caller. */
  record(data: DlqJobData): void;
  /** Clear pending timers (drain / hot-reload). */
  stop(): void;
}

interface ClassState {
  count: number;
  sample: DlqJobData;
  timer: TimerHandle | null;
  /** Wall-clock before which a new burst does not re-arm (post-emit cooldown). */
  coolingUntil: number;
}

export const createDlqNotifyAggregator = (deps: DlqNotifyAggregatorDeps): DlqNotifyAggregator => {
  const classes = new Map<string, ClassState>();

  const flush = (key: string): void => {
    const s = classes.get(key);
    if (!s) return;
    s.timer = null;
    // Defensive: a fired timer is always armed off a count>=1 record, so this is
    // belt-and-suspenders (e.g. against a future re-entrancy change).
    if (s.count === 0) return;
    const group: DlqGroup = { key, count: s.count, sample: s.sample };
    s.count = 0;
    s.coolingUntil = deps.nowMs() + deps.cooldownMs;
    deps.emit(group);
  };

  return {
    record(data) {
      const key = dlqErrorClassKey(data);
      const now = deps.nowMs();
      const s = classes.get(key) ?? { count: 0, sample: data, timer: null, coolingUntil: 0 };
      s.count += 1;
      s.sample = data;
      // Always ensure the bucket drains, so no incident is silently swallowed.
      // Healthy: debounce a burst into one alert. Mid-cooldown: arm a catch-up
      // timer for the REMAINING cooldown so the accumulated count still flushes
      // at cooldown expiry (at most one alert per cooldown) rather than being
      // stranded until some later same-class failure happens to re-arm it.
      if (s.timer === null) {
        const delay = now >= s.coolingUntil ? deps.debounceMs : s.coolingUntil - now;
        s.timer = deps.setTimer(() => flush(key), delay);
      }
      classes.set(key, s);
    },
    stop() {
      for (const s of classes.values()) {
        s.timer?.clear();
        s.timer = null;
      }
    },
  };
};
