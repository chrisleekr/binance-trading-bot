// Maps drained audit entries to operator-visible `action_logs` rows.
//
// The audit stream carries ONE entry per tick per symbol, the vast majority of
// which are noops (the strategy looked and did nothing). Persisting every one
// would bury the activity feed and cost gigabytes a month, so in steady state
// only actionable entries become rows: a tick that placed or cancelled an
// order, or one whose technicals gate fired (a veto / force-sell context).
//
// DEEP CAPTURE inverts that for one profile at a time. While the operator has
// armed it, every tick of that profile becomes a row carrying the WHOLE audit
// payload, which is what makes "why did nothing happen at 14:32" answerable
// after the fact. It is bounded by its own expiry rather than by retention, so
// the volume it costs is the volume the operator explicitly asked for.
//
// Either way a tick produces at most one row: under capture an actionable tick
// keeps its info/warn level and summary line and merely gains the full context,
// rather than being duplicated as a second debug row.

import type { ActionLogInsert } from '@app/db';
import type { AuditEntry } from './audit-shipper.js';

const ORDER_ACTIONS = new Set(['place-order', 'cancel-order']);

/** Whether the audit payload's technicals block recorded a force-sell (not just a buy-gate veto). */
const hasForceSell = (e: AuditEntry): boolean => {
  const t = e.payload['technicals'];
  return (
    typeof t === 'object' && t !== null && (t as Record<string, unknown>)['forceSell'] !== undefined
  );
};

/**
 * Whether an audit entry represents operator-visible activity worth a feed row:
 * an actual order action, or a technicals force-sell.
 *
 * Buy-gate vetoes (the `technicals.veto` block) used to qualify here too, which
 * made EVERY gate-veto tick a row — per-tick spam that buried the feed. That
 * "why no buy" answer now rides the on-change `entry-blocker` action_log written
 * in build-tick-input (one row per reason transition, not one per tick), so the
 * blanket `technicals !== undefined` clause is narrowed to force-sell only. A
 * force-sell always co-emits a SELL `place-order` (so the order clause already
 * keeps it); the explicit `hasForceSell` is belt-and-braces against a future
 * force-sell path that does not place an order in the same tick.
 */
export const isActionableAudit = (e: AuditEntry): boolean =>
  e.decisionTypes.some((t) => ORDER_ACTIONS.has(t)) || hasForceSell(e);

/** Per-decision outcome the executor recorded (tick-handler stamps this onto the audit payload). */
interface OrderResult {
  readonly type: string;
  readonly ok: boolean;
  /** Present on failures only (the `DecisionResult` failure arm carries it). */
  readonly reason?: string;
}

/** Cap the reason folded into the feed line so one Binance error cannot bury the row. */
const MAX_REASON_LEN = 120;

/**
 * WHY the first failed order action failed, if it said. A failure with no reason
 * is not an error — `DecisionResult` allows it and the malformed-payload path
 * produces it — so the caller must stay readable without one.
 */
const firstFailureReason = (results: readonly OrderResult[]): string | null => {
  const failed = results.find((r) => ORDER_ACTIONS.has(r.type) && !r.ok);
  const reason = failed?.reason;
  if (typeof reason !== 'string' || reason === '') return null;
  return reason.length > MAX_REASON_LEN ? `${reason.slice(0, MAX_REASON_LEN - 1)}…` : reason;
};

/**
 * The executor's per-decision outcomes from the audit payload. The summary
 * counts what actually happened (ok results) rather than what the strategy
 * emitted, so a tick whose cancel wedged or whose place failed bookkeeping is
 * not logged as a success. Defensive: an entry without a well-formed
 * `results` array yields no counts rather than throwing.
 */
const readOrderResults = (e: AuditEntry): OrderResult[] => {
  const raw = e.payload['results'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (x): x is OrderResult =>
      typeof x === 'object' &&
      x !== null &&
      typeof (x as { type?: unknown }).type === 'string' &&
      typeof (x as { ok?: unknown }).ok === 'boolean',
  );
};

interface OrderTally {
  readonly placed: number;
  readonly cancelled: number;
  readonly failed: number;
}

const tallyOrders = (results: readonly OrderResult[]): OrderTally => ({
  placed: results.filter((r) => r.type === 'place-order' && r.ok).length,
  cancelled: results.filter((r) => r.type === 'cancel-order' && r.ok).length,
  failed: results.filter((r) => ORDER_ACTIONS.has(r.type) && !r.ok).length,
});

/** One plain-language summary line for the feed. Specifics ride in `ctx`. */
const summarise = (e: AuditEntry, results: readonly OrderResult[]): string => {
  const { placed, cancelled, failed } = tallyOrders(results);
  const done: string[] = [];
  if (placed > 0) done.push(`placed ${placed}`);
  if (cancelled > 0) done.push(`cancelled ${cancelled}`);

  if (failed === 0) {
    // All-success path keeps today's wording.
    if (done.length > 0) return `${e.symbol}: ${done.join(' and ')} order(s)`;
    // Only technicals context remained, e.g. a buy the gate blocked. Gate the
    // wording on the block actually being present so a (producer-invariant-
    // breaking) entry with neither outcomes nor technicals is not mislabelled.
    if (e.payload['technicals'] !== undefined) {
      return `${e.symbol}: technicals gate evaluated, no order placed`;
    }
    return `${e.symbol}: no order outcome recorded`;
  }
  // Name the failures so incident triage is not misled into reading a wedged
  // cancel-replace chase as thousands of successful placements — and carry the
  // WHY, because "1 failed" alone sends the operator digging through logs for a
  // reason the executor already knew.
  const reason = firstFailureReason(results);
  const suffix = reason === null ? '' : ` — ${reason}`;
  return done.length > 0
    ? `${e.symbol}: ${done.join(' and ')} order(s), ${failed} failed${suffix}`
    : `${e.symbol}: ${failed} order action(s) failed, none succeeded${suffix}`;
};

/**
 * One line for a captured tick that did nothing. `summarise` is written for
 * ticks with an order outcome and degrades to "no order outcome recorded",
 * which reads as a fault rather than as the normal case it is here. Naming the
 * non-order decisions matters: a tick that emitted `set-kv` or `emit-event` did
 * real work, and calling that "no action" sends triage the wrong way.
 */
const summariseQuiet = (e: AuditEntry): string => {
  const kinds = e.decisionTypes.filter((t) => t !== 'noop');
  return kinds.length > 0
    ? `${e.symbol}: ${kinds.join(', ')}, no order action`
    : `${e.symbol}: evaluated, no action`;
};

/**
 * Fields every tick row carries, whatever the drain policy. `source` marks the
 * row's writer so the Logs filter can separate tick rows from the entry-blocker
 * transitions written elsewhere.
 */
const ctxEnvelope = (e: AuditEntry): Record<string, unknown> => ({
  source: 'tick',
  tickId: e.tickId,
  event: e.event,
  decisionTypes: e.decisionTypes,
  clientOrderIds: e.clientOrderIds,
  latencyMs: e.latencyMs,
});

/** Drain policy: which profile, if any, is currently under deep capture. */
export interface DrainPolicy {
  readonly debugCaptureProfileId: string | null;
}

const NO_CAPTURE: DrainPolicy = { debugCaptureProfileId: null };

/**
 * Shape drained entries into `action_logs` inserts, keeping the actionable ones
 * always and every one for the profile under deep capture. Pure so the drain
 * policy is unit-testable without Redis or Postgres. Each row keeps its own
 * `profileId` (the drainer is cross-profile and has no single scope).
 */
export const auditEntriesToActionLogs = (
  entries: readonly AuditEntry[],
  policy: DrainPolicy = NO_CAPTURE,
): ActionLogInsert[] => {
  const rows: ActionLogInsert[] = [];
  for (const e of entries) {
    const captured = policy.debugCaptureProfileId === e.profileId;
    const actionable = isActionableAudit(e);
    if (!actionable && !captured) continue;
    const technicals = e.payload['technicals'];
    const results = readOrderResults(e);
    // Raise to `warn` when any order action failed so a wedged cancel-replace
    // chase stands out in the feed instead of reading as routine activity.
    const hadFailure = results.some((r) => ORDER_ACTIONS.has(r.type) && !r.ok);
    // A captured tick that did nothing is `debug`, which keeps it out of the
    // warn+error activity feed and gives the Logs tab a level to filter the
    // quiet ticks away by. It does NOT hide them from the default Logs page —
    // no level selected means no narrowing — which is the right default while
    // capture is armed, since seeing those ticks is why it was armed.
    const level = actionable ? (hadFailure ? 'warn' : 'info') : 'debug';
    rows.push({
      id: e.tickId,
      time: new Date(e.ts),
      profileId: e.profileId,
      symbol: e.symbol,
      level,
      msg: actionable ? summarise(e, results) : summariseQuiet(e),
      ctx: {
        ...ctxEnvelope(e),
        // Captured rows carry the whole payload, spread last so a payload key
        // that collides with an envelope field wins — the raw entry is the more
        // faithful answer to "what did this tick see". Nothing is redacted
        // because nothing credential-equivalent is allowed into an audit payload
        // in the first place, and this ctx renders in the UI and leaves the box
        // in exports.
        //
        // Steady-state rows carry only the per-decision outcomes (the executor's
        // ok flags), so triage can see which decisions actually took effect, not
        // just what was emitted.
        ...(captured
          ? e.payload
          : { results, ...(technicals !== undefined ? { technicals } : {}) }),
      },
    });
  }
  return rows;
};
