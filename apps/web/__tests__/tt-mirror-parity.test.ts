// Parity guard between the apps/web trailing-trade mirror and the real
// strategy contract. The mirror replays the strategy's threshold math in
// Number() space (apps/web is decimal-barred), so it can silently drift from
// the worker. This test pins the two known drift points the mirror has had:
//
//   (a) the discovery time-stop exit (state.discoveryEntry + entryAtMs +
//       sell.discoveryTimeStopBars) — previously absent from the mirror, and
//   (b) the phantom "Next grid buy" row — the strategy suppresses the grid for
//       a discovery single-entry (grid-buy.ts returns noop), so the mirror must
//       not show a buy level that can never fire.
//
// It also field-name-pins the state/config keys the mirror reads against the
// real Zod schemas: a rename in the strategy package fails this test rather
// than silently lying to the operator. Tests run in a node env, so importing
// the strategy package (which the browser src cannot) is fine here.

import { describe, expect, it } from 'vitest';
import { TTConfigSchema, TTStateSchema } from '@app/strategy-trailing-trade';
import type { TTConfig, TTState } from '@app/strategy-trailing-trade';
import { ttPreviewLevels } from '@app/strategy-trailing-trade/preview';
import type { PreviewInput } from '@app/strategy-core';

import { deriveChartLines } from '../src/features/symbol/preview/preview-chart-lines.js';
import { deriveSignal } from '../src/features/symbol/strategies/trailing-trade/signal-panel.js';

import type { SymbolStateResponse } from '@app/contracts';

type Strategy = SymbolStateResponse['strategy'];
type Holding = SymbolStateResponse['avgEntryPrice'];

const strategyOf = (config: unknown, state: unknown): Strategy =>
  ({ name: 'trailing-trade', config, state }) as Strategy;

const holdingOf = (avgEntryPrice: string): Holding =>
  ({ avgEntryPrice, quantity: '1', updatedAt: '2026-05-22T00:00:00.000Z' }) as Holding;

const baseConfig = {
  candleInterval: '1h',
  buy: {
    enabled: true,
    gridLevels: [
      { triggerPercentage: '1' },
      { triggerPercentage: '0.97' },
      { triggerPercentage: '0.95' },
    ],
  },
  sell: {
    enabled: true,
    stopLossPercentage: '0.97',
    triggerPercentage: '1.05',
    trailingStopPercentage: '0.98',
    discoveryTimeStopBars: 3,
  },
};

const holdingView = (state: Record<string, unknown>) => {
  const view = deriveSignal(strategyOf(baseConfig, state), holdingOf('100'), '105');
  if (view.kind !== 'holding') throw new Error(`expected holding view, got ${view.kind}`);
  return view;
};

describe('TT mirror ↔ strategy schema field-name parity', () => {
  it('the state fields the mirror reads still exist in TTStateSchema', () => {
    expect(TTStateSchema.shape).toHaveProperty('discoveryEntry');
    expect(TTStateSchema.shape).toHaveProperty('entryAtMs');
  });

  it('the discovery time-stop config fields still exist in TTConfigSchema', () => {
    expect(TTConfigSchema.shape.sell.shape).toHaveProperty('discoveryTimeStopBars');
    // The time-stop row labels the bars with the trading interval.
    expect(TTConfigSchema.shape).toHaveProperty('candleInterval');
  });

  it('the three trail-configuration fields the mirror reads still exist', () => {
    // The panel names the sell arm as the next gate only when one of these is
    // on, the same three reads as sell-gate.ts `trailConfigured`. A rename would
    // otherwise make the panel claim (or drop) a gate the worker disagrees with.
    // Parsed rather than shape-walked: two of the three sit under optional
    // nested objects whose defaults only materialise on parse.
    const cfg = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '15' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    });
    expect(cfg.sell).toHaveProperty('trailingStopPercentage');
    expect(cfg.sell).toHaveProperty('atrTrailing.enabled');
    expect(cfg.regime).toHaveProperty('onBull.hold.enabled');
  });
});

describe('TT mirror discovery-entry behaviour', () => {
  const discoveryState = {
    discoveryEntry: true,
    entryAtMs: 1_700_000_000_000,
    currentGridTradeIndex: 0,
    highSinceBuy: '110',
  };
  const normalState = { currentGridTradeIndex: 0, highSinceBuy: '110' };

  it('suppresses the next-grid-buy for a discovery single-entry (drift b)', () => {
    expect(holdingView(discoveryState).nextBuy).toBeNull();
    expect(holdingView(discoveryState).discoveryEntry).toBe(true);
  });

  it('exposes the discovery time-stop with its bar count + interval (drift a)', () => {
    expect(holdingView(discoveryState).discoveryTimeStop).toEqual({ bars: 3, interval: '1h' });
  });

  it('a normal (non-discovery) hold keeps its grid buy and has no time-stop', () => {
    const view = holdingView(normalState);
    expect(view.discoveryEntry).toBe(false);
    expect(view.discoveryTimeStop).toBeNull();
    // rung 0 → next level is gridLevels[1] = 0.97 → 100 * 0.97 = 97.
    expect(view.nextBuy?.price).toBeCloseTo(97, 8);
  });

  it('does not show a time-stop row for a discovery entry missing entryAtMs (matches the worker guard)', () => {
    // The worker's sell-gate requires entryAtMs !== null; the mirror mirrors
    // that guard so it never claims an exit the worker would not fire.
    const view = holdingView({
      discoveryEntry: true,
      currentGridTradeIndex: 0,
      highSinceBuy: '110',
    });
    expect(view.discoveryTimeStop).toBeNull();
    expect(view.discoveryEntry).toBe(true); // grid-buy is still suppressed
    expect(view.nextBuy).toBeNull();
  });

  it('a discovery entry with the time-stop disabled (bars 0) shows no time-stop row', () => {
    const cfg = { ...baseConfig, sell: { ...baseConfig.sell, discoveryTimeStopBars: 0 } };
    const view = deriveSignal(strategyOf(cfg, discoveryState), holdingOf('100'), '105');
    if (view.kind !== 'holding') throw new Error('expected holding');
    expect(view.discoveryTimeStop).toBeNull();
    expect(view.nextBuy).toBeNull(); // still suppressed — it is a discovery entry
  });
});

describe('TT mirror price-threshold parity (Number space)', () => {
  it('sell arm and stop-loss match avgEntryPrice * the configured percentage', () => {
    const view = holdingView({ currentGridTradeIndex: 0, highSinceBuy: '110' });
    expect(view.sellArm?.price).toBeCloseTo(100 * 1.05, 8); // triggerPercentage
    expect(view.stopLoss?.price).toBeCloseTo(100 * 0.97, 8); // stopLossPercentage
    expect(view.trailingStop?.price).toBeCloseTo(110 * 0.98, 8); // highSinceBuy * trailingStop
  });
});

// The chart draws from `ttPreviewLevels` and the Signal panel from `deriveSignal`
// — two independent readings of one state. When they disagree the operator sees a
// price line the panel says does not exist, and reads a level price crossed as an
// exit the bot ignored. One shared state table drives both readings so the
// disagreement fails here instead of on the chart.
describe('chart ↔ Signal panel parity on the trailing-stop level', () => {
  const ENTRY = '100';
  const CURRENT = '105';

  // The config/state literals here are RAW, exactly as the live worker stores
  // them, so they do not satisfy the parsed generics. The cast is named rather
  // than `as never` so a signature change surfaces as a type error here instead
  // of being absorbed.
  const previewInput = (state: Record<string, unknown>) =>
    ({
      config: baseConfig,
      state,
      entryPrice: ENTRY,
      currentPrice: CURRENT,
    }) as unknown as PreviewInput<TTConfig, TTState>;

  // Both sides return the trail PRICE, not a boolean. Agreeing that a line
  // exists is the weaker half of the claim: two readings that draw the line at
  // different prices are the same lie to the operator as one that omits it.
  const chartTrailPrice = (state: Record<string, unknown>): number | null => {
    const line = deriveChartLines(ttPreviewLevels(previewInput(state))).find(
      (l) => l.label === 'Trailing stop',
    );
    return line ? Number(line.price) : null;
  };

  const panelTrailPrice = (
    state: Record<string, unknown>,
    holding: string | null,
  ): number | null => {
    const view = deriveSignal(
      strategyOf(baseConfig, state),
      holding === null ? null : holdingOf(holding),
      CURRENT,
    );
    return view.kind === 'holding' ? (view.trailingStop?.price ?? null) : null;
  };

  const CASES = [
    { name: 'flat', state: {}, holding: null, trailIsReal: false },
    {
      name: 'held, trail unarmed (price never reached the sell arm)',
      state: { currentGridTradeIndex: 0, avgEntryPrice: ENTRY, highSinceBuy: null },
      holding: ENTRY,
      trailIsReal: false,
    },
    {
      name: 'held, trail armed',
      state: { currentGridTradeIndex: 0, avgEntryPrice: ENTRY, highSinceBuy: '110' },
      holding: ENTRY,
      trailIsReal: true,
    },
  ] as const;

  it.each(CASES)('$name', ({ state, holding, trailIsReal }) => {
    const chart = chartTrailPrice({ ...state });
    const panel = panelTrailPrice({ ...state }, holding);
    // Both must match each other AND the truth: agreeing on a wrong answer is
    // still a lie to the operator.
    expect(panel !== null).toBe(trailIsReal);
    expect(chart !== null).toBe(trailIsReal);
    if (trailIsReal) {
      // Not `toBe`: the chart price comes from the strategy's Decimal math and
      // the panel from the mirror's Number() replay, so they can differ in the
      // last float bit while still naming the same level. A real drift moves the
      // level far more than that.
      expect(panel as number).toBeCloseTo(chart as number, 8);
    }
  });
});
