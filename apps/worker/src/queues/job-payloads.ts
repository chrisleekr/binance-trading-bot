// Strongly-typed payloads for the queues whose jobs actually carry one.
// Workers import these; the EventRouter and crons import them too for
// symmetric typing. Crons are payload-less self-rescheduling repeatable jobs,
// so they have no entry here — add one only when a job gains real payload.

import type { AdvisorVariant } from '@app/contracts';

export type TickEvent =
  'mini-ticker' | 'kline-close' | 'execution-report' | 'balance-update' | 'resync';

export interface TickJobData {
  readonly userId: string;
  readonly accountId: string;
  readonly profileId: string;
  readonly symbol: string;
  readonly event: TickEvent;
  readonly enqueuedAtMs: number;
  readonly payload: Record<string, unknown>;
}

/**
 * Why a symbol's position is suspected of drifting from exchange truth. Carried
 * on the job purely for traceability — the handler's work is the same converge
 * pass whatever caused it — so an operator reading a reconcile in the logs can
 * tell "a cancel raced a fill" apart from "the stream went quiet".
 */
export type SymbolReconcileCause = 'cancel-2011-fill' | 'place-2010-insufficient' | 'stream-silent';

/**
 * One converge-to-exchange-truth pass for a single (profile, symbol).
 *
 * No `operatorId`: the handler resolves it from the active-profile set, which
 * doubles as the "this profile is no longer active ⇒ nothing to reconcile" gate.
 * Passing one on the payload would let a stale job reconcile a profile that has
 * since been disabled or deleted.
 */
export interface SymbolReconcileJobData {
  readonly accountId: string;
  readonly profileId: string;
  readonly symbol: string;
  readonly cause: SymbolReconcileCause;
}

const RECONCILE_CAUSES: ReadonlySet<string> = new Set<SymbolReconcileCause>([
  'cancel-2011-fill',
  'place-2010-insufficient',
  'stream-silent',
]);

/** Structural guard for a `reconcile-symbol` payload; `null` on anything malformed. */
export const parseSymbolReconcileJob = (data: unknown): SymbolReconcileJobData | null => {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (
    typeof d['accountId'] !== 'string' ||
    typeof d['profileId'] !== 'string' ||
    typeof d['symbol'] !== 'string' ||
    typeof d['cause'] !== 'string' ||
    !RECONCILE_CAUSES.has(d['cause'])
  ) {
    return null;
  }
  return {
    accountId: d['accountId'],
    profileId: d['profileId'],
    symbol: d['symbol'],
    cause: d['cause'] as SymbolReconcileCause,
  };
};

// No payload data — the refresh fetches Binance's full exchangeInfo
// snapshot. Modelled as an empty object (rather than `void`) so
// `Job<ExchangeInfoRefreshJobData>` types cleanly in BullMQ.
export type ExchangeInfoRefreshJobData = Record<string, never>;

export interface ActionLogPruneJobData {
  readonly isoDate: string;
}

export interface AuditPruneJobData {
  readonly isoDate: string;
}

export interface DiscoverySnapshotPruneJobData {
  readonly isoDate: string;
}

export interface EquitySnapshotPruneJobData {
  readonly isoDate: string;
}

export interface DlqJobData {
  readonly fromQueue: string;
  readonly fromJobId: string;
  readonly reason: string;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly stack?: string;
  readonly originalData: unknown;
  readonly userId?: string;
  readonly profileId?: string;
}

export interface BacktestJobData {
  readonly runId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly profileId: string;
}

// One background advisor generation for a (run, variant). The api enqueues with
// NO jobId — the `backtest_advisor_result` row's conditional transition to
// `running` is the single-flight guard, so a duplicate enqueue for an in-flight
// variant is a noop at the DB, not at the queue. `variant` is never 'manual':
// the manual slot is written synchronously by the api with no queue.
export interface AdvisorJobData {
  readonly runId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly profileId: string;
  readonly variant: AdvisorVariant;
}

/**
 * One "why isn't this profile trading?" investigation.
 *
 * `liveProbe` carries the operator's choice rather than being decided in the
 * worker: re-deriving the funnel against Binance spends per-account request
 * weight, and who pays a cost belongs with whoever asked for it. The worker may
 * still fall back to stored snapshots when the probe fails, and says so.
 */
export interface DiagnosisJobData {
  readonly runId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly profileId: string;
  readonly liveProbe: boolean;
}
