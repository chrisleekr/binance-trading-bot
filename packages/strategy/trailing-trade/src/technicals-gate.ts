import {
  allowBuySet,
  type TechnicalsBundle,
  type TechnicalsIntervalConfig,
  type TechnicalsSignal,
} from '@app/contracts';
import type { TTForceBuyOverride } from './schema.js';

type TVRecommendation = NonNullable<
  TechnicalsBundle['signals'][number]['signal']
>['recommendation'];

// Recommendations that always pass a participating interval's buy gate.
// `NEUTRAL` is always allowed (a neutral signal passes the buy gate unless
// the operator explicitly opts SELL into the buy-allow set, which v1.0 never
// exposes); `SELL` and `STRONG_SELL` always veto.
const NEVER_VETO: ReadonlySet<TVRecommendation> = new Set(['NEUTRAL']);
const ALWAYS_VETO: ReadonlySet<TVRecommendation> = new Set(['SELL', 'STRONG_SELL']);

/**
 * Veto reasons keep the "no buy" branches distinguishable downstream so
 * observers can tell a missing signal apart from a stale verdict apart from
 * a bearish recommendation apart from a bullish-but-not-allowed one.
 * `technicals-sell` covers BOTH `SELL` and `STRONG_SELL` — the market read
 * is bearish. `technicals-disallowed` is the distinct case where the rating
 * is bullish (`BUY`/`STRONG_BUY`) but the operator did not arm that level as
 * an allowed buy trigger on this interval (e.g. "Strong Buy" left unchecked),
 * so the buy is blocked even though the rating is NOT a sell. Folding the two
 * into one reason overstates how bearish the market was. The underlying
 * recommendation rides on the log context either way. The names are part of
 * the log contract — once dashboards key on them they are expensive to rename.
 */
export type TVGateVeto =
  | 'technicals-no-signal'
  | 'technicals-stale'
  | 'technicals-sell'
  | 'technicals-disallowed';

/**
 * Per-interval evaluation summary surfaced on the gate result for audit-log
 * fan-out. The strategy emits the veto for the operator-prioritised
 * interval (see `VETO_PRIORITY`); `intervalsConsulted` carries the full
 * per-row breakdown so dashboards can show "5m allowed BUY, 1h vetoed
 * SELL" instead of only the first-veto wins narrative. `null`
 * recommendation = no signal at all; `verdict: 'pass'` covers both
 * non-participating (empty allow-buy set) and signal-allowed rows.
 */
export interface IntervalConsultation {
  readonly interval: string;
  readonly recommendation: TVRecommendation | null;
  readonly verdict: 'pass' | TVGateVeto;
  // True when the row is configured as advisory: the verdict was computed
  // for audit-log fidelity but never promoted to a gate veto. Dashboards
  // render advisory rows as "would have vetoed" instead of an active block.
  readonly advisory: boolean;
}

/** Tagged-union result of {@link evaluateTechnicalsGate}; preserves the veto reason and the offending interval so callers emit the right log/metric without re-deriving it. */
export type TVGateResult =
  | { readonly ok: true; readonly intervalsConsulted: readonly IntervalConsultation[] }
  | {
      readonly ok: false;
      readonly reason: TVGateVeto;
      readonly interval: string;
      readonly intervalsConsulted: readonly IntervalConsultation[];
    };

/**
 * Per-interval evaluation result. Internal — `evaluateTechnicalsGate` reduces over
 * the list and returns the first veto.
 */
type IntervalVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: TVGateVeto };

/**
 * Evaluate the buy gate for one operator-configured interval row. Returns
 * `{ ok: true }` when the row is non-participating (empty allow-buy set)
 * or when the signal passes; otherwise returns the veto reason.
 *
 * Freshness: ages strictly greater than the configured window are stale.
 * `useOnlyWithinMin` is a positive integer minutes, so the boundary
 * (`ageMs === maxAgeMs`) is treated as still-fresh. Clock-skew clamp: a
 * future-dated signal (producer clock running ahead) is treated as fresh
 * rather than indefinitely fresh by accident.
 */
const evaluateInterval = (
  row: TechnicalsIntervalConfig,
  signal: TechnicalsSignal | null,
  useOnlyWithinMin: number,
  ifExpires: 'do-not-buy' | 'allow-anyway',
  nowMs: number,
): IntervalVerdict => {
  const allowed = allowBuySet(row);
  if (allowed.size === 0) {
    // Operator configured this row only for force-sell pressure — it does
    // not participate in the buy gate.
    return { ok: true };
  }
  if (signal === null) {
    return { ok: false, reason: 'technicals-no-signal' };
  }
  const maxAgeMs = useOnlyWithinMin * 60_000;
  const rawAgeMs = nowMs - signal.receivedAtMs;
  const ageMs = rawAgeMs < 0 ? 0 : rawAgeMs;
  if (ageMs > maxAgeMs && ifExpires === 'do-not-buy') {
    return { ok: false, reason: 'technicals-stale' };
  }
  // `allow-anyway` falls through to the recommendation check, evaluating
  // the signal as if fresh; the operator has explicitly accepted that risk.
  if (NEVER_VETO.has(signal.recommendation)) return { ok: true };
  if (ALWAYS_VETO.has(signal.recommendation)) return { ok: false, reason: 'technicals-sell' };
  if (allowed.has(signal.recommendation)) return { ok: true };
  // Recommendation is bullish (`BUY`/`STRONG_BUY`) but not in this row's
  // allow-buy set — the operator left that level unchecked. This is NOT a
  // sell: surface it as its own reason so the log doesn't read as bearish.
  return { ok: false, reason: 'technicals-disallowed' };
};

/**
 * Buy-side Technicals gate. Evaluates every operator-configured interval
 * row; the buy passes iff every participating row (one with a non-empty
 * allow-buy set) passes its own check. Empty `intervals[]` (operator opted
 * out of Technicals for this profile) opens the gate fully — the same
 * effect as `forceBuyOverride.checkTechnicals === false` but at the
 * profile level.
 *
 * The first veto wins, and its `interval` rides on the result so the log
 * context can name which row triggered the veto.
 */
/**
 * Veto-reason priority for surfacing the most actionable veto when more
 * than one interval would block the buy. `technicals-sell` (a bearish market
 * read) is the most actionable "Technicals says don't buy" signal;
 * `technicals-disallowed` (a bullish rating the operator did not arm) is the
 * next most actionable since it is a config choice the operator can flip;
 * `technicals-stale` is a config/freshness warning; `technicals-no-signal` is
 * the boot/outage state. Without this ordering a first-position interval that
 * is still warming would hide a later interval's SELL veto behind a debug
 * log — defeating the dashboards' SELL-veto visibility promise.
 */
const VETO_PRIORITY: Record<TVGateVeto, number> = {
  'technicals-sell': 4,
  'technicals-disallowed': 3,
  'technicals-stale': 2,
  'technicals-no-signal': 1,
};

export const evaluateTechnicalsGate = (
  tv: TechnicalsBundle,
  override: TTForceBuyOverride,
  nowMs: number,
): TVGateResult => {
  if (override.checkTechnicals === false) return { ok: true, intervalsConsulted: [] };
  if (tv.config.intervals.length === 0) return { ok: true, intervalsConsulted: [] };
  // Pair each configured row with its signal slot. The bundle producer
  // preserves order so `signals[i]` matches `intervals[i]`; a defensive
  // lookup keeps the gate robust to a future producer that ever
  // reorders.
  const signalByInterval = new Map<string, TechnicalsSignal | null>(
    tv.signals.map((s) => [s.interval, s.signal] as const),
  );
  let chosen: { readonly reason: TVGateVeto; readonly interval: string } | null = null;
  const consulted: IntervalConsultation[] = [];
  for (const row of tv.config.intervals) {
    const signal = signalByInterval.get(row.interval) ?? null;
    const verdict = evaluateInterval(
      row,
      signal,
      tv.config.useOnlyWithinMin,
      tv.config.ifExpires,
      nowMs,
    );
    const advisory = row.mode === 'advisory';
    consulted.push({
      interval: row.interval,
      recommendation: signal?.recommendation ?? null,
      verdict: verdict.ok ? 'pass' : verdict.reason,
      advisory,
    });
    if (verdict.ok) continue;
    // Advisory rows record their would-be veto for the audit log but never
    // promote it to a gate decision. This is the observability lever: the
    // operator can mark a noisy short timeframe advisory and still see what
    // it said in the audit row.
    if (advisory) continue;
    if (chosen === null || VETO_PRIORITY[verdict.reason] > VETO_PRIORITY[chosen.reason]) {
      chosen = { reason: verdict.reason, interval: row.interval };
    }
  }
  if (chosen !== null) {
    return {
      ok: false,
      reason: chosen.reason,
      interval: chosen.interval,
      intervalsConsulted: consulted,
    };
  }
  return { ok: true, intervalsConsulted: consulted };
};

/**
 * Relaxed buy gate for a discovery `enterOnAdd` first entry: pass UNLESS a
 * participating interval reads a fresh `STRONG_SELL`. This is the floor the
 * operator opts into — it skips the short-interval confirmation that would
 * otherwise block a coin discovery confirmed on the 1h trend, while keeping the
 * one downside guard that says "the short timeframe is actively collapsing."
 *
 * Differences from {@link evaluateTechnicalsGate}, all deliberate:
 *  - `SELL` no longer vetoes (only `STRONG_SELL` does) — the relaxation.
 *  - A missing or stale signal passes rather than blocking: the whole point is
 *    to not require fresh short-interval confirmation. A `STRONG_SELL` older
 *    than the freshness window is not a reliable "collapsing now" read, so it
 *    is ignored too, matching the normal gate's `do-not-buy`/`allow-anyway`
 *    staleness contract.
 *  - A row's allow-buy set is irrelevant; every participating row is judged on
 *    the single STRONG_SELL test.
 *
 * `forceBuyOverride.checkTechnicals === false` still fully opens the gate (the
 * operator disabled Technicals outright), and advisory rows record their verdict
 * without promoting it — both mirror the normal gate so the two cannot diverge
 * on those axes. Returns the same {@link TVGateResult} so callers emit identical
 * logs/metrics.
 */
export const evaluateEnterOnAddFloor = (
  tv: TechnicalsBundle,
  override: TTForceBuyOverride,
  nowMs: number,
): TVGateResult => {
  if (override.checkTechnicals === false) return { ok: true, intervalsConsulted: [] };
  if (tv.config.intervals.length === 0) return { ok: true, intervalsConsulted: [] };
  const signalByInterval = new Map<string, TechnicalsSignal | null>(
    tv.signals.map((s) => [s.interval, s.signal] as const),
  );
  const maxAgeMs = tv.config.useOnlyWithinMin * 60_000;
  let chosen: string | null = null;
  const consulted: IntervalConsultation[] = [];
  for (const row of tv.config.intervals) {
    const signal = signalByInterval.get(row.interval) ?? null;
    const rec = signal?.recommendation ?? null;
    let verdict: 'pass' | TVGateVeto = 'pass';
    if (signal !== null && rec === 'STRONG_SELL') {
      const rawAgeMs = nowMs - signal.receivedAtMs;
      const ageMs = rawAgeMs < 0 ? 0 : rawAgeMs;
      const stale = ageMs > maxAgeMs && tv.config.ifExpires === 'do-not-buy';
      if (!stale) verdict = 'technicals-sell';
    }
    const advisory = row.mode === 'advisory';
    consulted.push({ interval: row.interval, recommendation: rec, verdict, advisory });
    if (verdict !== 'pass' && !advisory && chosen === null) chosen = row.interval;
  }
  if (chosen !== null) {
    return {
      ok: false,
      reason: 'technicals-sell',
      interval: chosen,
      intervalsConsulted: consulted,
    };
  }
  return { ok: true, intervalsConsulted: consulted };
};
