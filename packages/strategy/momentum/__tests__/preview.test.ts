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
import { computeEntryQuantity } from '../src/quantity.js';

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

const rows = (model: PreviewModel): PreviewRow[] => model.sections.flatMap((s) => s.rows);
const row = (model: PreviewModel, code: string): PreviewRow | undefined =>
  rows(model).find((r) => r.code === code);

const previewInput = (config: MomentumConfig, account: AccountSnapshotWire) => ({
  config,
  state: null,
  entryPrice: null,
  currentPrice: '10',
  filters: FILTERS,
  candles: mkCandles(FLAT_CLOSES),
  account,
  quoteAsset: 'USDT',
});

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

    const budget = resolveEntryBudget(config, RICH_ACCOUNT, 'USDT');
    if (!('budget' in budget)) throw new Error('expected a fundable budget');
    const expected = computeEntryQuantity(budget.budget, entry.price, FILTERS);
    if (!('quantity' in expected)) throw new Error('expected a sizable quantity');

    expect(entry.quantity).toBe(expected.quantity);
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

    const budget = resolveEntryBudget(poor, RICH_ACCOUNT, 'USDT');
    if (!('budget' in budget)) throw new Error('expected a resolved budget');
    const sized = computeEntryQuantity(budget.budget, entry.price, FILTERS);
    if (!('skip' in sized)) throw new Error('expected a typed sizing skip');

    expect(entry.skip).toBe(sized.skip);
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
