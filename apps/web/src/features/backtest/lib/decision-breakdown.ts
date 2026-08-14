// Turn the raw per-tick decision breakdown a backtest emits (metric + log
// counters with strategy-internal names like `tt-indicator-gate-veto`) into a
// legible, operator-facing summary, and into config-change suggestions the
// operator can load into the Setup form and re-test.
//
// The suggestions are deliberately diagnostic, not prescriptive: each one only
// REMOVES an entry constraint the operator armed, so they can measure whether it
// was helping or just blocking. They never bypass the bearish technical-rating
// veto (that is the gate keeping the bot out of a downtrend), and they are never
// ranked by in-sample return. The honest loop is unchanged: load → re-run →
// clear the out-of-sample gate → apply to live.

import { tokenizePath } from '@app/contracts';
import type {
  BacktestResult,
  ConfigSuggestion,
  ReasonAttributionMap,
  ReasonKind,
} from '@app/contracts';

// Blocker attribution moved to @app/contracts so the live profile diagnosis
// resolves a reason code to the same field this panel does. Re-exported here so
// the backtest call sites keep their existing import.
export {
  attributeBlocker,
  type BlockerAttribution,
  type ReasonAttributionMap,
} from '@app/contracts';

type Breakdown = BacktestResult['decisionBreakdown'];

/** Metric names that count an entry actually firing (not a blocker). */
const BUY_METRICS = new Set(['tt_tick_buy_path', 'tt_grid_buy_emit']);

/**
 * What kind of lever a blocker is, so the UI can tint it and the operator knows
 * whether it is theirs to change. Aliased to the strategy contract's kind so the
 * copy lives on the strategy descriptor, not a hardcoded web copy (invariant #1).
 */
type BlockerKind = ReasonKind;

/** Plain-language line for a code, off the strategy's map; the raw code as fallback. */
const glossReason = (map: ReasonAttributionMap, code: string): string => map[code]?.gloss ?? code;

/** Lever kind for a code, off the strategy's map; `data` (warm-up) as the neutral fallback. */
const kindOfReason = (map: ReasonAttributionMap, code: string): BlockerKind =>
  map[code]?.kind ?? 'data';

export interface Blocker {
  /** The raw reason or metric code, used as a stable key. */
  readonly code: string;
  readonly label: string;
  readonly count: number;
  /** Share of all entry decisions on this run, 0–100, rounded. */
  readonly pct: number;
  readonly kind: BlockerKind;
}

export interface DecisionSummary {
  /** Every entry decision counted (blocks + buys). The bar denominator. */
  readonly eligible: number;
  readonly technicalsVetoed: number;
  /** Entries that passed the technical-rating gate (then met the indicator gate / sizing / a buy). */
  readonly technicalsPassed: number;
  readonly indicatorVetoed: number;
  readonly sizingSkipped: number;
  readonly bought: number;
  /**
   * Vetoes outside the rating→indicator→sizing funnel (regime entry block,
   * regime/risk-cap/discovery guards from the grid path). Counted in `eligible`
   * and shown in the ranked bars, but the 3-stage funnel is suppressed when this
   * is non-zero since those blocks don't sit cleanly on the gate chain.
   */
  readonly otherVetoed: number;
  /** All blockers, ranked by count descending. */
  readonly blockers: readonly Blocker[];
  /**
   * The sharp insight: of the entries that passed the rating gate, the single
   * dominant indicator that then stopped them, and what share it took. Null when
   * no entry passed the rating gate or no indicator vetoed.
   */
  readonly indicatorChoke: {
    readonly label: string;
    readonly count: number;
    readonly pctOfPassed: number;
  } | null;
}

/**
 * Reduce the raw decision breakdown to a legible summary. The technical-rating
 * and indicator gates are evaluated in order (rating → indicator → sizing) and
 * short-circuit, so the per-reason counts partition the entries that reached
 * each gate; this rebuilds that funnel. Reason labels and tints come from the
 * passed `reasonAttribution` map (the active strategy's descriptor), so this
 * carries no hardcoded per-strategy copy. Returns null when no entry decision was
 * recorded (nothing to explain).
 */
export function summarizeDecisionBreakdown(
  breakdown: Breakdown,
  reasonAttribution: ReasonAttributionMap,
): DecisionSummary | null {
  const tally = new Map<string, { count: number; kind: BlockerKind; label: string }>();
  const add = (code: string, count: number, label: string, kind: BlockerKind): void => {
    const prev = tally.get(code);
    tally.set(code, { count: (prev?.count ?? 0) + count, kind, label });
  };

  let technicalsVetoed = 0;
  let indicatorVetoed = 0;
  for (const l of breakdown.logs) {
    if (l.reason === null) continue;
    if (l.message === 'tt-technicals-gate-veto') {
      technicalsVetoed += l.count;
      add(
        l.reason,
        l.count,
        glossReason(reasonAttribution, l.reason),
        kindOfReason(reasonAttribution, l.reason),
      );
    } else if (l.message === 'tt-indicator-gate-veto') {
      indicatorVetoed += l.count;
      add(
        l.reason,
        l.count,
        glossReason(reasonAttribution, l.reason),
        kindOfReason(reasonAttribution, l.reason),
      );
    }
  }

  let sizingSkipped = 0;
  let bought = 0;
  let otherVetoed = 0;
  for (const m of breakdown.metrics) {
    if (m.name === 'tt_first_buy_skipped') {
      sizingSkipped += m.count;
      const reason = m.tags['reason'] ?? 'min-purchase';
      add(
        reason,
        m.count,
        glossReason(reasonAttribution, reason),
        kindOfReason(reasonAttribution, reason),
      );
    } else if (BUY_METRICS.has(m.name)) {
      bought += m.count;
    } else {
      // A non-gate veto metric (regime / risk / discovery). Unlike a reason-log
      // code, a raw metric name cannot be shown to the operator, and most metrics
      // are diagnostic counters, not vetoes. So a metric counts as a blocker ONLY
      // when the strategy glosses it on the descriptor, which is exactly how the
      // strategy declares "this metric is an entry veto worth surfacing". These
      // default to the `config` kind (not the `data` default gate and sizing rows
      // use), matching how the funnel tinted them before the copy was lifted.
      const entry = reasonAttribution[m.name];
      if (entry?.gloss !== undefined) {
        otherVetoed += m.count;
        add(m.name, m.count, entry.gloss, entry.kind ?? 'config');
      }
    }
  }

  const eligible = technicalsVetoed + indicatorVetoed + sizingSkipped + otherVetoed + bought;
  if (eligible === 0) return null;

  const blockers: Blocker[] = [...tally.entries()]
    .map(([code, { count, kind, label }]) => ({
      code,
      label,
      count,
      pct: Math.round((count / eligible) * 100),
      kind,
    }))
    .sort((a, b) => b.count - a.count);

  const technicalsPassed = indicatorVetoed + sizingSkipped + bought;
  let indicatorChoke: DecisionSummary['indicatorChoke'] = null;
  if (technicalsPassed > 0 && indicatorVetoed > 0) {
    const top = blockers
      .filter((b) => b.code.startsWith('indicator-'))
      .reduce<Blocker | null>(
        (best, b) => (best === null || b.count > best.count ? b : best),
        null,
      );
    if (top) {
      indicatorChoke = {
        label: top.label,
        count: top.count,
        pctOfPassed: Math.round((top.count / technicalsPassed) * 100),
      };
    }
  }

  return {
    eligible,
    technicalsVetoed,
    technicalsPassed,
    indicatorVetoed,
    sizingSkipped,
    bought,
    otherVetoed,
    blockers,
    indicatorChoke,
  };
}

export interface ConfigRecommendation {
  /** Stable id (the blocker code), used as a key and test id suffix. */
  readonly id: string;
  readonly title: string;
  readonly rationale: string;
  /** Entries this blocker accounted for, for ordering and copy. */
  readonly count: number;
  /**
   * Pure transform: returns a clone of the config with this one constraint
   * removed. Composable — the operator can stack several before seeding the form
   * (see {@link applyRecommendations}).
   */
  readonly apply: (config: Record<string, unknown>) => Record<string, unknown>;
}

/** Deep clone via JSON — the strategy config is plain JSON over the wire. */
const cloneConfig = (c: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(JSON.stringify(c)) as Record<string, unknown>;

const getPath = (obj: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>(
    (acc, k) =>
      acc !== null && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined,
    obj,
  );

// Path segments that would walk into the prototype chain. Hardcoded rule-based
// levers never name these; an LLM-supplied path (configSuggestionsToRecommendations)
// could, and `cur[seg] = value` on one of them pollutes Object.prototype for the
// whole page. Refuse such a path rather than trust the model's output.
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** Set a nested value, creating intermediate objects as needed. */
const setPath = (root: Record<string, unknown>, path: readonly string[], value: unknown): void => {
  if (path.some((seg) => UNSAFE_PATH_SEGMENTS.has(seg))) return;
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i] as string;
    const next = cur[k];
    if (next === null || typeof next !== 'object') cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[path[path.length - 1] as string] = value;
};

interface RelaxLever {
  readonly code: string;
  readonly path: readonly string[];
  /** The value that disables this gate. */
  readonly disabled: string;
  /** Whether the current value actually arms the gate (so there is something to relax). */
  readonly isArmed: (v: unknown) => boolean;
  readonly title: string;
  /** What the gate is, for the rationale sentence. */
  readonly what: string;
}

const armedString =
  (...off: string[]) =>
  (v: unknown): boolean =>
    typeof v === 'string' && v !== '' && !off.includes(v);

const RELAX_LEVERS: readonly RelaxLever[] = [
  {
    code: 'indicator-rsi',
    path: ['buy', 'indicatorGate', 'rsiMaxBuy'],
    disabled: '',
    isArmed: armedString('0'),
    title: 'Remove the RSI ceiling',
    what: 'your RSI(14) buy ceiling',
  },
  {
    code: 'indicator-sma',
    path: ['buy', 'indicatorGate', 'smaBias'],
    disabled: 'off',
    isArmed: armedString('off'),
    title: 'Turn off the SMA bias gate',
    what: 'your price-versus-SMA(20) requirement',
  },
  {
    code: 'indicator-ema',
    path: ['buy', 'indicatorGate', 'emaBias'],
    disabled: 'off',
    isArmed: armedString('off'),
    title: 'Turn off the EMA bias gate',
    what: 'your price-versus-EMA(20) requirement',
  },
  {
    code: 'indicator-mean-reversion',
    path: ['buy', 'meanReversionGate', 'entryZScoreMax'],
    disabled: '',
    isArmed: armedString(),
    title: 'Remove the mean-reversion ceiling',
    what: 'your mean-reversion z-score gate',
  },
];

/**
 * Suggest config changes that would let blocked entries through, each as a full
 * config object ready to seed the Setup form. Only constraints the operator
 * actually armed are offered, and only the ones that account for blocked
 * entries. Bearish-rating and size-floor blocks are intentionally left out —
 * relaxing them is either dangerous (buying a downtrend) or a separate sizing
 * decision. Returns [] when nothing relaxable is biting (e.g. a non-TT config).
 */
export function recommendConfigChanges(
  breakdown: Breakdown,
  config: Record<string, unknown>,
): ConfigRecommendation[] {
  // The relax levers key off log-reason blocker counts (always tallied), so this
  // needs no attribution copy; pass an empty map.
  const summary = summarizeDecisionBreakdown(breakdown, {});
  if (summary === null) return [];
  const byCode = new Map(summary.blockers.map((b) => [b.code, b.count]));
  const passed = summary.technicalsPassed;
  const recs: ConfigRecommendation[] = [];

  for (const lever of RELAX_LEVERS) {
    const count = byCode.get(lever.code);
    if (!count) continue;
    if (!lever.isArmed(getPath(config, lever.path))) continue;
    const pctOfPassed = passed > 0 ? Math.round((count / passed) * 100) : 0;
    recs.push({
      id: lever.code,
      title: lever.title,
      count,
      rationale: `This blocked ${count.toLocaleString()} of the ${passed.toLocaleString()} entries that had already passed your technical-rating gate (${pctOfPassed}%). Removing ${lever.what} lets those entries through so you can measure whether it was helping or just blocking.`,
      apply: (cfg) => {
        const next = cloneConfig(cfg);
        setPath(next, lever.path, lever.disabled);
        return next;
      },
    });
  }

  const disallowed = byCode.get('technicals-disallowed');
  if (disallowed) {
    const intervals = getPath(config, ['technicals', 'intervals']);
    const hasDisarmedRow =
      Array.isArray(intervals) &&
      intervals.some((r) => {
        if (r === null || typeof r !== 'object') return false;
        const row = r as Record<string, unknown>;
        return row['whenBuy'] === false || row['whenStrongBuy'] === false;
      });
    if (hasDisarmedRow) {
      recs.push({
        id: 'technicals-disallowed',
        title: 'Act on bullish technical ratings',
        count: disallowed,
        rationale: `${disallowed.toLocaleString()} entries were blocked because the rating was bullish (Buy / Strong-Buy) but that level is not enabled in your technicals gate. This arms both bullish levels so those ratings can trade.`,
        apply: (cfg) => {
          const next = cloneConfig(cfg);
          const rows = getPath(next, ['technicals', 'intervals']) as Record<string, unknown>[];
          for (const row of rows) {
            row['whenBuy'] = true;
            row['whenStrongBuy'] = true;
          }
          return next;
        },
      });
    }
  }

  return recs.sort((a, b) => b.count - a.count);
}

/**
 * Fold selected recommendations onto a base config, composing their changes into
 * one config to seed the form. Each `apply` clones, so the base is never mutated;
 * the levers touch disjoint paths, so order is irrelevant. Always returns a fresh
 * object, even for an empty selection.
 */
export function applyRecommendations(
  base: Record<string, unknown>,
  recs: readonly ConfigRecommendation[],
): Record<string, unknown> {
  return recs.reduce<Record<string, unknown>>((cfg, r) => r.apply(cfg), cloneConfig(base));
}

/**
 * Adapt the LLM advisor's suggestions into the same ConfigRecommendation shape
 * the rule-based panel composes, so an LLM pick flows through the one
 * `applyRecommendations` → seed-the-form → re-run → gate loop. Each suggestion's
 * path/value patches become a pure `apply` (clone, then set each path); the path
 * is tokenized through {@link tokenizePath} so a bracketed array index like
 * `technicals.intervals[2].whenNeutral` targets the real element rather than a
 * stray key. The API already validated every patch against the strategy schema.
 * `count` is unused for these (LLM suggestions are not ranked by a counter).
 */
export function configSuggestionsToRecommendations(
  suggestions: readonly ConfigSuggestion[],
): ConfigRecommendation[] {
  return suggestions.map((s) => ({
    id: s.id,
    title: s.title,
    rationale: s.rationale,
    count: 0,
    apply: (cfg) => {
      const next = cloneConfig(cfg);
      for (const ch of s.changes) setPath(next, tokenizePath(ch.path), ch.value);
      return next;
    },
  }));
}
