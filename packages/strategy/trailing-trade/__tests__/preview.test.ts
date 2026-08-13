import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { Candle, PreviewModel, PreviewRow, PreviewTone } from '@app/strategy-core';

import { ttPreviewLevels, ttPreviewDataNeeds } from '../src/preview.js';

import { TTConfigSchema, defaultTTConfig, type TTConfig } from '../src/schema.js';

const PREVIEW_TONES: readonly PreviewTone[] = ['entry', 'buy', 'sell', 'trail', 'stop', 'neutral'];

// A three-rung averaging-down ladder. Level 0's triggerPercentage must equal 1
// (it is the entry buy); each later rung buys below the average cost.
const GRID_CONFIG = (): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '15' },
      gridLevels: [
        { triggerPercentage: '1', maxPurchaseAmount: '100' },
        { triggerPercentage: '0.95', maxPurchaseAmount: '100' },
        { triggerPercentage: '0.9', maxPurchaseAmount: '100' },
      ],
    },
    sell: {
      enabled: true,
      stopLossPercentage: '0.97',
      triggerPercentage: '1.05',
      trailingStopPercentage: '0.98',
    },
  });

const rows = (model: PreviewModel): PreviewRow[] => model.sections.flatMap((s) => s.rows);
const row = (model: PreviewModel, code: string): PreviewRow | undefined =>
  rows(model).find((r) => r.code === code);

const previewInput = (config: TTConfig) => ({
  config,
  state: null,
  entryPrice: '100',
  currentPrice: '100',
  filters: {
    minNotional: '10',
    tickSize: '0.01',
    stepSize: '0.00001',
    minQty: '0.00001',
    maxQty: '100000',
    minPrice: '0.01',
    maxPrice: '1000000',
  },
});

describe('ttPreviewLevels — chained grid ladder', () => {
  it('projects rung fills as a chained product of triggerPercentage', () => {
    const model = ttPreviewLevels(previewInput(GRID_CONFIG()));
    // Rung rows are the buy-toned, priced levels in ladder order.
    // TODO(phase-B): confirm the impl tones the ladder rows 'buy'.
    const rungs = rows(model).filter((r) => r.tone === 'buy' && r.price !== undefined);
    expect(rungs.length).toBeGreaterThanOrEqual(3);

    // rung0 fill == entryPrice.
    expect(rungs[0]?.price).toBe('100');
    // rungN fill == prevFill * triggerPercentage[N]  -> 100, 95, 85.5.
    expect(rungs[1]?.price).toBe(new Decimal('100').mul('0.95').toString());
    expect(rungs[2]?.price).toBe(new Decimal(rungs[1]!.price!).mul('0.9').toString());
  });

  it('projects the running average cost as cumQuote / cumBase', () => {
    const model = ttPreviewLevels(previewInput(GRID_CONFIG()));
    const rungs = rows(model).filter((r) => r.tone === 'buy' && r.price !== undefined);
    const avg = row(model, 'avg-cost');
    if (avg?.price === undefined) throw new Error('expected an avg-cost row');

    // Self-consistent with the base quantities the ladder rows report:
    // avgCost == sum(maxPurchaseAmount) / sum(baseQty).
    const cumBase = rungs.reduce(
      (acc, r) => acc.plus(new Decimal(r.quantity ?? '0')),
      new Decimal(0),
    );
    const cumQuote = new Decimal('100').mul(rungs.length);
    expect(avg.price).toBe(cumQuote.div(cumBase).toString());
  });
});

describe('ttPreviewLevels — sell-side arms', () => {
  it('projects the sell-arm at lbp*triggerPercentage as a projection (no trigger)', () => {
    const model = ttPreviewLevels(previewInput(GRID_CONFIG()));
    const sellArm = rows(model).find((r) => r.tone === 'sell');
    expect(sellArm?.code).toBe('technicals-force-sell');
    // lbp 100 * triggerPercentage 1.05 = 105.
    expect(sellArm?.price).toBe(new Decimal('100').mul('1.05').toString());
    expect(PREVIEW_TONES).toContain(sellArm?.tone);
    // The grid-sell reason is shared by the ATR path at a different level, so the
    // sell-arm is a projection, never a drift-gate trigger.
    expect(sellArm?.trigger).toBeUndefined();
  });

  it('projects the stop-loss at lbp*stopLossPercentage, firing below', () => {
    const model = ttPreviewLevels(previewInput(GRID_CONFIG()));
    const stop = rows(model).find((r) => r.tone === 'stop');
    expect(stop?.code).toBe('grid-stop-loss');
    // lbp 100 * stopLossPercentage 0.97 = 97.
    expect(stop?.price).toBe(new Decimal('100').mul('0.97').toString());
    expect(stop?.triggerWhen).toBe('below');
    // Flat: not yet an actionable trigger (a held position arms it).
    expect(stop?.trigger).toBeUndefined();
  });

  it('arms the stop-loss as a gate trigger whose code is the emitted grid-stop-loss reason when held', () => {
    const heldInput = {
      ...previewInput(GRID_CONFIG()),
      state: { schemaVersion: '1.0.0', avgEntryPrice: '100', highSinceBuy: '100' },
    } as never;
    const stop = rows(ttPreviewLevels(heldInput)).find((r) => r.tone === 'stop');
    // The one gate-active TT trigger: its code MUST equal the intent.reason the
    // sell path emits (buildSellDecision(..., 'grid-stop-loss', ...)), else the
    // drift gate would silently never check it.
    expect(stop?.trigger).toBe(true);
    expect(stop?.code).toBe('grid-stop-loss');
    expect(stop?.price).toBe(new Decimal('100').mul('0.97').toString());
  });

  it('projects a trailing-stop row', () => {
    const model = ttPreviewLevels(previewInput(GRID_CONFIG()));
    expect(rows(model).some((r) => r.tone === 'trail')).toBe(true);
  });

  it('draws chart lines for the sell arms and averaging-down rungs, gating the entry rung and the flat trail', () => {
    const flat = ttPreviewLevels(previewInput(GRID_CONFIG()));
    // The sell arm and the stop-loss always draw.
    for (const code of ['technicals-force-sell', 'grid-stop-loss']) {
      const overlay = rows(flat).filter((r) => r.code === code);
      expect(overlay.length).toBeGreaterThanOrEqual(1);
      expect(overlay.every((r) => r.chartLine === true)).toBe(true);
    }
    // Rung 0 is the entry fill (already the current-price reference) so it is not
    // a distinct line; the averaging-down rungs draw.
    const rungs = rows(flat).filter((r) => r.code === 'grid-buy');
    expect(rungs.length).toBeGreaterThanOrEqual(3);
    expect(rungs[0]?.chartLine).toBeUndefined();
    expect(rungs.slice(1).every((r) => r.chartLine === true)).toBe(true);
    // The trailing stop does not draw while flat (it would land on the entry).
    expect(rows(flat).find((r) => r.code === 'grid-sell')?.chartLine).toBeUndefined();
    // The running average cost is informational, not a drawn price line.
    expect(row(flat, 'avg-cost')?.chartLine).toBeUndefined();

    // Held: the trailing stop draws off the position high.
    const held = ttPreviewLevels({
      ...previewInput(GRID_CONFIG()),
      state: { schemaVersion: '1.0.0', avgEntryPrice: '100', highSinceBuy: '120' },
    } as never);
    expect(rows(held).find((r) => r.code === 'grid-sell')?.chartLine).toBe(true);
  });

  it('labels each row in plain operator language, not the internal code', () => {
    const model = ttPreviewLevels(previewInput(GRID_CONFIG()));
    const rungs = rows(model).filter((r) => r.code === 'grid-buy');
    expect(rungs.map((r) => r.label)).toEqual(['Buy #1', 'Buy #2', 'Buy #3']);
    expect(row(model, 'avg-cost')?.label).toBe('Average cost');
    expect(row(model, 'technicals-force-sell')?.label).toBe('Sell arm');
    expect(row(model, 'grid-stop-loss')?.label).toBe('Stop-loss');
    expect(row(model, 'grid-sell')?.label).toBe('Trailing stop');
    // The code stays the internal drift-gate key.
    expect(row(model, 'grid-stop-loss')?.code).toBe('grid-stop-loss');
  });
});

// A regime-aware config: bull-hold on (so the regime section renders), a short
// MA so a handful of daily candles is enough to classify. period 2 / confirmBars 1.
const HOLD_CONFIG = (): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '15' } },
    sell: {
      enabled: true,
      stopLossPercentage: '0.97',
      triggerPercentage: '1.05',
      trailingStopPercentage: '0.98',
    },
    regime: {
      ma: 'sma',
      period: 2,
      confirmBars: 1,
      onBull: { hold: { enabled: true, room: 'loose' } },
    },
  });

// Pyramid on (needs a per-symbol exposure cap to satisfy the safety refiner).
const PYRAMID_CONFIG = (): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '15' },
      maxSymbolExposureQuote: '1000',
    },
    sell: {
      enabled: true,
      stopLossPercentage: '0.97',
      triggerPercentage: '1.05',
      trailingStopPercentage: '0.98',
    },
    regime: {
      ma: 'sma',
      period: 2,
      confirmBars: 1,
      onBull: { pyramid: { enabled: true, stepPercentage: '0.05', maxAdds: 2 } },
    },
  });

const DAY_MS = 86_400_000;
// A daily candle carries a one-day span (closeTimeMs - openTimeMs), which is how
// the regime section picks its window out of the web's flat multi-interval array.
const dailyCandle = (close: number, i: number): Candle => ({
  openTimeMs: i * DAY_MS,
  closeTimeMs: i * DAY_MS + DAY_MS,
  open: String(close),
  high: String(close),
  low: String(close),
  close: String(close),
  volume: '0',
  isClosed: true,
});
// An hourly candle: a sub-daily span the regime window must ignore.
const hourlyCandle = (close: number, i: number): Candle => ({
  openTimeMs: i * 3_600_000,
  closeTimeMs: i * 3_600_000 + 3_600_000,
  open: String(close),
  high: String(close),
  low: String(close),
  close: String(close),
  volume: '0',
  isClosed: true,
});

const regimeInput = (
  config: TTConfig,
  over: { candles?: readonly Candle[]; entryPrice?: string } = {},
) => ({
  config,
  state: null,
  entryPrice: over.entryPrice ?? '100',
  currentPrice: over.entryPrice ?? '100',
  ...(over.candles !== undefined ? { candles: over.candles } : {}),
});

describe('ttPreviewLevels — regime section', () => {
  it('reports a BULL verdict and an active bull-hold from an above-MA daily window', () => {
    const model = ttPreviewLevels(
      regimeInput(HOLD_CONFIG(), { candles: [dailyCandle(100, 0), dailyCandle(200, 1)] }),
    );
    const regime = model.sections.find((s) => s.title === 'Regime');
    expect(regime).toBeDefined();
    const verdict = row(model, 'regime-verdict');
    expect(verdict?.note).toMatch(/bull/i);
    // The verdict is informational, never a drift-gate trigger.
    expect(verdict?.trigger).toBeUndefined();
    const hold = row(model, 'regime-bull-hold');
    expect(hold?.note).toMatch(/active now/i);
    expect(hold?.note).toMatch(/room: loose/i);
  });

  it('shows "warming up" with the have/need count on a too-short daily window', () => {
    const model = ttPreviewLevels(regimeInput(HOLD_CONFIG(), { candles: [dailyCandle(100, 0)] }));
    const verdict = row(model, 'regime-verdict');
    expect(verdict?.note).toMatch(/warming up/i);
    expect(verdict?.note).toContain('1/2');
    // Below the MA-confirmation window, bull-hold is not active.
    expect(row(model, 'regime-bull-hold')?.note).toMatch(/idle/i);
  });

  it('projects the pyramid add-ladder as entry*(1+step)^i with no trigger', () => {
    const model = ttPreviewLevels(regimeInput(PYRAMID_CONFIG(), { entryPrice: '61300' }));
    const adds = rows(model).filter((r) => r.code === 'regime-pyramid-add');
    expect(adds.map((r) => r.price)).toEqual(['64365', '67583.25']);
    expect(adds.every((r) => r.tone === 'buy' && r.trigger === undefined)).toBe(true);
    // The note reports the step as a percent (0.05 -> 5), not the raw fraction.
    expect(adds.every((r) => r.note === '+5% each')).toBe(true);
  });

  it('classifies only the daily candles out of a mixed decision+regime window', () => {
    // The web hands over the flat concat of the 1h decision window and the 1d
    // regime window. The bearish hourly tail must not sway the bull daily verdict.
    const mixed = [
      hourlyCandle(500, 0),
      hourlyCandle(400, 1),
      hourlyCandle(300, 2),
      dailyCandle(100, 0),
      dailyCandle(200, 1),
    ];
    const verdict = row(
      ttPreviewLevels(regimeInput(HOLD_CONFIG(), { candles: mixed })),
      'regime-verdict',
    );
    expect(verdict?.note).toMatch(/bull/i);
  });

  it('asks the operator to pick a symbol when no candles are supplied, without a false "warming up"', () => {
    const model = ttPreviewLevels(regimeInput(PYRAMID_CONFIG(), { entryPrice: '61300' }));
    const verdict = row(model, 'regime-verdict');
    expect(verdict?.note).toMatch(/pick a symbol/i);
    expect(verdict?.note).not.toMatch(/warming up/i);
    // The add-ladder is entry-driven, so it renders even without a symbol/candles.
    expect(rows(model).filter((r) => r.code === 'regime-pyramid-add')).toHaveLength(2);
  });

  it('omits the regime section entirely when no regime behaviour is enabled', () => {
    const model = ttPreviewLevels(
      regimeInput(GRID_CONFIG(), { candles: [dailyCandle(100, 0), dailyCandle(200, 1)] }),
    );
    expect(model.sections.find((s) => s.title === 'Regime')).toBeUndefined();
  });
});

describe('ttPreviewLevels — regime branch coverage', () => {
  const withRegime = (regime: unknown) => ({ symbol: 'BTCUSDT', regime });
  const bull = [dailyCandle(100, 0), dailyCandle(200, 1)];

  it('reports BEAR when the confirmation closes sit below the MA', () => {
    const cfg = withRegime({
      ma: 'sma',
      period: 2,
      confirmBars: 1,
      onBull: { hold: { enabled: true } },
    });
    const model = ttPreviewLevels(
      previewIn(cfg, { candles: [dailyCandle(200, 0), dailyCandle(100, 1)] }),
    );
    expect(row(model, 'regime-verdict')?.note).toMatch(/bear/i);
  });

  it('reports a neutral "watching" verdict when closes straddle the MA', () => {
    const cfg = withRegime({
      ma: 'sma',
      period: 2,
      confirmBars: 2,
      onBull: { hold: { enabled: true } },
    });
    const model = ttPreviewLevels(
      previewIn(cfg, { candles: [dailyCandle(100, 0), dailyCandle(200, 1), dailyCandle(150, 2)] }),
    );
    expect(row(model, 'regime-verdict')?.note).toMatch(/watching/i);
  });

  it('classifies with an EMA when configured', () => {
    const cfg = withRegime({
      ma: 'ema',
      period: 2,
      confirmBars: 1,
      onBull: { hold: { enabled: true } },
    });
    expect(row(ttPreviewLevels(previewIn(cfg, { candles: bull })), 'regime-verdict')?.note).toMatch(
      /ema/i,
    );
  });

  it('fails safe to a 0/0 warming-up verdict on a malformed recent close', () => {
    const cfg = withRegime({
      ma: 'sma',
      period: 2,
      confirmBars: 1,
      onBull: { hold: { enabled: true } },
    });
    const bad = [dailyCandle(100, 0), { ...dailyCandle(100, 1), close: 'abc' }];
    expect(
      row(ttPreviewLevels(previewIn(cfg, { candles: bad })), 'regime-verdict')?.note,
    ).toContain('0/0');
  });

  it('defaults the bull-hold room to normal when unset', () => {
    const cfg = withRegime({
      ma: 'sma',
      period: 2,
      confirmBars: 1,
      onBull: { hold: { enabled: true } },
    });
    expect(
      row(ttPreviewLevels(previewIn(cfg, { candles: bull })), 'regime-bull-hold')?.note,
    ).toMatch(/room: normal/i);
  });

  it('renders no regime section when period or confirmBars is not a positive int', () => {
    const cfg = withRegime({
      ma: 'sma',
      period: 'x',
      confirmBars: 1,
      onBull: { hold: { enabled: true } },
    });
    expect(
      ttPreviewLevels(previewIn(cfg, { candles: bull })).sections.find((s) => s.title === 'Regime'),
    ).toBeUndefined();
    expect(ttPreviewDataNeeds(cfg as never)).toEqual([]);
  });

  it('omits the pyramid ladder when the step is non-positive', () => {
    const cfg = withRegime({
      ma: 'sma',
      period: 2,
      confirmBars: 1,
      onBull: { pyramid: { enabled: true, stepPercentage: '0', maxAdds: 2 } },
    });
    const model = ttPreviewLevels(previewIn(cfg, { candles: bull }));
    expect(rows(model).some((r) => r.code === 'regime-pyramid-add')).toBe(false);
    // The pyramid toggle still keeps the regime active, so the verdict shows.
    expect(row(model, 'regime-verdict')).toBeDefined();
  });

  it('treats a null regime as no section and no data need', () => {
    expect(
      ttPreviewLevels(previewIn({ regime: null } as never, { candles: bull })).sections,
    ).toEqual([]);
    expect(ttPreviewDataNeeds({ regime: null } as never)).toEqual([]);
  });

  it.each([
    { exposure: { enabled: true } },
    { onBear: { exitToCash: true } },
    { onBear: { blockEntry: true } },
    { onBear: { suppressPromotion: true } },
    { onBear: { rearm: { enabled: true } } },
    { onBull: { requireEntry: true } },
  ])('shows the regime section when only %o is active', (extra) => {
    const cfg = withRegime({ ma: 'sma', period: 2, confirmBars: 1, ...extra });
    expect(
      ttPreviewLevels(previewIn(cfg, { candles: bull })).sections.find((s) => s.title === 'Regime'),
    ).toBeDefined();
    expect(ttPreviewDataNeeds(cfg as never)).toEqual([{ interval: '1d', frames: 10 }]);
  });

  it('classifies the daily window even without a current price', () => {
    const cfg = withRegime({
      ma: 'sma',
      period: 2,
      confirmBars: 1,
      onBull: { hold: { enabled: true } },
    });
    expect(
      row(ttPreviewLevels(previewIn(cfg, { candles: bull, currentPrice: null })), 'regime-verdict')
        ?.note,
    ).toMatch(/bull/i);
  });

  it('sizes the daily window by the period+confirmation floor and caps at the ring', () => {
    // A large confirmation window makes period+confirmBars+5 exceed the 5x warm-up.
    const wide = withRegime({ period: 2, confirmBars: 10, onBull: { hold: { enabled: true } } });
    expect(ttPreviewDataNeeds(wide as never)).toEqual([{ interval: '1d', frames: 17 }]);
    // A 200-day MA warm-up (1000) is clamped to the worker's 500-candle daily ring.
    const deep = withRegime({ period: 200, confirmBars: 3, onBull: { hold: { enabled: true } } });
    expect(ttPreviewDataNeeds(deep as never)).toEqual([{ interval: '1d', frames: 500 }]);
  });
});

describe('ttPreviewDataNeeds', () => {
  it('needs no extra candle history when no regime behaviour is active', () => {
    expect(ttPreviewDataNeeds(GRID_CONFIG())).toEqual([]);
    expect(ttPreviewDataNeeds(defaultTTConfig())).toEqual([]);
  });

  it('requests the daily regime window sized to the MA period and confirmation', () => {
    // period 2, confirmBars 1 -> max(2*5, 2+1+5) = 10 daily frames.
    expect(ttPreviewDataNeeds(HOLD_CONFIG())).toEqual([{ interval: '1d', frames: 10 }]);
  });
});

const previewIn = (config: unknown, over: Record<string, unknown> = {}) =>
  ({ config, state: null, entryPrice: '100', currentPrice: '100', ...over }) as never;

describe('ttPreviewLevels — defensive / branch coverage', () => {
  it('returns an empty model when the entry price is absent or non-positive', () => {
    expect(ttPreviewLevels(previewIn(GRID_CONFIG(), { entryPrice: null })).sections).toEqual([]);
    expect(ttPreviewLevels(previewIn(GRID_CONFIG(), { entryPrice: '' })).sections).toEqual([]);
    expect(ttPreviewLevels(previewIn(GRID_CONFIG(), { entryPrice: '0' })).sections).toEqual([]);
    expect(ttPreviewLevels(previewIn(GRID_CONFIG(), { entryPrice: 'abc' })).sections).toEqual([]);
  });

  it('renders no ladder when gridLevels is absent, empty, or has a bad level', () => {
    const noGrid = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '15' } },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    });
    expect(rows(ttPreviewLevels(previewIn(noGrid))).some((r) => r.tone === 'buy')).toBe(false);
    // A level with a non-positive maxPurchaseAmount / trigger aborts the ladder.
    const badMax = { buy: { gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '0' }] } };
    expect(rows(ttPreviewLevels(previewIn(badMax as never))).some((r) => r.tone === 'buy')).toBe(
      false,
    );
    const badTrig = {
      buy: {
        gridLevels: [
          { triggerPercentage: '1', maxPurchaseAmount: '100' },
          { triggerPercentage: '0', maxPurchaseAmount: '100' },
        ],
      },
    };
    expect(rows(ttPreviewLevels(previewIn(badTrig as never))).some((r) => r.tone === 'buy')).toBe(
      false,
    );
  });

  it('renders no sell rows when the sell block is absent or disabled', () => {
    expect(rows(ttPreviewLevels(previewIn({ buy: { gridLevels: [] } } as never)))).toEqual([]);
    // triggerPercentage <= 1 -> no sell-arm; stop/trail absent -> no rows.
    const noSells = {
      sell: { triggerPercentage: '1', stopLossPercentage: '', trailingStopPercentage: '' },
    };
    expect(rows(ttPreviewLevels(previewIn(noSells as never))).some((r) => r.tone === 'sell')).toBe(
      false,
    );
  });

  it('marks the stop-loss row as a trigger only when a position is held', () => {
    const cfgObj = { sell: { stopLossPercentage: '0.97' } };
    const flat = ttPreviewLevels(previewIn(cfgObj as never, { state: null }));
    expect(rows(flat).find((r) => r.tone === 'stop')?.trigger).toBeUndefined();
    const held = ttPreviewLevels(
      previewIn(cfgObj as never, { state: { avgEntryPrice: '100', highSinceBuy: '120' } }),
    );
    expect(rows(held).find((r) => r.tone === 'stop')?.trigger).toBe(true);
  });

  it('projects the trailing stop off the position high when held', () => {
    const cfgObj = { sell: { trailingStopPercentage: '0.98' } };
    const held = ttPreviewLevels(
      previewIn(cfgObj as never, { state: { avgEntryPrice: '100', highSinceBuy: '200' } }),
    );
    // high 200 * 0.98 = 196.
    expect(rows(held).find((r) => r.tone === 'trail')?.price).toBe('196');
  });

  it('names no level, and no arming price, when there is no arm and no high', () => {
    const cfgObj = { sell: { trailingStopPercentage: '0.98' } };
    const model = ttPreviewLevels(previewIn(cfgObj as never, { state: null }));
    // No sellArm (no trigger) and no highSinceBuy: the sell gate has nothing to
    // trail from, so the row explains the wait instead of quoting a price.
    const trail = rows(model).find((r) => r.tone === 'trail');
    expect(trail?.price).toBeUndefined();
    expect(trail?.note).toContain('the first new high');
    expect(trail?.note).toContain('2%');
  });

  it('treats a non-finite decimal field as absent', () => {
    const cfgObj = { sell: { stopLossPercentage: 'Infinity', trailingStopPercentage: '0.98' } };
    const model = ttPreviewLevels(previewIn(cfgObj as never, { state: null }));
    expect(rows(model).some((r) => r.tone === 'stop')).toBe(false);
  });

  it('aborts the ladder on a hole in the gridLevels array', () => {
    const sparse: unknown[] = [{ triggerPercentage: '1', maxPurchaseAmount: '100' }];
    sparse[2] = { triggerPercentage: '0.9', maxPurchaseAmount: '100' }; // index 1 is a hole
    const model = ttPreviewLevels(previewIn({ buy: { gridLevels: sparse } } as never));
    expect(rows(model).some((r) => r.tone === 'buy')).toBe(false);
  });
});

// The worker's sell-gate only trails from a real `highSinceBuy`; with none, no
// trailing exit exists at any price. Projecting one anyway hands the operator a
// level below the sell arm that price routinely crosses, which reads as "the
// trailing stop fired and the bot ignored it".
describe('ttPreviewLevels — the trailing stop is a level only once armed', () => {
  // The reported ETHBTC position: +8% sell arm, 6% give-back trail, price never
  // above the arm, so the trail never came into existence.
  const TRAIL_CONFIG = { sell: { triggerPercentage: '1.08', trailingStopPercentage: '0.94' } };
  const ENTRY = '0.029679746835443037975';

  const trailRow = (state: unknown, currentPrice = '0.0302') =>
    rows(
      ttPreviewLevels(previewIn(TRAIL_CONFIG as never, { entryPrice: ENTRY, currentPrice, state })),
    ).find((r) => r.tone === 'trail');

  it('holds back the price and the chart line while the position is held but unarmed', () => {
    const trail = trailRow({ avgEntryPrice: ENTRY, highSinceBuy: null });
    // The row still belongs in the ladder — the operator needs to see the trail
    // is configured — but it names no level, so nothing can be drawn from it.
    expect(trail).toBeDefined();
    expect(trail?.chartLine).toBeUndefined();
    expect(trail?.price).toBeUndefined();
  });

  it('keeps the sell arm drawn while unarmed, since that is the operative gate', () => {
    const model = ttPreviewLevels(
      previewIn(TRAIL_CONFIG as never, {
        entryPrice: ENTRY,
        currentPrice: '0.0302',
        state: { avgEntryPrice: ENTRY, highSinceBuy: null },
      }),
    );
    const arm = rows(model).find((r) => r.code === 'technicals-force-sell');
    expect(arm?.chartLine).toBe(true);
    expect(arm?.price).toBe(new Decimal(ENTRY).mul('1.08').toString());
  });

  it('draws the trailing line at highSinceBuy * trailingStopPercentage once armed', () => {
    // Regression lock on the armed side: suppressing the unarmed projection must
    // not take the real trailing line with it.
    const high = '0.0325';
    const trail = trailRow({ avgEntryPrice: ENTRY, highSinceBuy: high });
    expect(trail?.chartLine).toBe(true);
    expect(trail?.price).toBe(new Decimal(high).mul('0.94').toString());
  });
});
