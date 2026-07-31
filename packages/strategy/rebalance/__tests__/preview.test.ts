import { describe, expect, it } from 'vitest';
import type { PreviewModel, PreviewRow } from '@app/strategy-core';

import { rebalancePreviewLevels, rebalancePreviewDataNeeds } from '../src/preview.js';

import { RebalanceConfigSchema, type RebalanceConfig } from '../src/schema.js';

const TARGETS = [
  { symbol: 'BTCUSDT', weight: '0.5' },
  { symbol: 'ETHUSDT', weight: '0.3' },
] as const;

const cfg = (over: Record<string, unknown> = {}): RebalanceConfig =>
  RebalanceConfigSchema.parse({
    enabled: true,
    weightMode: 'fixed',
    targets: TARGETS,
    driftThreshold: '0.05',
    ...over,
  });

const rows = (model: PreviewModel): PreviewRow[] => model.sections.flatMap((s) => s.rows);
const previewInput = (config: RebalanceConfig) => ({
  config,
  state: null,
  entryPrice: null,
  currentPrice: null,
});

describe('rebalancePreviewLevels — fixed weight mode', () => {
  it('renders the basket as symbol + weight + drift rows, never a price', () => {
    const model = rebalancePreviewLevels(previewInput(cfg()));
    const all = rows(model);

    for (const t of TARGETS) {
      const r = all.find((x) => x.symbol === t.symbol);
      expect(r).toBeDefined();
      expect(r?.weight).toBe(t.weight);
      expect(r?.drift).toBe('0.05');
    }
    // Rebalance is price-less: no row carries a price at all.
    expect(all.every((r) => r.price === undefined)).toBe(true);
  });

  it('never arms a price trigger (rebalance keys off weight, not price)', () => {
    const model = rebalancePreviewLevels(previewInput(cfg()));
    expect(rows(model).some((r) => r.trigger === true && r.price !== undefined)).toBe(false);
  });

  it('never marks a row as a chart line (rebalance is price-less)', () => {
    const fixed = rows(rebalancePreviewLevels(previewInput(cfg())));
    const mom = rows(rebalancePreviewLevels(previewInput(cfg({ weightMode: 'momentum' }))));
    expect([...fixed, ...mom].every((r) => r.chartLine === undefined)).toBe(true);
  });
});

describe('rebalancePreviewLevels — momentum weight mode', () => {
  it('renders the ranked universe and the top-K rule, ignoring per-target weights', () => {
    const model = rebalancePreviewLevels(
      previewInput(cfg({ weightMode: 'momentum', momentum: { lookbackCandles: 30, topK: 3 } })),
    );
    const all = rows(model);

    // The listed targets are the ranked universe.
    for (const t of TARGETS) {
      expect(all.some((r) => r.symbol === t.symbol)).toBe(true);
    }
    // The rank rule (top-K) is surfaced on the dedicated rank-rule row.
    const rankRule = rows(model).find((r) => r.code === 'rank-rule');
    expect(rankRule?.note).toContain('top 3');
    expect(rankRule?.label).toBe('Rank rule');
    // Still price-less.
    expect(all.every((r) => r.price === undefined)).toBe(true);
  });
});

describe('rebalancePreviewDataNeeds', () => {
  it('needs no extra candle history', () => {
    expect(rebalancePreviewDataNeeds(cfg())).toEqual([]);
  });
});

describe('rebalancePreviewLevels — defensive / branch coverage', () => {
  const input = (config: unknown) =>
    ({ config, state: null, entryPrice: null, currentPrice: null }) as never;

  it('renders no basket rows when targets is absent or not an array', () => {
    const model = rebalancePreviewLevels(input({ weightMode: 'fixed' }));
    expect(rows(model)).toEqual([]);
  });

  it('omits the drift field when driftThreshold is absent', () => {
    const model = rebalancePreviewLevels(input({ weightMode: 'fixed', targets: TARGETS }));
    const r = rows(model).find((x) => x.symbol === 'BTCUSDT');
    expect(r?.weight).toBe('0.5');
    expect(r?.drift).toBeUndefined();
  });

  it('skips a target with a missing symbol or weight', () => {
    const model = rebalancePreviewLevels(
      input({ weightMode: 'fixed', targets: [{ symbol: 'BTCUSDT' }, { weight: '0.2' }] }),
    );
    expect(rows(model)).toEqual([]);
  });

  it('defaults topK / lookback and drops unparseable universe symbols in momentum mode', () => {
    const model = rebalancePreviewLevels(
      input({
        weightMode: 'momentum',
        targets: [{ symbol: 'BTCUSDT', weight: '0.5' }, { weight: '0.1' }],
      }),
    );
    const rule = rows(model).find((r) => r.code === 'rank-rule');
    // Absent momentum block -> topK 3, lookback 30 defaults.
    expect(rule?.note).toContain('top 3');
    expect(rule?.note).toContain('30 candles');
    const universe = rows(model).filter((r) => r.code === 'universe');
    expect(universe.map((r) => r.symbol)).toEqual(['BTCUSDT']);
  });
});
