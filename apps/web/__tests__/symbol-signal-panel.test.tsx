// SymbolSignalPanel — deriveSignal math (flat / holding / disabled thresholds)
// and a render smoke test.

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../src/shared/lib/query-client.js';
import {
  deriveSignal,
  SymbolSignalPanel,
} from '../src/features/symbol/strategies/trailing-trade/signal-panel.js';
import { symbolCandleBucketMs, symbolCandlesQueryKey } from '../src/features/symbol/api/symbol.js';

import { pendingFetchForPaths } from './helpers/pending-fetch';

import type { CandleList, SymbolStateResponse, TechnicalsResponse } from '@app/contracts';

const DAY_MS = 86_400_000;

/** Daily candles oldest-first ending one day ago, so every bar is closed relative to now. */
const dailyCandles = (closes: readonly number[]): CandleList =>
  closes.map((c, i) => ({
    time: new Date(Date.now() - (closes.length - i) * DAY_MS).toISOString(),
    open: String(c),
    high: String(c),
    low: String(c),
    close: String(c),
    volume: '0',
  }));

/** Config with regime-exit enabled (small period/confirmBars for compact fixtures). */
const regimeExitConfig = (period = 3, confirmBars = 2): unknown => ({
  ...ttConfig,
  regime: { ma: 'sma', period, confirmBars, onBear: { exitToCash: true } },
});

/** Config with bull-hold enabled (small period/confirmBars for compact fixtures). */
const bullHoldConfig = (room: 'tight' | 'normal' | 'loose' = 'normal'): unknown => ({
  ...ttConfig,
  regime: { ma: 'sma', period: 3, confirmBars: 2, onBull: { hold: { enabled: true, room } } },
});

/** Config with the bull pyramid enabled. */
const pyramidConfig = (maxAdds = 3, stepPercentage = '0.05'): unknown => ({
  ...ttConfig,
  regime: {
    ma: 'sma',
    period: 3,
    confirmBars: 2,
    onBull: { pyramid: { enabled: true, stepPercentage, maxAdds, maxPurchaseAmount: '15' } },
  },
});

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
const SYMBOL = 'BTCUSDT';
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const TECHNICALS_PATH = `/api/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/technicals/recommendations`;
const CANDLES_PATH = `/api/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/symbols/${SYMBOL}/candles`;

const renderPanel = (props: {
  strategy: SymbolStateResponse['strategy'];
  holding: SymbolStateResponse['avgEntryPrice'];
  currentPrice: string | null;
  technicalsResponse?: TechnicalsResponse;
  dailyCandlesResponse?: CandleList;
}): ReturnType<typeof render> => {
  const queryClient = createQueryClient();
  if (props.technicalsResponse) {
    queryClient.setQueryData(
      ['profile', 'technicals', 'recommendations', PROFILE_ID],
      props.technicalsResponse,
    );
  }
  if (props.dailyCandlesResponse) {
    queryClient.setQueryData(
      symbolCandlesQueryKey(PROFILE_ID, SYMBOL, '1d', symbolCandleBucketMs('1d')),
      props.dailyCandlesResponse,
    );
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <SymbolSignalPanel
        profileId={PROFILE_ID}
        symbol={SYMBOL}
        strategy={props.strategy}
        holding={props.holding}
        currentPrice={props.currentPrice}
      />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.stubGlobal('fetch', pendingFetchForPaths(TECHNICALS_PATH, CANDLES_PATH));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Strategy = SymbolStateResponse['strategy'];

const strategyOf = (config: unknown, state: unknown): Strategy => ({
  name: 'trailing-trade',
  config,
  state,
});

type Holding = SymbolStateResponse['avgEntryPrice'];
const holdingOf = (avgEntryPrice: string | null): Holding =>
  avgEntryPrice === null
    ? null
    : { avgEntryPrice, quantity: '1', updatedAt: '2026-05-22T00:00:00.000Z' };

const ttConfig = {
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
  },
  // Default-shape Technicals block with a single buy-participating row,
  // so the Signal panel surfaces the TV gate. An empty `intervals[]` would
  // (correctly) suppress the gate line.
  technicals: {
    useOnlyWithinMin: 2,
    ifExpires: 'do-not-buy',
    intervals: [
      {
        interval: '1h',
        whenStrongBuy: true,
        whenBuy: true,
        whenSell: false,
        whenStrongSell: false,
        whenNeutral: false,
      },
    ],
  },
};

describe('deriveSignal', () => {
  it('returns unavailable when config or state is missing', () => {
    expect(deriveSignal(strategyOf(null, {}), null, '100').kind).toBe('unavailable');
    expect(deriveSignal(strategyOf({}, null), null, '100').kind).toBe('unavailable');
  });

  it('returns flat with buyEnabled; an absent forceBuyOverride still gates on Technicals', () => {
    // `ttConfig` has no `forceBuyOverride`. checkTechnicals defaults to true,
    // so the panel must still surface the Technicals gate.
    const view = deriveSignal(strategyOf(ttConfig, { avgEntryPrice: null }), null, '100');
    expect(view).toEqual({
      kind: 'flat',
      buyEnabled: true,
      gates: ['Technicals signal allows the buy on 1h'],
    });
  });

  it('reports buy disabled in the flat state', () => {
    const config = { ...ttConfig, buy: { ...ttConfig.buy, enabled: false } };
    const view = deriveSignal(strategyOf(config, { avgEntryPrice: null }), null, '100');
    expect(view).toEqual({
      kind: 'flat',
      buyEnabled: false,
      gates: ['Technicals signal allows the buy on 1h'],
    });
  });

  it('lists the configured entry gates in the flat state', () => {
    const config = {
      ...ttConfig,
      buy: {
        ...ttConfig.buy,
        indicatorGate: { rsiMaxBuy: '70', smaBias: 'price-below-sma', emaBias: 'off' },
      },
      forceBuyOverride: { checkTechnicals: true },
    };
    const view = deriveSignal(strategyOf(config, { avgEntryPrice: null }), null, '100');
    if (view.kind !== 'flat') throw new Error('expected flat');
    expect(view.gates).toEqual([
      'RSI(14) at or below 70',
      'price below SMA(20)',
      'Technicals signal allows the buy on 1h',
    ]);
  });

  it('omits the TV gate when intervals[] is empty (Technicals opted out)', () => {
    const config = { ...ttConfig, technicals: { ...ttConfig.technicals, intervals: [] } };
    const view = deriveSignal(strategyOf(config, { avgEntryPrice: null }), null, '100');
    if (view.kind !== 'flat') throw new Error('expected flat');
    expect(view.gates).toEqual([]);
  });

  it('omits the TV gate when every interval is force-sell-only (no buy participation)', () => {
    const config = {
      ...ttConfig,
      technicals: {
        ...ttConfig.technicals,
        intervals: [
          {
            interval: '1h',
            whenStrongBuy: false,
            whenBuy: false,
            whenSell: true,
            whenStrongSell: true,
            whenNeutral: false,
          },
        ],
      },
    };
    const view = deriveSignal(strategyOf(config, { avgEntryPrice: null }), null, '100');
    if (view.kind !== 'flat') throw new Error('expected flat');
    expect(view.gates).toEqual([]);
  });

  it('names all buy-participating intervals in the TV gate line', () => {
    const config = {
      ...ttConfig,
      technicals: {
        ...ttConfig.technicals,
        intervals: [
          {
            interval: '5m',
            whenStrongBuy: true,
            whenBuy: false,
            whenSell: false,
            whenStrongSell: false,
            whenNeutral: false,
          },
          {
            interval: '1h',
            whenStrongBuy: false,
            whenBuy: false,
            whenSell: true,
            whenStrongSell: false,
            whenNeutral: false,
          },
          {
            interval: '4h',
            whenStrongBuy: true,
            whenBuy: true,
            whenSell: false,
            whenStrongSell: false,
            whenNeutral: false,
          },
        ],
      },
    };
    const view = deriveSignal(strategyOf(config, { avgEntryPrice: null }), null, '100');
    if (view.kind !== 'flat') throw new Error('expected flat');
    expect(view.gates).toEqual(['Technicals signal allows the buy on 5m + 4h']);
  });

  it('omits disabled or out-of-range indicator-gate knobs from the flat gate list', () => {
    // rsiMaxBuy '150' is out of the (0,100] range, '0'/off are sentinels;
    // checkTechnicals explicit false disables the Technicals gate.
    const config = {
      ...ttConfig,
      buy: {
        ...ttConfig.buy,
        indicatorGate: { rsiMaxBuy: '150', smaBias: 'off', emaBias: 'off' },
      },
      forceBuyOverride: { checkTechnicals: false },
    };
    const view = deriveSignal(strategyOf(config, { avgEntryPrice: null }), null, '100');
    if (view.kind !== 'flat') throw new Error('expected flat');
    expect(view.gates).toEqual([]);
  });

  it('derives the holding targets from avgEntryPrice and the current rung', () => {
    const state = { avgEntryPrice: '100', currentGridTradeIndex: 0, highSinceBuy: '110' };
    const view = deriveSignal(strategyOf(ttConfig, state), holdingOf('100'), '99');
    if (view.kind !== 'holding') throw new Error('expected holding');

    expect(view.avgEntryPrice).toBe(100);
    expect(view.rungIndex).toBe(0);
    expect(view.rungTotal).toBe(3);
    // next rung (#1) trigger 0.97 → 100 * 0.97 = 97
    expect(view.nextBuy?.price).toBe(97);
    expect(view.nextBuy?.gapPct).toBeCloseTo((99 / 97 - 1) * 100, 6);
    // sell arm 1.05 → 105
    expect(view.sellArm?.price).toBeCloseTo(105, 6);
    // stop-loss 0.97 → 97
    expect(view.stopLoss?.price).toBeCloseTo(97, 6);
    // trailing stop: highSinceBuy 110 * 0.98 = 107.8
    expect(view.trailingStop?.price).toBeCloseTo(107.8, 6);
  });

  it('has no next grid buy once the top rung is reached', () => {
    const state = { avgEntryPrice: '100', currentGridTradeIndex: 2 };
    const view = deriveSignal(strategyOf(ttConfig, state), holdingOf('100'), '99');
    if (view.kind !== 'holding') throw new Error('expected holding');
    expect(view.nextBuy).toBeNull();
  });

  it('treats empty / zero sell thresholds as disabled', () => {
    const config = {
      ...ttConfig,
      sell: { stopLossPercentage: '0', triggerPercentage: '', trailingStopPercentage: '0' },
    };
    const state = { avgEntryPrice: '100', currentGridTradeIndex: 0, highSinceBuy: '110' };
    const view = deriveSignal(strategyOf(config, state), holdingOf('100'), '99');
    if (view.kind !== 'holding') throw new Error('expected holding');
    expect(view.sellArm).toBeNull();
    expect(view.stopLoss).toBeNull();
    expect(view.trailingStop).toBeNull();
  });

  it('renders the holding view from the canonical avgEntryPrice even when strategy state mirrors are null', () => {
    // The canonical `avg_entry_price` row is authoritative — the strategy
    // state mirror only updates when the worker processes a fill, so it
    // lags or stays null after a seed/restore. Keying the panel off the
    // mirror would render "flat" for a real held position.
    const view = deriveSignal(
      strategyOf(ttConfig, { avgEntryPrice: null, currentGridTradeIndex: null }),
      holdingOf('100'),
      '99',
    );
    if (view.kind !== 'holding') throw new Error('expected holding');
    expect(view.avgEntryPrice).toBe(100);
  });

  it('leaves gapPct null when the current price is unknown', () => {
    const state = { avgEntryPrice: '100', currentGridTradeIndex: 0 };
    const view = deriveSignal(strategyOf(ttConfig, state), holdingOf('100'), null);
    if (view.kind !== 'holding') throw new Error('expected holding');
    expect(view.nextBuy?.gapPct).toBeNull();
  });
});

describe('break-even stop signal', () => {
  const beConfig = (over?: Record<string, unknown>): unknown => ({
    ...ttConfig,
    sell: {
      ...ttConfig.sell,
      breakEven: { enabled: true, armAtPercentage: '1.01', floorPercentage: '1', ...over },
    },
  });

  it('surfaces the arm level before the stop is armed', () => {
    const state = { avgEntryPrice: '100', currentGridTradeIndex: 0, breakEvenArmed: false };
    const view = deriveSignal(strategyOf(beConfig(), state), holdingOf('100'), '100');
    if (view.kind !== 'holding') throw new Error('expected holding');
    expect(view.breakEven).toEqual({
      stage: 'arm',
      target: expect.objectContaining({ price: 101 }),
    });
  });

  it('surfaces the floor exit once armed and the trail is not yet active', () => {
    const state = {
      avgEntryPrice: '100',
      currentGridTradeIndex: 0,
      breakEvenArmed: true,
      highSinceBuy: null,
    };
    const view = deriveSignal(strategyOf(beConfig(), state), holdingOf('100'), '100');
    if (view.kind !== 'holding') throw new Error('expected holding');
    expect(view.breakEven).toEqual({
      stage: 'floor',
      target: expect.objectContaining({ price: 100 }),
    });
  });

  it('hides the break-even row once the profit trail has taken over', () => {
    // highSinceBuy set means the trail owns the position; break-even goes inert,
    // mirroring sell-gate.ts (the floor exit is gated on highSinceBuy === null).
    const state = {
      avgEntryPrice: '100',
      currentGridTradeIndex: 0,
      breakEvenArmed: true,
      highSinceBuy: '110',
    };
    const view = deriveSignal(strategyOf(beConfig(), state), holdingOf('100'), '108');
    if (view.kind !== 'holding') throw new Error('expected holding');
    expect(view.breakEven).toBeNull();
  });

  it('is null when break-even is disabled', () => {
    const state = { avgEntryPrice: '100', currentGridTradeIndex: 0 };
    const view = deriveSignal(strategyOf(ttConfig, state), holdingOf('100'), '100');
    if (view.kind !== 'holding') throw new Error('expected holding');
    expect(view.breakEven).toBeNull();
  });

  it('shows no break-even level when floorPercentage is unparseable (armed)', () => {
    // Mirror stays honest: a corrupted floor → the worker skips, so the panel
    // must not draw a floor exit it would not fire.
    const state = {
      avgEntryPrice: '100',
      currentGridTradeIndex: 0,
      breakEvenArmed: true,
      highSinceBuy: null,
    };
    const view = deriveSignal(
      strategyOf(beConfig({ floorPercentage: 'abc' }), state),
      holdingOf('100'),
      '100',
    );
    if (view.kind !== 'holding') throw new Error('expected holding');
    expect(view.breakEven).toBeNull();
  });

  it('shows no break-even level when armAtPercentage is unparseable (not armed)', () => {
    const state = { avgEntryPrice: '100', currentGridTradeIndex: 0, breakEvenArmed: false };
    const view = deriveSignal(
      strategyOf(beConfig({ armAtPercentage: 'abc' }), state),
      holdingOf('100'),
      '100',
    );
    if (view.kind !== 'holding') throw new Error('expected holding');
    expect(view.breakEven).toBeNull();
  });

  it('renders the break-even exit row in the ladder', () => {
    const state = {
      avgEntryPrice: '100',
      currentGridTradeIndex: 0,
      breakEvenArmed: true,
      highSinceBuy: null,
    };
    renderPanel({
      strategy: strategyOf(beConfig(), state),
      holding: holdingOf('100'),
      currentPrice: '100',
    });
    expect(screen.getByTestId('exit-row-break-even')).toBeInTheDocument();
  });
});

describe('general time-stop signal', () => {
  const tsConfig = (timeStopBars: number): unknown => ({
    ...ttConfig,
    candleInterval: '1h',
    sell: { ...ttConfig.sell, timeStopBars },
  });

  it('surfaces the time-stop for a stalled non-discovery position (trail not armed)', () => {
    const state = {
      avgEntryPrice: '100',
      currentGridTradeIndex: 0,
      entryAtMs: 1,
      highSinceBuy: null,
    };
    const view = deriveSignal(strategyOf(tsConfig(10), state), holdingOf('100'), '100');
    if (view.kind !== 'holding') throw new Error('expected holding');
    expect(view.timeStop).toEqual({ bars: 10, interval: '1h' });
  });

  it('hides the time-stop once the trail has armed (highSinceBuy set)', () => {
    const state = {
      avgEntryPrice: '100',
      currentGridTradeIndex: 0,
      entryAtMs: 1,
      highSinceBuy: '110',
    };
    const view = deriveSignal(strategyOf(tsConfig(10), state), holdingOf('100'), '108');
    if (view.kind !== 'holding') throw new Error('expected holding');
    expect(view.timeStop).toBeNull();
  });

  it('does not apply to a discovery entry (it uses the discovery time-stop)', () => {
    const state = {
      avgEntryPrice: '100',
      currentGridTradeIndex: 0,
      entryAtMs: 1,
      highSinceBuy: null,
      discoveryEntry: true,
    };
    const view = deriveSignal(strategyOf(tsConfig(10), state), holdingOf('100'), '100');
    if (view.kind !== 'holding') throw new Error('expected holding');
    expect(view.timeStop).toBeNull();
  });

  it('is null when timeStopBars is 0', () => {
    const state = {
      avgEntryPrice: '100',
      currentGridTradeIndex: 0,
      entryAtMs: 1,
      highSinceBuy: null,
    };
    const view = deriveSignal(strategyOf(tsConfig(0), state), holdingOf('100'), '100');
    if (view.kind !== 'holding') throw new Error('expected holding');
    expect(view.timeStop).toBeNull();
  });

  it('is null when entryAtMs is unknown (fail-safe — mirrors the worker guard)', () => {
    const state = {
      avgEntryPrice: '100',
      currentGridTradeIndex: 0,
      entryAtMs: null,
      highSinceBuy: null,
    };
    const view = deriveSignal(strategyOf(tsConfig(10), state), holdingOf('100'), '100');
    if (view.kind !== 'holding') throw new Error('expected holding');
    expect(view.timeStop).toBeNull();
  });

  it('renders the general time-stop row', () => {
    const state = {
      avgEntryPrice: '100',
      currentGridTradeIndex: 0,
      entryAtMs: 1,
      highSinceBuy: null,
    };
    renderPanel({
      strategy: strategyOf(tsConfig(10), state),
      holding: holdingOf('100'),
      currentPrice: '100',
    });
    expect(screen.getByTestId('symbol-signal-general-time-stop')).toBeInTheDocument();
  });
});

describe('SymbolSignalPanel', () => {
  it('renders the flat explainer when no position is held', () => {
    renderPanel({
      strategy: strategyOf(ttConfig, { avgEntryPrice: null }),
      holding: null,
      currentPrice: '100',
    });
    expect(screen.getByTestId('symbol-signal-flat')).toBeInTheDocument();
  });

  it('renders the exit ladder for a held position with the current-price divider', () => {
    const state = { avgEntryPrice: '100', currentGridTradeIndex: 0, highSinceBuy: '110' };
    renderPanel({
      strategy: strategyOf(ttConfig, state),
      holding: holdingOf('100'),
      currentPrice: '99',
    });
    expect(screen.getByTestId('symbol-signal-table')).toBeInTheDocument();
    expect(screen.getByTestId('exit-row-next-buy')).toBeInTheDocument();
    expect(screen.getByTestId('exit-row-stop-loss')).toBeInTheDocument();
    expect(screen.getByTestId('exit-row-current')).toBeInTheDocument();
  });

  it('renders the discovery time-stop row and no grid-buy row for a discovery single-entry', () => {
    const cfg = {
      ...ttConfig,
      candleInterval: '1h',
      sell: { ...ttConfig.sell, discoveryTimeStopBars: 3 },
    };
    const state = {
      avgEntryPrice: '100',
      currentGridTradeIndex: 0,
      highSinceBuy: '110',
      discoveryEntry: true,
      entryAtMs: 1_700_000_000_000,
    };
    renderPanel({
      strategy: strategyOf(cfg, state),
      holding: holdingOf('100'),
      currentPrice: '105',
    });
    // Drift (a): the discovery time-stop exit is now listed.
    expect(screen.getByTestId('symbol-signal-time-stop')).toBeInTheDocument();
    // Drift (b): the phantom grid-buy row is gone; an explanatory note replaces it.
    expect(screen.queryByTestId('exit-row-next-buy')).not.toBeInTheDocument();
    expect(screen.getByTestId('symbol-signal-discovery-note')).toBeInTheDocument();
  });

  it('flags the nearest exit (smallest gap among selling rows)', () => {
    // Armed trailing stop at 107.8 (high 110 * 0.98) is the active profit exit;
    // stop-loss is at 97. At price 108 the trailing stop is the nearest exit.
    const state = { avgEntryPrice: '100', currentGridTradeIndex: 0, highSinceBuy: '110' };
    renderPanel({
      strategy: strategyOf(ttConfig, state),
      holding: holdingOf('100'),
      currentPrice: '108',
    });
    expect(screen.getByTestId('exit-row-trailing')).toHaveAttribute('data-nearest', 'true');
    expect(screen.getByTestId('exit-row-stop-loss')).not.toHaveAttribute('data-nearest');
  });

  // --- regime exit ----------------------------------------------------------

  it('shows the regime SELLS-TO-CASH notice when held and the daily trend is bear', () => {
    const state = { avgEntryPrice: '100', currentGridTradeIndex: 0 };
    renderPanel({
      strategy: strategyOf(regimeExitConfig(3, 2), state),
      holding: holdingOf('100'),
      currentPrice: '99',
      // last 3 = [100,40,30] mean 56.7; recent 2 = [40,30] both below → bear.
      dailyCandlesResponse: dailyCandles([100, 100, 100, 40, 30]),
    });
    const regime = screen.getByTestId('symbol-signal-regime');
    expect(regime).toHaveAttribute('data-regime', 'bear');
    expect(regime).toHaveTextContent('SELLS TO CASH');
  });

  it('shows the regime countdown when held and partially confirmed', () => {
    const state = { avgEntryPrice: '100', currentGridTradeIndex: 0 };
    renderPanel({
      strategy: strategyOf(regimeExitConfig(3, 2), state),
      holding: holdingOf('100'),
      currentPrice: '99',
      // last 3 = [100,30,100] mean 76.7; recent 2 = [30,100] → one below.
      dailyCandlesResponse: dailyCandles([100, 100, 100, 30, 100]),
    });
    const regime = screen.getByTestId('symbol-signal-regime');
    expect(regime).toHaveAttribute('data-regime', 'watching');
    expect(regime).toHaveTextContent('1/2 daily closes below the line');
  });

  it('shows the entry-blocked notice when flat and the daily regime is bear', () => {
    renderPanel({
      strategy: strategyOf(regimeExitConfig(3, 2), { avgEntryPrice: null }),
      holding: null,
      currentPrice: '99',
      dailyCandlesResponse: dailyCandles([100, 100, 100, 40, 30]),
    });
    const regime = screen.getByTestId('symbol-signal-regime');
    expect(regime).toHaveAttribute('data-regime', 'bear');
    expect(regime).toHaveTextContent('Entries blocked');
  });

  // --- bull hold ------------------------------------------------------------

  it('shows the HOLDING-THROUGH-THE-BULL notice when held and the daily trend is bull', () => {
    const state = { avgEntryPrice: '100', highSinceBuy: '120', currentGridTradeIndex: 0 };
    renderPanel({
      strategy: strategyOf(bullHoldConfig('loose'), state),
      holding: holdingOf('100'),
      currentPrice: '118',
      // last 3 = [10,30,40] mean 26.7; recent 2 = [30,40] both above → bull.
      dailyCandlesResponse: dailyCandles([10, 10, 10, 30, 40]),
    });
    const bullHold = screen.getByTestId('symbol-signal-bull-hold');
    expect(bullHold).toHaveAttribute('data-bull-hold', 'holding');
    expect(bullHold).toHaveTextContent('HOLDING THROUGH THE BULL');
    // Invariant #3: the operator never sees the word "ATR".
    expect(bullHold.textContent ?? '').not.toMatch(/atr/i);
  });

  it('does not show the bull-hold notice when held but the daily trend is not a confirmed bull', () => {
    const state = { avgEntryPrice: '100', highSinceBuy: '120', currentGridTradeIndex: 0 };
    renderPanel({
      strategy: strategyOf(bullHoldConfig('normal'), state),
      holding: holdingOf('100'),
      currentPrice: '118',
      // recent 2 = [40,20] → only one above the line → inactive (no row).
      dailyCandlesResponse: dailyCandles([10, 10, 10, 40, 20]),
    });
    expect(screen.queryByTestId('symbol-signal-bull-hold')).toBeNull();
  });

  // --- bull pyramid ---------------------------------------------------------

  it('shows the pyramid add count and the next-add trigger price when held', () => {
    const state = { avgEntryPrice: '100', bullAddCount: 1, lastBullAddPrice: '105' };
    renderPanel({
      strategy: strategyOf(pyramidConfig(3, '0.05'), state),
      holding: holdingOf('100'),
      currentPrice: '107',
    });
    const pyramid = screen.getByTestId('symbol-signal-pyramid');
    expect(pyramid).toHaveAttribute('data-add-count', '1');
    expect(pyramid).toHaveTextContent('1 of 3 adds');
    // Next add spaced one step above the last add: 105 × 1.05 = 110.25.
    expect(pyramid).toHaveTextContent('110.25');
  });

  it('shows "add cap reached" once the pyramid is at maxAdds', () => {
    const state = { avgEntryPrice: '100', bullAddCount: 3, lastBullAddPrice: '130' };
    renderPanel({
      strategy: strategyOf(pyramidConfig(3, '0.05'), state),
      holding: holdingOf('100'),
      currentPrice: '140',
    });
    const pyramid = screen.getByTestId('symbol-signal-pyramid');
    expect(pyramid).toHaveTextContent('3 of 3 adds');
    expect(pyramid).toHaveTextContent('Add cap reached');
  });

  it('does not show the pyramid row when the pyramid is disabled', () => {
    renderPanel({
      strategy: strategyOf(ttConfig, { avgEntryPrice: '100', currentGridTradeIndex: 0 }),
      holding: holdingOf('100'),
      currentPrice: '101',
    });
    expect(screen.queryByTestId('symbol-signal-pyramid')).toBeNull();
  });

  it('renders no regime row when cash rotation is disabled', () => {
    const state = { avgEntryPrice: '100', currentGridTradeIndex: 0 };
    renderPanel({
      strategy: strategyOf(ttConfig, state),
      holding: holdingOf('100'),
      currentPrice: '99',
    });
    expect(screen.queryByTestId('symbol-signal-regime')).toBeNull();
  });

  // --- force-sell-on-Technicals row ----------------------------------------

  const forceSellConfig = (
    overrides: { whenSell?: boolean; whenStrongSell?: boolean; whenNeutral?: boolean } = {
      whenStrongSell: true,
    },
  ): unknown => ({
    ...ttConfig,
    technicals: {
      useOnlyWithinMin: 2,
      ifExpires: 'do-not-buy',
      intervals: [
        {
          interval: '1h',
          whenStrongBuy: false,
          whenBuy: false,
          whenSell: false,
          whenStrongSell: false,
          whenNeutral: false,
          ...overrides,
        },
      ],
    },
  });

  const technicalsResponse = (
    interval: string,
    recommendation: 'BUY' | 'SELL' | 'STRONG_SELL' | 'NEUTRAL' | 'STRONG_BUY',
    ageMs = 0,
  ): TechnicalsResponse => ({
    items: [
      {
        symbol: SYMBOL,
        signals: [
          {
            interval,
            signal: {
              symbol: SYMBOL,
              recommendation,
              maRecommendation: null,
              oscRecommendation: null,
              receivedAtMs: Date.now() - ageMs,
              indicators: null,
            },
          },
        ],
      },
    ],
    fetchedAt: new Date().toISOString(),
    technicals: {
      useOnlyWithinMin: 2,
      ifExpires: 'do-not-buy',
      intervals: [
        {
          interval,
          whenStrongBuy: false,
          whenBuy: false,
          whenSell: false,
          whenStrongSell: true,
          whenNeutral: false,
        },
      ],
    },
    gateActive: true,
  });

  it('hides the force-sell row when no interval has a sell-side toggle enabled', () => {
    const state = { avgEntryPrice: '100', currentGridTradeIndex: 0 };
    renderPanel({
      strategy: strategyOf(ttConfig, state),
      holding: holdingOf('100'),
      currentPrice: '101',
    });
    expect(screen.queryByTestId('symbol-signal-force-sell')).toBeNull();
  });

  it('shows above-trigger status when current >= trigger', () => {
    const state = { avgEntryPrice: '100', currentGridTradeIndex: 0 };
    renderPanel({
      strategy: strategyOf(forceSellConfig(), state),
      holding: holdingOf('100'),
      currentPrice: '110', // trigger = 100 * 1.05 = 105
    });
    const status = screen.getByTestId('symbol-signal-force-sell-status');
    expect(status).toHaveAttribute('data-status', 'above-trigger');
    expect(status).toHaveTextContent('price above trigger');
  });

  it('shows in-loss status when current <= last-buy', () => {
    const state = { avgEntryPrice: '100', currentGridTradeIndex: 0 };
    renderPanel({
      strategy: strategyOf(forceSellConfig(), state),
      holding: holdingOf('100'),
      currentPrice: '99',
    });
    const status = screen.getByTestId('symbol-signal-force-sell-status');
    expect(status).toHaveAttribute('data-status', 'in-loss');
    expect(status).toHaveTextContent('in loss');
  });

  it('shows waiting-signal when below trigger AND in profit AND no signal data', () => {
    const state = { avgEntryPrice: '100', currentGridTradeIndex: 0 };
    renderPanel({
      strategy: strategyOf(forceSellConfig(), state),
      holding: holdingOf('100'),
      currentPrice: '103', // > 100 (in profit) AND < 105 (below trigger)
    });
    const status = screen.getByTestId('symbol-signal-force-sell-status');
    expect(status).toHaveAttribute('data-status', 'waiting-signal');
    expect(status).toHaveTextContent('awaiting matching signal on 1h');
  });

  it('shows FIRES NOW when a matching fresh signal lands on a sell-side toggle', () => {
    const state = { avgEntryPrice: '100', currentGridTradeIndex: 0 };
    renderPanel({
      strategy: strategyOf(forceSellConfig({ whenStrongSell: true }), state),
      holding: holdingOf('100'),
      currentPrice: '103',
      technicalsResponse: technicalsResponse('1h', 'STRONG_SELL', 5_000),
    });
    const status = screen.getByTestId('symbol-signal-force-sell-status');
    expect(status).toHaveAttribute('data-status', 'would-fire');
    expect(status).toHaveTextContent('FIRES NOW · STRONG_SELL on 1h');
  });

  it('ignores a stale signal — falls back to waiting-signal', () => {
    const state = { avgEntryPrice: '100', currentGridTradeIndex: 0 };
    renderPanel({
      strategy: strategyOf(forceSellConfig({ whenStrongSell: true }), state),
      holding: holdingOf('100'),
      currentPrice: '103',
      // useOnlyWithinMin = 2 → 120s window; age = 10min → stale.
      technicalsResponse: technicalsResponse('1h', 'STRONG_SELL', 10 * 60_000),
    });
    expect(screen.getByTestId('symbol-signal-force-sell-status')).toHaveAttribute(
      'data-status',
      'waiting-signal',
    );
  });
});
