import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { TickInput } from '@app/strategy-core';
import { computeTick, KV_VALUE_PREFIX } from '../src/tick.js';
import {
  initialRebalanceState,
  type RebalanceBundle,
  type RebalanceConfig,
  type RebalanceState,
} from '../src/schema.js';

type RInput = TickInput<RebalanceConfig, RebalanceState, RebalanceBundle>;

const symbolInfo = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  filters: { stepSize: '0.001', minQty: '0', minNotional: '0', tickSize: '0.01' },
} as unknown as RInput['market']['symbolInfo'];

const mkInput = (over: {
  config?: Partial<RebalanceConfig>;
  state?: Partial<RebalanceState>;
  profileKv?: Record<string, unknown>;
  freeQuote?: string | null;
  candles?: { closeTimeMs: number }[];
  symbol?: string;
  price?: string;
}): RInput =>
  ({
    clock: { nowMs: () => 0 },
    rng: { next: () => 0 },
    trigger: { kind: 'candle-close', interval: '1h', openTimeMs: 0 },
    profile: {
      id: 'p1',
      userId: 'u1',
      binanceMode: 'test',
      status: 'running',
      strategyVersion: '1.0.0',
    },
    config: {
      enabled: true,
      candleInterval: '1h',
      targets: [{ symbol: 'BTCUSDT', weight: '0.5' }],
      driftThreshold: '0.05',
      minTradeQuote: '10',
      ...over.config,
    } as RebalanceConfig,
    state: { ...initialRebalanceState(), ...over.state },
    market: {
      symbol: over.symbol ?? 'BTCUSDT',
      currentPrice: over.price ?? '100',
      candlesByInterval: { '1h': over.candles ?? [{ closeTimeMs: 1_700_000_000_000 }] },
      symbolInfo,
    } as unknown as RInput['market'],
    account: {
      balances:
        over.freeQuote === null
          ? {}
          : {
              USDT: {
                asset: 'USDT',
                free: new Decimal(over.freeQuote ?? '10000'),
                locked: new Decimal(0),
              },
            },
    } as unknown as RInput['account'],
    openOrders: [],
    bundle: {},
    limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10_000 },
    ...(over.profileKv ? { profileKv: over.profileKv } : {}),
  }) as unknown as RInput;

describe('computeTick', () => {
  it('always publishes its own value to the KV store', () => {
    const out = computeTick(mkInput({ state: { heldQuantity: '5' } }));
    const setKv = out.decisions.find((d) => d.type === 'set-kv');
    expect(setKv).toEqual({ type: 'set-kv', key: `${KV_VALUE_PREFIX}BTCUSDT`, value: '500' });
  });

  it('emits a market order toward target when drifted, with a deterministic clientOrderId', () => {
    // own 100 (1@100), sibling 900 → weight 0.1 vs target 0.5 → BUY 4.
    const out = computeTick(
      mkInput({ state: { heldQuantity: '1' }, profileKv: { 'rebalance:value:ETHUSDT': '900' } }),
    );
    const order = out.decisions.find((d) => d.type === 'place-order');
    expect(order).toMatchObject({
      type: 'place-order',
      intent: { symbol: 'BTCUSDT', side: 'BUY', reason: 'rebalance' },
      params: { type: 'MARKET', quantity: '4' },
    });
    expect((order as { intent: { clientOrderId: string } }).intent.clientOrderId).toMatch(
      /^rb-.*-b$/,
    );
  });

  it('publishes but does not trade when disabled (no place-order)', () => {
    const out = computeTick(mkInput({ config: { enabled: false }, state: { heldQuantity: '1' } }));
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
    expect(out.decisions.some((d) => d.type === 'set-kv')).toBe(true);
  });

  it('ignores non-value KV keys and the symbol’s own value when weighting siblings', () => {
    const out = computeTick(
      mkInput({
        state: { heldQuantity: '1' },
        profileKv: {
          'rebalance:value:BTCUSDT': '99999', // self — must be ignored
          'other:key': 'junk', // wrong prefix — ignored
          'rebalance:value:ETHUSDT': '900',
        },
      }),
    );
    expect(out.decisions.find((d) => d.type === 'place-order')).toMatchObject({
      params: { quantity: '4' },
    });
  });

  it('treats invalid config decimals and a non-array targets as safe fallbacks', () => {
    const out = computeTick(
      mkInput({
        config: {
          driftThreshold: 'not-a-number' as unknown as string,
          minTradeQuote: '' as unknown as string,
          targets: 'oops' as unknown as RebalanceConfig['targets'],
        },
        state: { heldQuantity: '1' },
      }),
    );
    // non-array targets → no target for the symbol → no trade, still publishes.
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
    expect(out.decisions.some((d) => d.type === 'set-kv')).toBe(true);
  });

  it('falls back to candleClose 0 when the interval window is empty and reads zero quote when the balance is absent', () => {
    const out = computeTick(
      mkInput({
        state: { heldQuantity: '1' },
        profileKv: { 'rebalance:value:ETHUSDT': '900' },
        candles: [],
        freeQuote: null,
      }),
    );
    // No quote cash → the underweight buy is held (no order), value still published.
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
    expect(out.metrics.some((m) => m.name === 'rebalance.decision')).toBe(true);
  });

  it('reads a flat position (heldQuantity null) as zero value', () => {
    const out = computeTick(mkInput({ state: { heldQuantity: null } }));
    expect(out.decisions.find((d) => d.type === 'set-kv')).toMatchObject({ value: '0' });
  });

  it('treats a non-string sibling KV value as zero (tolerant parse)', () => {
    // A numeric KV value (not a decimal-string) falls back to 0, so the sibling
    // adds nothing: own 500 becomes the whole basket → weight 1.0, overweight
    // vs target 0.5 → SELL. (Had 900 parsed, it would have been an underweight BUY.)
    const out = computeTick(
      mkInput({
        state: { heldQuantity: '5' },
        profileKv: { 'rebalance:value:ETHUSDT': 900 as unknown as string },
      }),
    );
    expect(out.decisions.find((d) => d.type === 'place-order')).toMatchObject({
      intent: { side: 'SELL' },
    });
  });

  it('places a rebalance order with candleClose 0 when the interval window is empty', () => {
    const out = computeTick(
      mkInput({
        state: { heldQuantity: '1' },
        profileKv: { 'rebalance:value:ETHUSDT': '900' },
        candles: [],
      }),
    );
    expect(out.decisions.find((d) => d.type === 'place-order')).toMatchObject({
      params: { quantity: '4' },
    });
  });

  it('falls back to candleClose 0 when no window exists for the configured interval', () => {
    // config interval '4h' is absent from candlesByInterval (only '1h') → `?? []`.
    const out = computeTick(
      mkInput({
        config: { candleInterval: '4h' },
        state: { heldQuantity: '1' },
        profileKv: { 'rebalance:value:ETHUSDT': '900' },
      }),
    );
    const order = out.decisions.find((d) => d.type === 'place-order');
    expect((order as { intent: { clientOrderId: string } }).intent.clientOrderId).toMatch(/^rb-/);
  });
});

/** Candle window with close prices for the momentum score; closeTimeMs is incidental. */
const mc = (closes: string[]): { closeTimeMs: number }[] =>
  closes.map((close, i) => ({ closeTimeMs: i + 1, close })) as unknown as { closeTimeMs: number }[];

describe('computeTick — momentum mode', () => {
  it('publishes the symbol’s trailing-return score to the KV store', () => {
    const out = computeTick(
      mkInput({
        config: {
          weightMode: 'momentum',
          momentum: { lookbackCandles: 2, topK: 1 },
        } as Partial<RebalanceConfig>,
        state: { heldQuantity: '1' },
        candles: mc(['100', '110', '121']),
      }),
    );
    // 121/100 − 1 = 0.21, published under the momentum namespace.
    expect(out.decisions).toContainEqual({
      type: 'set-kv',
      key: 'rebalance:momentum:BTCUSDT',
      value: '0.21',
    });
  });

  it('drops the symbol from the KV when the interval window is absent (no score)', () => {
    // No momentum sub-config → defaults (lookback 30); interval '4h' is absent from
    // the '1h'-only window map → `?? []` → empty window → no score.
    const out = computeTick(
      mkInput({
        config: { weightMode: 'momentum', candleInterval: '4h' } as Partial<RebalanceConfig>,
        state: { heldQuantity: '0' },
        candles: mc(['100', '110']),
      }),
    );
    expect(out.decisions).toContainEqual({ type: 'delete-kv', key: 'rebalance:momentum:BTCUSDT' });
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
  });

  it('tolerates raw-string momentum tuning and a non-array targets (unparsed config)', () => {
    const out = computeTick(
      mkInput({
        config: {
          weightMode: 'momentum',
          momentum: { lookbackCandles: '2', topK: 'oops' },
          targets: 'oops', // non-array → universe size 0 → no cold-start gate
        } as unknown as Partial<RebalanceConfig>,
        state: { heldQuantity: '1' },
        candles: mc(['100', '110', '121']),
      }),
    );
    // lookback '2' parses; topK 'oops' falls back to 3 — the score still publishes.
    expect(out.decisions).toContainEqual({
      type: 'set-kv',
      key: 'rebalance:momentum:BTCUSDT',
      value: '0.21',
    });
  });

  it('holds a held position when the symbol cannot be scored — a data gap never liquidates', () => {
    const out = computeTick(
      mkInput({
        config: {
          weightMode: 'momentum',
          momentum: { lookbackCandles: 30, topK: 1 },
        } as Partial<RebalanceConfig>,
        state: { heldQuantity: '5' }, // held
        candles: mc(['100', '110']), // too short to score
      }),
    );
    expect(out.decisions).toContainEqual({ type: 'delete-kv', key: 'rebalance:momentum:BTCUSDT' });
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false); // NOT sold
  });

  it('waits for the KV to converge before deploying (no buy on a cold first cycle)', () => {
    // 3-symbol universe, topK 2 → needs min(2,3)=2 scored, but only self has → no deploy yet.
    const out = computeTick(
      mkInput({
        config: {
          weightMode: 'momentum',
          momentum: { lookbackCandles: 2, topK: 2 },
          targets: [
            { symbol: 'BTCUSDT', weight: '0.34' },
            { symbol: 'ETHUSDT', weight: '0.33' },
            { symbol: 'SOLUSDT', weight: '0.33' },
          ],
          basketBudgetQuote: '1000',
        } as Partial<RebalanceConfig>,
        state: { heldQuantity: '0' },
        candles: mc(['100', '110', '121']),
        freeQuote: '10000',
      }),
    );
    expect(out.decisions).toContainEqual({
      type: 'set-kv',
      key: 'rebalance:momentum:BTCUSDT',
      value: '0.21',
    });
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false); // cold KV → no buy
  });

  it('rotates a held symbol to cash when it ranks below the top-K, ignoring junk KV entries', () => {
    // self score 0.01 (weak); ETH 0.5 (strong) wins the single slot → self rotates out.
    const out = computeTick(
      mkInput({
        config: {
          weightMode: 'momentum',
          momentum: { lookbackCandles: 2, topK: 1 },
        } as Partial<RebalanceConfig>,
        state: { heldQuantity: '5' },
        candles: mc(['100', '100', '101']),
        profileKv: {
          'rebalance:momentum:BTCUSDT': '0.9', // self — ignored, score is recomputed
          'other:key': 'x', // wrong prefix — ignored
          'rebalance:momentum:ZZZUSDT': 'notnum', // unparseable — skipped
          'rebalance:momentum:YYYUSDT': 'Infinity', // non-finite — skipped
          'rebalance:momentum:WWWUSDT': 0.3 as unknown as string, // non-string — coerced via String()
          'rebalance:momentum:ETHUSDT': '0.5', // valid strong sibling
        },
      }),
    );
    expect(out.decisions.find((d) => d.type === 'place-order')).toMatchObject({
      intent: { symbol: 'BTCUSDT', side: 'SELL' },
    });
    expect(out.metrics.find((m) => m.name === 'rebalance.decision')?.tags).toMatchObject({
      reason: 'rotate-exit',
    });
  });
});

// Structural guard on the retry-model invariant the worker's `applyAll` enforces
// by throwing: a single tick must emit at most one place-order, else a failed
// apply's re-emit (the un-advanced state) would re-place an order that already
// landed. Rebalance has no golden corpus, so this drives representative
// place-order-producing scenarios through `computeTick` and counts placements
// per output. The non-vacuity guard asserts at least one scenario actually
// placed, so the ≤1 bound is not trivially satisfied by all-empty outputs.
describe('computeTick — at most one place-order per tick', () => {
  const scenarios: RInput[] = [
    // Drift BUY: underweight vs target → one BUY.
    mkInput({ state: { heldQuantity: '1' }, profileKv: { 'rebalance:value:ETHUSDT': '900' } }),
    // Drift SELL: overweight (numeric sibling parses to 0) → one SELL.
    mkInput({
      state: { heldQuantity: '5' },
      profileKv: { 'rebalance:value:ETHUSDT': 900 as unknown as string },
    }),
    // Momentum rotate-exit: self ranks below top-K → one SELL to cash.
    mkInput({
      config: {
        weightMode: 'momentum',
        momentum: { lookbackCandles: 2, topK: 1 },
      } as Partial<RebalanceConfig>,
      state: { heldQuantity: '5' },
      candles: mc(['100', '100', '101']),
      profileKv: { 'rebalance:momentum:ETHUSDT': '0.5' },
    }),
    // Disabled: publishes value, never trades → zero placements.
    mkInput({ config: { enabled: false }, state: { heldQuantity: '1' } }),
    // No quote cash: underweight buy is held → zero placements.
    mkInput({ state: { heldQuantity: '1' }, freeQuote: null }),
  ];

  it('emits at most one place-order across representative scenarios', () => {
    const placementsPerTick = scenarios.map(
      (input) => computeTick(input).decisions.filter((d) => d.type === 'place-order').length,
    );
    // Non-vacuity: at least one scenario actually placed, so the ≤1 bound below
    // is a real constraint rather than trivially true on all-empty outputs.
    expect(placementsPerTick.some((n) => n === 1)).toBe(true);
    expect(Math.max(...placementsPerTick)).toBeLessThanOrEqual(1);
  });
});
