// Typed audit-event surface for the trailing-trade strategy.
//
// The strategy emits stable `tt-*` LogEntry messages; dashboards scrape those
// by name. This module turns the same information into a typed discriminated
// union (`TTAuditEvent`), and `extractTTAudit` — TT's `Strategy.extractAudit`
// implementation — narrows it into the block the worker merges into a tick's
// audit payload. The worker never inspects the union: it used to keep a
// structural mirror of these interfaces, so a renamed field degraded silently
// to `undefined`. Owning the narrowing here makes that a compile error.
//
// Scope is intentionally minimal: only `technicals-gate-veto` and
// `technicals-force-sell` have an active consumer. The other 18 `tt-*`
// messages remain on the `logs` channel for pino/dashboards; future variants
// can join this union when a typed consumer needs them. Logs are NOT removed —
// they stay for dashboard/Datadog filters and the golden-fixture replay diff.

import type { LogEntry } from '@app/strategy-core';

/**
 * Per-interval verdict snapshot the technicals-gate veto event carries.
 * Mirrors the worker's `AuditIntervalConsultation` shape so the worker
 * extractor can pass the array through unchanged.
 */
export interface TTIntervalConsultation {
  readonly interval: string;
  readonly recommendation: string | null;
  readonly verdict: string;
  // Absent on pre-advisory-mode logs; the dashboard treats missing as false.
  readonly advisory?: boolean;
}

/**
 * Technicals gate vetoed a buy this tick. Mirrors the context shape of
 * the `tt-technicals-gate-veto` LogEntry. Optional fields are present
 * when the underlying veto reason carries them.
 */
export interface TTAuditEventTechnicalsGateVeto {
  readonly kind: 'technicals-gate-veto';
  readonly reason: string;
  readonly interval: string;
  readonly recommendation?: string;
  readonly ageMs?: number;
  readonly useOnlyWithinMin?: number;
  readonly ifExpires?: string;
  readonly intervalsConsulted?: readonly TTIntervalConsultation[];
}

/**
 * Technicals fired a force-sell this tick. Mirrors the context shape of
 * the `tt-technicals-force-sell` LogEntry. `ifExpires` is NOT carried on
 * this branch — it is a buy-side-only stance.
 */
export interface TTAuditEventTechnicalsForceSell {
  readonly kind: 'technicals-force-sell';
  readonly interval: string;
  readonly recommendation: string;
  readonly ageMs?: number;
  readonly useOnlyWithinMin?: number;
}

/**
 * Discriminated audit-event union. New variants land here as their
 * consumers materialise. Consumers narrow via `kind`:
 *
 *   const veto = events.find((e): e is TTAuditEventTechnicalsGateVeto =>
 *     e.kind === 'technicals-gate-veto');
 */
export type TTAuditEvent = TTAuditEventTechnicalsGateVeto | TTAuditEventTechnicalsForceSell;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;

const pickString = (rec: Record<string, unknown> | null, key: string): string | undefined => {
  const v = rec?.[key];
  return typeof v === 'string' ? v : undefined;
};

const pickNumber = (rec: Record<string, unknown> | null, key: string): number | undefined => {
  const v = rec?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

const pickIntervalsConsulted = (
  rec: Record<string, unknown> | null,
): readonly TTIntervalConsultation[] | undefined => {
  const raw = rec?.['intervalsConsulted'];
  if (!Array.isArray(raw)) return undefined;
  const out: TTIntervalConsultation[] = [];
  for (const row of raw) {
    const r = asRecord(row);
    const interval = pickString(r, 'interval');
    const verdict = pickString(r, 'verdict');
    if (interval === undefined || verdict === undefined) continue;
    const recommendation = pickString(r, 'recommendation') ?? null;
    const advisoryRaw = r?.['advisory'];
    const advisory = typeof advisoryRaw === 'boolean' ? advisoryRaw : undefined;
    out.push(
      advisory === undefined
        ? { interval, recommendation, verdict }
        : { interval, recommendation, verdict, advisory },
    );
  }
  return out.length > 0 ? out : undefined;
};

const mapVetoLog = (context: unknown): TTAuditEventTechnicalsGateVeto | null => {
  const ctx = asRecord(context);
  const reason = pickString(ctx, 'reason');
  const interval = pickString(ctx, 'interval');
  if (reason === undefined || interval === undefined) return null;
  const recommendation = pickString(ctx, 'recommendation');
  const ageMs = pickNumber(ctx, 'ageMs');
  const useOnlyWithinMin = pickNumber(ctx, 'useOnlyWithinMin');
  const ifExpires = pickString(ctx, 'ifExpires');
  const intervalsConsulted = pickIntervalsConsulted(ctx);
  // exactOptionalPropertyTypes: build the optional-field bag piecewise so
  // undefined is not serialised onto the union member.
  return {
    kind: 'technicals-gate-veto',
    reason,
    interval,
    ...(recommendation !== undefined && { recommendation }),
    ...(ageMs !== undefined && { ageMs }),
    ...(useOnlyWithinMin !== undefined && { useOnlyWithinMin }),
    ...(ifExpires !== undefined && { ifExpires }),
    ...(intervalsConsulted !== undefined && { intervalsConsulted }),
  };
};

const mapForceSellLog = (context: unknown): TTAuditEventTechnicalsForceSell | null => {
  const ctx = asRecord(context);
  const interval = pickString(ctx, 'interval');
  const recommendation = pickString(ctx, 'recommendation');
  if (interval === undefined || recommendation === undefined) return null;
  const ageMs = pickNumber(ctx, 'ageMs');
  const useOnlyWithinMin = pickNumber(ctx, 'useOnlyWithinMin');
  return {
    kind: 'technicals-force-sell',
    interval,
    recommendation,
    ...(ageMs !== undefined && { ageMs }),
    ...(useOnlyWithinMin !== undefined && { useOnlyWithinMin }),
  };
};

/**
 * Derive the typed audit-event slice from the strategy's emitted logs.
 * Pure: no I/O, no allocations beyond the returned array. Logs the
 * extractor doesn't recognise are silently dropped — they remain
 * available on `output.logs` for pino/dashboards.
 *
 * Returns an empty array when no recognised event fired this tick;
 * `trailingTrade.tick` omits the `events` field altogether in that
 * common case so the output stays compact.
 */
export const extractAuditEvents = (logs: readonly LogEntry[]): readonly TTAuditEvent[] => {
  const events: TTAuditEvent[] = [];
  for (const log of logs) {
    if (log.message === 'tt-technicals-gate-veto') {
      const e = mapVetoLog(log.context);
      if (e !== null) events.push(e);
    } else if (log.message === 'tt-technicals-force-sell') {
      const e = mapForceSellLog(log.context);
      if (e !== null) events.push(e);
    }
  }
  return events;
};

/**
 * Audit block trailing-trade contributes to a tick's audit-log payload. Only
 * `forceSell` is surfaced: the "why did we force-sell" answer is otherwise
 * buried in pino. Buy-gate vetoes are deliberately absent — that "why no buy"
 * answer rides the on-change `entry-blocker` action_log, not a per-tick row.
 */
// A type alias, not an interface: `Strategy.extractAudit` returns
// `Readonly<Record<string, unknown>>`, and only type aliases pick up the
// implicit index signature that makes them assignable to it.
export type TTAuditBlock = {
  readonly technicals: {
    readonly forceSell: {
      readonly interval: string;
      readonly recommendation: string;
      readonly ageMs?: number;
      readonly useOnlyWithinMin?: number;
    };
  };
};

/**
 * `Strategy.extractAudit` for trailing-trade. Narrows this strategy's own
 * `TickOutput.events` slice by the `kind` discriminant — no structural guards,
 * because here `TTAuditEvent` is the real type rather than a mirror of it.
 *
 * Returns `undefined` on the dominant pure-path tick so the audit payload stays
 * small. Takes the first force-sell; a strategy emits at most one per tick.
 */
export const extractTTAudit = (events: readonly unknown[]): TTAuditBlock | undefined => {
  // `events` is `unknown[]` at the core contract; the worker only ever hands a
  // strategy back its own slice, so narrowing by `kind` is sound here.
  const forceSell = events.find(
    (e): e is TTAuditEventTechnicalsForceSell =>
      (e as TTAuditEvent | undefined)?.kind === 'technicals-force-sell',
  );
  if (!forceSell) return undefined;
  return {
    technicals: {
      forceSell: {
        interval: forceSell.interval,
        recommendation: forceSell.recommendation,
        ...(forceSell.ageMs !== undefined && { ageMs: forceSell.ageMs }),
        ...(forceSell.useOnlyWithinMin !== undefined && {
          useOnlyWithinMin: forceSell.useOnlyWithinMin,
        }),
      },
    },
  };
};
