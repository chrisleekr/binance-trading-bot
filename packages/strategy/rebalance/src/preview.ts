import type { PreviewInput, PreviewModel, PreviewRow, PreviewSection } from '@app/strategy-core';

import type { RebalanceConfig, RebalanceState } from './schema.js';

const str = (raw: unknown): string | null => (typeof raw === 'string' && raw !== '' ? raw : null);
const intOr = (raw: unknown, fallback: number): number => {
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
};

interface RawTarget {
  readonly symbol?: unknown;
  readonly weight?: unknown;
}

const readTargets = (config: RebalanceConfig): readonly RawTarget[] => {
  const t = (config as { targets?: unknown }).targets;
  return Array.isArray(t) ? (t as readonly RawTarget[]) : [];
};

/**
 * Project a rebalance basket for the operator's pre-trade view. Rebalance is
 * PRICE-LESS: it trades on portfolio weight, not a price level, so NO row carries
 * a price and NO row arms a price trigger. Pure, reads the config DEFENSIVELY.
 *
 *   - `fixed`   — render the basket: each target's symbol, its weight, and the
 *     drift band that fires a rebalance once its share strays that far.
 *   - `momentum` — the listed targets are the ranked UNIVERSE (their weights are
 *     ignored); render them plus the top-K equal-weight rule.
 */
export const rebalancePreviewLevels = (
  input: PreviewInput<RebalanceConfig, RebalanceState>,
): PreviewModel => {
  const { config } = input;
  const targets = readTargets(config);

  if ((config as { weightMode?: unknown }).weightMode === 'momentum') {
    const symbols = targets.map((t) => str(t.symbol)).filter((s): s is string => s !== null);
    return momentumBasket(config, symbols);
  }
  return fixedBasket(config, targets);
};

const fixedBasket = (config: RebalanceConfig, targets: readonly RawTarget[]): PreviewModel => {
  const drift = str((config as { driftThreshold?: unknown }).driftThreshold);
  const rows: PreviewRow[] = targets.flatMap((t) => {
    const symbol = str(t.symbol);
    const weight = str(t.weight);
    if (symbol === null || weight === null) return [];
    return [
      {
        code: 'target',
        tone: 'neutral' as const,
        symbol,
        weight,
        ...(drift !== null ? { drift } : {}),
      },
    ];
  });
  const section: PreviewSection = { title: 'Fixed-weight basket', rows };
  return { sections: [section] };
};

const momentumBasket = (config: RebalanceConfig, symbols: readonly string[]): PreviewModel => {
  const mom = (config as { momentum?: { topK?: unknown; lookbackCandles?: unknown } }).momentum;
  const topK = intOr(mom?.topK, 3);
  const lookback = intOr(mom?.lookbackCandles, 30);
  const ruleRow: PreviewRow = {
    code: 'rank-rule',
    label: 'Rank rule',
    tone: 'neutral',
    note: `Hold the top ${topK} by trailing return over ${lookback} candles, equal-weight; the rest rotate to cash.`,
  };
  const universe: PreviewRow[] = symbols.map((symbol) => ({
    code: 'universe',
    tone: 'neutral',
    symbol,
    note: 'Ranked universe; the configured per-target weight is ignored in momentum mode.',
  }));
  const section: PreviewSection = { title: 'Momentum rotation', rows: [ruleRow, ...universe] };
  return { sections: [section] };
};

/** Rebalance reads only the tick candle window; the preview needs no extra history. */
export const rebalancePreviewDataNeeds = (
  _config: RebalanceConfig,
): readonly { readonly interval: string; readonly frames: number }[] => [];
