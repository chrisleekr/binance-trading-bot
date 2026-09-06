import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type {
  AccountSnapshot,
  AccountSnapshotWire,
  PreviewModel,
  PreviewRow,
  SymbolInfo,
} from '@app/strategy-core';

import { momentumPreviewLevels, momentumPreviewDataNeeds } from '../src/preview.js';

import { MomentumConfigSchema, type MomentumConfig } from '../src/index.js';
import { resolveEntryBudget } from '../src/sizing.js';
import { computeEntryQuantity, entryStopFloor } from '../src/quantity.js';

const FILTERS: SymbolInfo['filters'] = {
  minNotional: '10',
  tickSize: '0.01',
  stepSize: '0.001',
  minQty: '0.001',
  maxQty: '100000',
  minPrice: '0.01',
  maxPrice: '1000000',
};

// Flat candle series so the slow EMA is exactly its constant close — the entry
// band math becomes a clean `close * (1 + margin)` with no EMA recompute here.
const FLAT_CLOSES = ['10', '10', '10', '10'] as const;
const mkCandles = (closes: readonly string[]) =>
  closes.map((c, i) => ({
    openTimeMs: i * 3_600_000,
    closeTimeMs: (i + 1) * 3_600_000,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: '1',
    isClosed: true,
  }));

const cfg = (over: Record<string, unknown> = {}): MomentumConfig =>
  MomentumConfigSchema.parse({
    candleInterval: '1h',
    entrySizing: { mode: 'fixed', amount: '140' },
    ema: { fast: 2, slow: 3 },
    trailingStopPct: '0.05',
    entryMarginPct: '0.02',
    protectiveStop: { enabled: true, limitOffsetPercentage: '0.98' },
    trendFilter: { enabled: true, maType: 'sma', period: 3 },
    ...over,
  });

// Decimal snapshot for the direct resolveEntryBudget/sizing assertions.
const RICH_ACCOUNT: AccountSnapshot = {
  balances: { USDT: { asset: 'USDT', free: new Decimal('100000'), locked: new Decimal('0') } },
};
// Same balances in wire form — what the preview input now carries.
const RICH_ACCOUNT_WIRE: AccountSnapshotWire = {
  balances: { USDT: { free: '100000', locked: '0' } },
};

// The closed window every direct oracle call re-measures the stop distance from; the preview builds its rows off the same series.
const PREVIEW_CANDLES = mkCandles(FLAT_CLOSES);
const bandCtx = (price: string) => ({ price, candles: PREVIEW_CANDLES });

// A modest wallet, so a plausible riskPct actually binds: at 1000 equity and a 5% stop, risking 0.5% caps the buy at 100 against the 140 entry sizing allows.
const MODEST_ACCOUNT: AccountSnapshot = {
  balances: { USDT: { asset: 'USDT', free: new Decimal('1000'), locked: new Decimal('0') } },
};
const MODEST_ACCOUNT_WIRE: AccountSnapshotWire = {
  balances: { USDT: { free: '1000', locked: '0' } },
};

const rows = (model: PreviewModel): PreviewRow[] => model.sections.flatMap((s) => s.rows);
const row = (model: PreviewModel, code: string): PreviewRow | undefined =>
  rows(model).find((r) => r.code === code);

const previewInput = (
  config: MomentumConfig,
  account: AccountSnapshotWire,
  candles = PREVIEW_CANDLES,
  filters = FILTERS,
  currentPrice = '10',
) => ({
  config,
  state: null,
  entryPrice: null,
  currentPrice,
  filters,
  candles,
  account,
  quoteAsset: 'USDT',
});

// A rising series with a constant step, so every true range is exactly 1 and ATR over its first full window is exactly 1. Non-flat on purpose: a flat series has ATR 0, which is `risk-sizing-unavailable` whether the window arrived or not, and would make the case below blind to an empty one.
const STEP_CANDLES = mkCandles(['10', '11', '12', '13']);

describe('momentumPreviewLevels — flat state with a configured entry', () => {
  it('projects the entry band at slowEMA*(1+margin) as an informational row (no trigger)', () => {
    const config = cfg();
    const model = momentumPreviewLevels(previewInput(config, RICH_ACCOUNT_WIRE));
    const entry = row(model, 'entry');

    // slowEMA of a flat-10 series is 10; band = 10 * (1 + 0.02) = 10.2.
    expect(entry).toBeDefined();
    expect(entry?.tone).toBe('entry');
    // The band is the fast-EMA cross threshold, not a currentPrice trigger, so
    // it is never a drift-gate trigger (would false-fail on a post-close dip).
    expect(entry?.trigger).toBeUndefined();
    expect(entry?.triggerWhen).toBeUndefined();
    expect(entry?.price).toBe(new Decimal('10').mul(new Decimal('1').plus('0.02')).toString());
  });

  it('sizes the entry row exactly as computeEntryQuantity would at the band price', () => {
    const config = cfg();
    const model = momentumPreviewLevels(previewInput(config, RICH_ACCOUNT_WIRE));
    const entry = row(model, 'entry');
    if (entry?.price === undefined) throw new Error('expected an entry row with a price');

    const budget = resolveEntryBudget(config, RICH_ACCOUNT, 'USDT', bandCtx(entry.price));
    if (!('budget' in budget)) throw new Error('expected a fundable budget');
    const expected = computeEntryQuantity(
      budget.budget,
      entry.price,
      FILTERS,
      entryStopFloor(config, PREVIEW_CANDLES, entry.price),
    );
    if (!('quantity' in expected)) throw new Error('expected a sizable quantity');

    expect(entry.quantity).toBe(expected.quantity);
  });

  it('refuses in the preview what computeEntryQuantity refuses at the same stop floor', () => {
    const config = cfg({
      entrySizing: { mode: 'fixed', amount: '0.00012' },
      trailingStopPct: '0.1',
      entryMarginPct: '0',
    });
    const zecFilters = {
      ...FILTERS,
      minNotional: '0.0001',
      tickSize: '0.000001',
      stepSize: '0.001',
      minQty: '0.001',
    };
    const zecCandles = mkCandles(['0.0118', '0.0118', '0.0118', '0.0118']);
    const model = momentumPreviewLevels(
      previewInput(config, RICH_ACCOUNT_WIRE, zecCandles, zecFilters, '0.0118'),
    );
    const entry = row(model, 'entry');
    if (entry?.price === undefined) throw new Error('expected an entry row with a price');

    const budget = resolveEntryBudget(config, RICH_ACCOUNT, 'USDT', {
      price: entry.price,
      candles: zecCandles,
    });
    if (!('budget' in budget)) throw new Error('expected a fundable budget');
    const expected = computeEntryQuantity(
      budget.budget,
      entry.price,
      zecFilters,
      entryStopFloor(config, zecCandles, entry.price),
    );
    expect(expected).toEqual({ skip: 'entry-below-stop-notional' });
    expect(entry.skip).toBe('entry-below-stop-notional');
  });

  it('projects the initial trailing stop at entry*(1-trailingStopPct)', () => {
    const model = momentumPreviewLevels(previewInput(cfg(), RICH_ACCOUNT_WIRE));
    const entry = row(model, 'entry');
    const trail = row(model, 'trail');
    if (entry?.price === undefined) throw new Error('expected an entry row with a price');

    expect(trail).toBeDefined();
    expect(trail?.tone).toBe('trail');
    expect(trail?.price).toBe(
      new Decimal(entry.price).mul(new Decimal('1').minus('0.05')).toString(),
    );
  });

  it('projects the protective-stop trigger below, with a limit at stop*limitOffset', () => {
    const model = momentumPreviewLevels(previewInput(cfg(), RICH_ACCOUNT_WIRE));
    const ps = row(model, 'protective-stop');
    if (ps?.price === undefined) throw new Error('expected a protective-stop row with a price');

    expect(ps.triggerWhen).toBe('below');
    expect(ps.limitPrice).toBe(new Decimal(ps.price).mul('0.98').toString());
  });

  it('projects the macro trend line as an informational neutral row', () => {
    const model = momentumPreviewLevels(previewInput(cfg(), RICH_ACCOUNT_WIRE));
    const trend = row(model, 'trend');

    expect(trend).toBeDefined();
    expect(trend?.tone).toBe('neutral');
    // sma(3) of a flat-10 series is 10.
    expect(trend?.price).toBe('10');
  });

  it('labels each row in plain operator language', () => {
    const model = momentumPreviewLevels(previewInput(cfg(), RICH_ACCOUNT_WIRE));
    expect(row(model, 'entry')?.label).toBe('Entry band');
    expect(row(model, 'trail')?.label).toBe('Trailing stop');
    expect(row(model, 'protective-stop')?.label).toBe('Protective stop');
    expect(row(model, 'trend')?.label).toBe('Trend line');
  });

  it('surfaces the typed sizing skip when the entry cannot be funded', () => {
    // amount 5 at a ~10 band -> notional below minNotional 10 -> min-notional skip.
    const poor = cfg({ entrySizing: { mode: 'fixed', amount: '5' }, entryMarginPct: '0' });
    const model = momentumPreviewLevels(previewInput(poor, RICH_ACCOUNT_WIRE));
    const entry = row(model, 'entry');
    if (entry?.price === undefined) throw new Error('expected an entry row with a price');

    const budget = resolveEntryBudget(poor, RICH_ACCOUNT, 'USDT', bandCtx(entry.price));
    if (!('budget' in budget)) throw new Error('expected a resolved budget');
    const sized = computeEntryQuantity(
      budget.budget,
      entry.price,
      FILTERS,
      entryStopFloor(poor, PREVIEW_CANDLES, entry.price),
    );
    if (!('skip' in sized)) throw new Error('expected a typed sizing skip');

    expect(entry.skip).toBe(sized.skip);
  });

  it('sizes the entry row through the risk cap, below what entry sizing alone would buy', () => {
    const config = cfg({ riskSizing: { enabled: true, riskPct: '0.005' } });
    const model = momentumPreviewLevels(previewInput(config, MODEST_ACCOUNT_WIRE));
    const entry = row(model, 'entry');
    if (entry?.price === undefined) throw new Error('expected an entry row with a price');

    const budget = resolveEntryBudget(config, MODEST_ACCOUNT, 'USDT', bandCtx(entry.price));
    if (!('budget' in budget)) throw new Error('expected a fundable budget');
    const expected = computeEntryQuantity(
      budget.budget,
      entry.price,
      FILTERS,
      entryStopFloor(config, PREVIEW_CANDLES, entry.price),
    );
    if (!('quantity' in expected)) throw new Error('expected a sizable quantity');
    expect(entry.quantity).toBe(expected.quantity);

    // Matching the oracle alone would pass with the cap unwired on both sides. The same config with the block off must buy strictly more, which is the only assertion that proves the row moved.
    const uncapped = momentumPreviewLevels(
      previewInput(cfg({ riskSizing: { enabled: false, riskPct: '0.005' } }), MODEST_ACCOUNT_WIRE),
    );
    const uncappedQty = row(uncapped, 'entry')?.quantity;
    if (uncappedQty === undefined) throw new Error('expected an uncapped quantity');
    expect(new Decimal(entry.quantity ?? '0').lt(uncappedQty)).toBe(true);
  });

  it('measures the ATR stop distance off the window it was handed, not an empty one', () => {
    // The only case that can tell the real closed window from an empty one: the ATR stop is on with a period the window satisfies, so a dropped window would flip a sized row into a `risk-sizing-unavailable` skip. That is the preview lying about size while the tick funds the entry perfectly well, and no replay fixture carries either block, so `assertPreviewTickAgreement` cannot catch it.
    const config = cfg({
      atrTrailingStop: { enabled: true, period: 3, multiple: '2' },
      riskSizing: { enabled: true, riskPct: '0.005' },
    });
    const model = momentumPreviewLevels(previewInput(config, MODEST_ACCOUNT_WIRE, STEP_CANDLES));
    const entry = row(model, 'entry');
    if (entry?.price === undefined) throw new Error('expected an entry row with a price');
    expect(entry.skip).toBeUndefined();

    const budget = resolveEntryBudget(config, MODEST_ACCOUNT, 'USDT', {
      price: entry.price,
      candles: STEP_CANDLES,
    });
    if (!('budget' in budget)) throw new Error('expected a fundable budget');
    const expected = computeEntryQuantity(
      budget.budget,
      entry.price,
      FILTERS,
      entryStopFloor(config, STEP_CANDLES, entry.price),
    );
    if (!('quantity' in expected)) throw new Error('expected a sizable quantity');
    expect(entry.quantity).toBe(expected.quantity);

    // And the cap actually bound on this window, so the equality above is not just two identical uncapped figures.
    const uncapped = momentumPreviewLevels(
      previewInput(
        cfg({
          atrTrailingStop: { enabled: true, period: 3, multiple: '2' },
          riskSizing: { enabled: false, riskPct: '0.005' },
        }),
        MODEST_ACCOUNT_WIRE,
        STEP_CANDLES,
      ),
    );
    const uncappedQty = row(uncapped, 'entry')?.quantity;
    if (uncappedQty === undefined) throw new Error('expected an uncapped quantity');
    expect(new Decimal(entry.quantity ?? '0').lt(uncappedQty)).toBe(true);
  });

  it('sizes the entry row off the closed window alone when a forming candle trails it', () => {
    // Only closed candles may set the stop distance an entry size is derived from, because a forming bar keeps moving and would make the quoted quantity non-deterministic within a tick and put this row out of step with the trail row, which is built from the filtered window.
    const config = cfg({
      atrTrailingStop: { enabled: true, period: 3, multiple: '2' },
      riskSizing: { enabled: true, riskPct: '0.005' },
    });
    const withForming = [
      ...STEP_CANDLES,
      {
        openTimeMs: 4 * 3_600_000,
        closeTimeMs: 5 * 3_600_000,
        open: '40',
        high: '40',
        low: '40',
        close: '40',
        volume: '1',
        isClosed: false,
      },
    ];
    const model = momentumPreviewLevels(previewInput(config, MODEST_ACCOUNT_WIRE, withForming));
    const entry = row(model, 'entry');
    if (entry?.price === undefined) throw new Error('expected an entry row with a price');

    const budget = resolveEntryBudget(config, MODEST_ACCOUNT, 'USDT', {
      price: entry.price,
      candles: STEP_CANDLES,
    });
    if (!('budget' in budget)) throw new Error('expected a fundable budget');
    const expected = computeEntryQuantity(
      budget.budget,
      entry.price,
      FILTERS,
      entryStopFloor(config, STEP_CANDLES, entry.price),
    );
    if (!('quantity' in expected)) throw new Error('expected a sizable quantity');
    expect(entry.quantity).toBe(expected.quantity);
    expect(entry.skip).toBeUndefined();

    // And the spike is one the cap would really have felt, so the equality above is the filter holding rather than a bar that changed nothing.
    expect(
      resolveEntryBudget(config, MODEST_ACCOUNT, 'USDT', {
        price: entry.price,
        candles: withForming,
      }),
    ).toEqual({ skip: 'risk-sizing-unavailable' });
  });

  it('surfaces risk-sizing-unavailable when the ATR window is too short to measure the stop', () => {
    // ATR(14) needs 15 candles and the preview window has 4 — long enough for the slow EMA, so the row is built and carries the skip rather than the section being dropped.
    const config = cfg({
      atrTrailingStop: { enabled: true, period: 14 },
      riskSizing: { enabled: true, riskPct: '0.005' },
    });
    // STEP_CANDLES, not the flat default: a flat window's ATR is exactly zero, which refuses through the divisor check instead, so the assertion could not tell the length guard from that one.
    const model = momentumPreviewLevels(previewInput(config, MODEST_ACCOUNT_WIRE, STEP_CANDLES));
    const entry = row(model, 'entry');

    expect(entry?.skip).toBe('risk-sizing-unavailable');
    expect(entry?.quantity).toBeUndefined();
  });
});

describe('momentumPreviewDataNeeds', () => {
  it('needs no extra candle history beyond the tick window', () => {
    expect(momentumPreviewDataNeeds(cfg())).toEqual([]);
  });
});

const held = (over: Record<string, unknown> = {}) => ({
  schemaVersion: '1.0.0',
  entryPrice: '100',
  highSinceEntry: '120',
  heldQuantity: '1',
  lastEntryCandleMs: null,
  ...over,
});

describe('momentumPreviewLevels — defensive / branch coverage', () => {
  const input = (config: unknown, over: Record<string, unknown> = {}) =>
    ({
      config,
      state: null,
      entryPrice: null,
      currentPrice: '10',
      filters: FILTERS,
      candles: mkCandles(FLAT_CLOSES),
      account: RICH_ACCOUNT_WIRE,
      quoteAsset: 'USDT',
      ...over,
    }) as never;

  it('returns an empty model when the candle window is too short for the slow EMA', () => {
    const model = momentumPreviewLevels(input(cfg(), { candles: mkCandles(['10', '10']) }));
    expect(model.sections).toEqual([]);
  });

  it('returns an empty model when a candle close is unparseable (EMA throws)', () => {
    const bad = mkCandles(FLAT_CLOSES).map((c) => ({ ...c, close: 'abc' }));
    expect(momentumPreviewLevels(input(cfg(), { candles: bad })).sections).toEqual([]);
  });

  it('returns an empty model when ema.slow is absent (unparsed config)', () => {
    const raw = {
      candleInterval: '1h',
      entrySizing: { mode: 'fixed', amount: '140' },
      trailingStopPct: '0.05',
    };
    expect(momentumPreviewLevels(input(raw)).sections).toEqual([]);
  });

  it('treats a malformed or non-finite entryMarginPct as zero margin', () => {
    const bad = momentumPreviewLevels(input({ ...cfg(), entryMarginPct: 'abc' }));
    expect(row(bad, 'entry')?.price).toBe('10');
    const inf = momentumPreviewLevels(input({ ...cfg(), entryMarginPct: 'Infinity' }));
    expect(row(inf, 'entry')?.price).toBe('10');
  });

  it('marks the entry row informational (no trigger) when a position is held', () => {
    const model = momentumPreviewLevels(input(cfg(), { state: held(), entryPrice: '100' }));
    const entry = row(model, 'entry');
    expect(entry?.trigger).toBeUndefined();
    expect(entry?.triggerWhen).toBeUndefined();
  });

  it('falls back to the projected band as the trail base when held with no high', () => {
    const model = momentumPreviewLevels(
      input(cfg({ entryMarginPct: '0' }), {
        state: held({ highSinceEntry: null }),
        entryPrice: null,
      }),
    );
    // refHigh falls back to the band (10) -> trail 10 * 0.95 = 9.5.
    expect(row(model, 'trail')?.price).toBe('9.5');
  });

  it('projects the profit leg once the persisted mark has armed it', () => {
    // The preview has no 1m window and must not re-ratchet: it reports the mark
    // the tick persisted. profitHigh 200 -> 200 * 0.97 = 194, above the hard
    // leg's 120 * 0.95 = 114, so both rows move to the number the worker acts on.
    const config = cfg({
      profitTrail: { enabled: true, activationPct: '0.05', trailPct: '0.03' },
    });
    const model = momentumPreviewLevels(
      input(config, { state: held({ profitHigh: '200' }), entryPrice: '100' }),
    );
    expect(row(model, 'trail')?.price).toBe('194');
    expect(row(model, 'protective-stop')?.price).toBe('194');
  });

  it('keeps the hard leg while the persisted mark is below activation', () => {
    const config = cfg({
      profitTrail: { enabled: true, activationPct: '0.05', trailPct: '0.03' },
    });
    const model = momentumPreviewLevels(
      input(config, { state: held({ profitHigh: '104' }), entryPrice: '100' }),
    );
    expect(row(model, 'trail')?.price).toBe('114');
  });

  it('ignores a stale mark while flat — the profit leg is position-only', () => {
    const config = cfg({
      entryMarginPct: '0',
      profitTrail: { enabled: true, activationPct: '0.05', trailPct: '0.03' },
    });
    // Flat: the trail projects off the entry band (10 -> 9.5). The state still
    // carries a mark of 200; honouring it would show 194.
    const model = momentumPreviewLevels(
      input(config, { state: held({ entryPrice: null, profitHigh: '200' }) }),
    );
    expect(row(model, 'trail')?.price).toBe('9.5');
  });

  it('omits the trail and protective-stop rows when trailingStopPct is out of range', () => {
    const model = momentumPreviewLevels(input({ ...cfg(), trailingStopPct: '1.5' }));
    expect(row(model, 'trail')).toBeUndefined();
    expect(row(model, 'protective-stop')).toBeUndefined();
  });

  it('omits the protective-stop row when the block is disabled', () => {
    const model = momentumPreviewLevels(input(cfg({ protectiveStop: { enabled: false } })));
    expect(row(model, 'protective-stop')).toBeUndefined();
  });

  it('omits the protective-stop row when the limit offset is out of range', () => {
    const model = momentumPreviewLevels(
      input({ ...cfg(), protectiveStop: { enabled: true, limitOffsetPercentage: '1.5' } }),
    );
    expect(row(model, 'protective-stop')).toBeUndefined();
  });

  it('uses the default limit offset when the protective-stop block omits it', () => {
    const model = momentumPreviewLevels(
      input({ ...cfg({ entryMarginPct: '0' }), protectiveStop: { enabled: true } }),
    );
    const ps = row(model, 'protective-stop');
    // stop 9.5, default offset 0.98 -> 9.31.
    expect(ps?.limitPrice).toBe('9.31');
  });

  it('omits the trend row when the filter is disabled or the window is too short', () => {
    expect(
      row(momentumPreviewLevels(input(cfg({ trendFilter: { enabled: false } }))), 'trend'),
    ).toBeUndefined();
    const shortWindow = momentumPreviewLevels(
      input(cfg({ trendFilter: { enabled: true, period: 50 } })),
    );
    expect(row(shortWindow, 'trend')).toBeUndefined();
  });

  it('surfaces the budget-level skip when entry sizing is unconfigured', () => {
    const raw = { candleInterval: '1h', ema: { fast: 2, slow: 3 }, trailingStopPct: '0.05' };
    expect(row(momentumPreviewLevels(input(raw)), 'entry')?.skip).toBe('sizing-unconfigured');
  });

  it('projects the ATR chandelier as the trail when the ATR mode is on', () => {
    // Varying closes give a non-zero ATR, so the ATR trail differs from the fixed
    // retrace — the preview shows the level the tick will actually use.
    const candles = mkCandles(['10', '12', '11', '14', '13', '15']);
    const fixedTrail = row(momentumPreviewLevels(input(cfg(), { candles })), 'trail')?.price;
    const atrTrail = row(
      momentumPreviewLevels(
        input(cfg({ atrTrailingStop: { enabled: true, period: 3, multiple: '2' } }), { candles }),
      ),
      'trail',
    )?.price;
    expect(fixedTrail).toBeDefined();
    expect(atrTrail).toBeDefined();
    expect(atrTrail).not.toBe(fixedTrail);
  });

  it('projects the overextension ceiling at baseline*(1+maxPercent) when the guard is on', () => {
    // sma(3) of the flat [10,10,10] window = 10; ceiling = 10 * 1.4 = 14.
    const model = momentumPreviewLevels(
      input(
        cfg({ entryExtension: { enabled: true, maType: 'sma', period: 3, maxPercent: '0.4' } }),
      ),
    );
    const ext = row(model, 'overextended');
    expect(ext).toBeDefined();
    expect(ext?.tone).toBe('neutral');
    expect(ext?.label).toBe('Max entry extension');
    expect(ext?.price).toBe('14');
  });

  it('omits the extension row only when the guard is off or the window is too short', () => {
    expect(
      row(
        momentumPreviewLevels(input(cfg({ entryExtension: { enabled: false } }))),
        'overextended',
      ),
    ).toBeUndefined();
    // Guard on but the period exceeds the window -> no baseline, no row.
    expect(
      row(
        momentumPreviewLevels(input(cfg({ entryExtension: { enabled: true, period: 50 } }))),
        'overextended',
      ),
    ).toBeUndefined();
  });

  it('projects the fallback ceiling when maxPercent is non-positive or malformed, matching the tick', () => {
    // The tick coerces a bad maxPercent to 0.4 and STILL enforces; the preview
    // must show the same ceiling (sma(3)=10 * 1.4 = 14), not hide it.
    for (const maxPercent of ['0', 'abc']) {
      const model = momentumPreviewLevels(
        input({
          candleInterval: '1h',
          entrySizing: { mode: 'fixed', amount: '140' },
          ema: { fast: 2, slow: 3 },
          entryExtension: { enabled: true, period: 3, maxPercent },
        }),
      );
      expect(row(model, 'overextended')?.price).toBe('14');
    }
  });

  it('omits the quantity when no filters are supplied', () => {
    const model = momentumPreviewLevels(input(cfg(), { filters: undefined }));
    const entry = row(model, 'entry');
    expect(entry?.quantity).toBeUndefined();
    expect(entry?.skip).toBeUndefined();
  });

  it('treats an absent quote asset as no free cash', () => {
    const model = momentumPreviewLevels(input(cfg(), { quoteAsset: undefined }));
    expect(row(model, 'entry')?.skip).toBe('min-qty');
  });

  it('returns an empty model when no candles are supplied at all', () => {
    expect(momentumPreviewLevels(input(cfg(), { candles: undefined })).sections).toEqual([]);
  });

  it('defaults the trend period to 200 when the field is absent', () => {
    // period 200 against a 4-candle window is unreachable -> no trend row, but the
    // default-period branch is exercised.
    const model = momentumPreviewLevels(
      input({ ...cfg(), trendFilter: { enabled: true, maType: 'sma' } }),
    );
    expect(row(model, 'trend')).toBeUndefined();
  });

  it('defaults to an empty account when none is supplied', () => {
    const model = momentumPreviewLevels(input(cfg(), { account: undefined }));
    // No free cash -> fixed budget clamps to 0 -> quantity rounds below minQty.
    expect(row(model, 'entry')?.skip).toBe('min-qty');
  });

  it('skips a wire balance whose free or locked will not parse', () => {
    const wire: AccountSnapshotWire = { balances: { USDT: { free: 'abc', locked: '0' } } };
    const model = momentumPreviewLevels(input(cfg(), { account: wire }));
    // The malformed USDT balance drops out -> no free cash -> min-qty skip.
    expect(row(model, 'entry')?.skip).toBe('min-qty');
  });

  it('revives deployedQuoteAcrossProfiles from the wire so the reserve cap applies', () => {
    const capped = cfg({
      entrySizing: { mode: 'percentOfAccount', percent: '0.5' },
      accountCap: { mode: 'percentOfAccount', percent: '0.1' },
    });
    const wire: AccountSnapshotWire = {
      balances: { USDT: { free: '100000', locked: '0' } },
      deployedQuoteAcrossProfiles: '100000',
    };
    // equity = 100000 cash + 100000 deployed; cap 0.1*200000 = 20000; headroom
    // 20000 - 100000 < 0 -> cap-reached, which only fires if the deployed total
    // survived the revive.
    const model = momentumPreviewLevels(previewInput(capped, wire));
    expect(row(model, 'entry')?.skip).toBe('cap-reached');
  });

  it('marks the entry, trail, and protective-stop rows as chart lines but not the trend', () => {
    const model = momentumPreviewLevels(previewInput(cfg(), RICH_ACCOUNT_WIRE));
    expect(row(model, 'entry')?.chartLine).toBe(true);
    expect(row(model, 'trail')?.chartLine).toBe(true);
    expect(row(model, 'protective-stop')?.chartLine).toBe(true);
    expect(row(model, 'trend')?.chartLine).toBeUndefined();
  });
});

describe('momentumPreviewLevels — exchange-native trailing protective stop', () => {
  // askMultiplierDown 0.98 puts the floor at 9.8 against a reference of 10, and
  // the projected level is 10.2 * 0.95 = 9.69 with a 9.4962 limit: both legs sit
  // under the floor, so the priced stop is exactly the one Binance refuses.
  const BANDED_FILTERS: SymbolInfo['filters'] = {
    ...FILTERS,
    percentPriceBySide: {
      askMultiplierUp: '2',
      askMultiplierDown: '0.98',
      bidMultiplierUp: '1.1',
      bidMultiplierDown: '0.5',
      avgPriceMins: 5,
    },
    trailingDelta: {
      minTrailingAboveDelta: 10,
      maxTrailingAboveDelta: 2000,
      minTrailingBelowDelta: 10,
      maxTrailingBelowDelta: 2000,
    },
  };

  const model = (onBandBlock: string | undefined, filters = BANDED_FILTERS): PreviewModel =>
    momentumPreviewLevels({
      ...previewInput(
        cfg({
          protectiveStop: {
            enabled: true,
            limitOffsetPercentage: '0.98',
            ...(onBandBlock === undefined ? {} : { onBandBlock }),
          },
        }),
        RICH_ACCOUNT_WIRE,
      ),
      filters,
    });

  it('projects the trailing stop with NO fixed trigger and no limit price', () => {
    const ps = row(model('native-trail'), 'protective-stop');
    // A trailing stop has no level to name: Binance derives the trigger from a
    // high-water mark that only starts at placement. Any price here would be a
    // number the operator watches and nothing ever acts on.
    expect(ps?.price).toBeUndefined();
    expect(ps?.limitPrice).toBeUndefined();
    expect(ps?.triggerWhen).toBeUndefined();
    expect(ps?.chartLine).toBeUndefined();
    expect(ps?.label).toBe('Protective stop (exchange trail)');
    // The CONFIGURED `trailingStopPct: 0.05`, read back out of the delta the
    // order will carry — not a distance re-measured against the live price,
    // which would print a percentage the resting order does not hold.
    expect(ps?.note).toContain('5%');
  });

  it('carries no field the preview-drift gate can key on', () => {
    // The gate matches a row on `code` + `trigger === true` + `price` +
    // `triggerWhen`, and this row's exemption is the ABSENCE of all three. An
    // absence nothing asserts is one a later edit fills in silently, and the day
    // it does, the golden replay starts comparing a static number against a
    // high-water mark Binance moves on its own. Pinned as the whole key set so a
    // NEW price-bearing field fails here too, not just the three named ones.
    const ps = row(model('native-trail'), 'protective-stop');
    expect(ps).toBeDefined();
    expect(Object.keys(ps ?? {}).sort()).toEqual(['code', 'label', 'note', 'tone']);
  });

  it('keeps the ordinary priced row whenever the priced stop is what will rest', () => {
    // Inside the band, no band published, and the default mode all end at the
    // same place: the row names the trigger the tick acts on.
    const priced = (m: PreviewModel) => {
      const ps = row(m, 'protective-stop');
      expect(ps?.label).toBe('Protective stop');
      expect(ps?.price).toBe('9.69');
      expect(ps?.note).toBeUndefined();
    };
    priced(model('native-trail', FILTERS));
    priced(model('notify'));
    priced(model(undefined));
  });

  it('keeps the priced row when the symbol will not accept the distance', () => {
    // No usable delta means no trail can be placed, so promising one in the
    // preview would describe an order the arm is about to refuse instead.
    const { trailingDelta: _dropped, ...noBounds } = BANDED_FILTERS;
    const ps = row(model('native-trail', noBounds), 'protective-stop');
    expect(ps?.price).toBe('9.69');
    expect(ps?.note).toBeUndefined();
  });

  it('keeps the priced row when there is no configured distance to trail by', () => {
    // An unparseable `trailingStopPct` leaves the profit trail holding the stop
    // on its own, so a level still rests — but there is no distance to hand
    // Binance, so no trail can go out. Dropping the row entirely would hide a
    // resting protective stop from the one screen that shows it; the priced
    // level is what the arm sends, and it is what belongs here.
    const model = momentumPreviewLevels({
      config: {
        ...cfg({
          profitTrail: { enabled: true, activationPct: '0.05', trailPct: '0.03' },
          protectiveStop: { enabled: true, limitOffsetPercentage: '0.98' },
        }),
        trailingStopPct: 'nope',
        protectiveStop: {
          enabled: true,
          limitOffsetPercentage: '0.98',
          onBandBlock: 'native-trail',
        },
      },
      state: held({ profitHigh: '200' }),
      entryPrice: '100',
      currentPrice: '10',
      filters: BANDED_FILTERS,
      candles: mkCandles(FLAT_CLOSES),
      account: RICH_ACCOUNT_WIRE,
      quoteAsset: 'USDT',
    } as never);
    const ps = row(model, 'protective-stop');
    // 200 * 0.97, the profit leg — the hard leg contributed nothing.
    expect(ps?.price).toBe('194');
    expect(ps?.note).toBeUndefined();
  });
});

describe('momentumPreviewLevels — protectiveStop.mode: native-trail', () => {
  // No `percentPriceBySide` on purpose: a profile in primary native mode rests a
  // trail on every tick, not only on a band refusal, so the row must not depend
  // on a band being published at all.
  const TRAIL_FILTERS: SymbolInfo['filters'] = {
    ...FILTERS,
    trailingDelta: {
      minTrailingAboveDelta: 10,
      maxTrailingAboveDelta: 2000,
      minTrailingBelowDelta: 10,
      maxTrailingBelowDelta: 2000,
    },
  };

  const model = (protectiveStop: Record<string, unknown>, filters = TRAIL_FILTERS): PreviewModel =>
    momentumPreviewLevels({
      ...previewInput(cfg({ protectiveStop }), RICH_ACCOUNT_WIRE),
      filters,
    });

  it('names the distance instead of a level under the default onBandBlock', () => {
    // The order that rests is a STOP_LOSS carrying a quantity and a trailing
    // delta: Binance owns the trigger and derives it from a high-water mark that
    // starts at placement. A price, a limit price, or a chart line here would put
    // numbers on the symbol screen that the resting order does not carry.
    const ps = row(
      model({ enabled: true, mode: 'native-trail', limitOffsetPercentage: '0.98' }),
      'protective-stop',
    );
    expect(ps).toBeDefined();
    expect(ps?.label).toBe('Protective stop (exchange trail)');
    // Pinned as the whole key set, not as three named absences, so a NEW
    // price-bearing field fails here rather than reaching the chart silently.
    expect(Object.keys(ps ?? {}).sort()).toEqual(['code', 'label', 'note', 'tone']);
    // The configured `trailingStopPct: 0.05`, read back out of the delta the
    // order will carry.
    expect(ps?.note).toContain('5%');
  });

  it('keeps the priced row when the profile asks for a trail with no distance to trail by', () => {
    // Selecting the mode is not enough on its own. An unparseable `trailingStopPct` leaves nothing to size a delta from, so the arm rests the priced stop instead, and the row has to follow the order rather than the setting. Naming a trail here would describe an order that never goes out.
    const model = momentumPreviewLevels({
      config: {
        ...cfg({
          profitTrail: { enabled: true, activationPct: '0.05', trailPct: '0.03' },
          protectiveStop: { enabled: true, mode: 'native-trail', limitOffsetPercentage: '0.98' },
        }),
        trailingStopPct: 'nope',
        protectiveStop: {
          enabled: true,
          mode: 'native-trail',
          limitOffsetPercentage: '0.98',
        },
      },
      state: held({ profitHigh: '200' }),
      entryPrice: '100',
      currentPrice: '10',
      filters: TRAIL_FILTERS,
      candles: mkCandles(FLAT_CLOSES),
      account: RICH_ACCOUNT_WIRE,
      quoteAsset: 'USDT',
    } as never);
    const ps = row(model, 'protective-stop');
    expect(ps?.label).toBe('Protective stop');
    expect(ps?.note).toBeUndefined();
    // 200 * 0.97, the profit leg: a real resting level, so the row is the priced one rather than absent.
    expect(ps?.price).toBe('194');
  });

  it('keeps the priced row for an explicitly priced stop and for an absent mode', () => {
    const priced = (m: PreviewModel) => {
      const ps = row(m, 'protective-stop');
      expect(ps?.label).toBe('Protective stop');
      expect(ps?.price).toBe('9.69');
      expect(ps?.limitPrice).toBe(new Decimal('9.69').mul('0.98').toString());
      expect(ps?.note).toBeUndefined();
    };
    priced(model({ enabled: true, mode: 'priced', limitOffsetPercentage: '0.98' }));
    priced(model({ enabled: true, limitOffsetPercentage: '0.98' }));
  });

  it('keeps the priced row when the symbol will not accept the distance', () => {
    // Selecting the mode is not enough: with no usable TRAILING_DELTA bounds the
    // arm can build no native order and prices the stop instead, so promising a
    // trail here would describe an order that never goes out.
    const ps = row(
      model({ enabled: true, mode: 'native-trail', limitOffsetPercentage: '0.98' }, FILTERS),
      'protective-stop',
    );
    expect(ps?.label).toBe('Protective stop');
    expect(ps?.price).toBe('9.69');
    expect(ps?.note).toBeUndefined();
  });
});
