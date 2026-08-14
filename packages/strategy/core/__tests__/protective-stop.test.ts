import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';

import type {
  AccountSnapshot,
  Balance,
  Decision,
  DesiredProtectiveStop,
  OpenOrder,
  ProtectiveStopArmParams,
  ProtectiveStopLevel,
  SizeFilters,
  SymbolFilters,
  TrailingDeltaFilter,
} from '../src/index.js';
import {
  armableBaseQuantity,
  classifyProtectiveStopRefusal,
  clampStopToExchangeFloor,
  clampedStopDrift,
  evaluateProtectiveStopArm,
  findForeignRestingSell,
  findRestingProtectiveStop,
  nativeTrailPreviewNote,
  nativeTrailingDelta,
  ownRestingSellBase,
  percentPriceBySideRefusal,
  protectiveStopNeedsRearm,
  stillGuarding,
} from '../src/protective-stop.js';

const OURS = 'tt-p1-btcusdt-ps';

const order = (over: Partial<OpenOrder> = {}): OpenOrder => ({
  orderId: 1,
  clientOrderId: OURS,
  symbol: 'BTCUSDT',
  side: 'SELL',
  type: 'STOP_LOSS_LIMIT',
  status: 'NEW',
  price: '95.00',
  origQty: '2',
  executedQty: '0',
  cummulativeQuoteQty: '0',
  stopPrice: '96.00',
  timeInForce: 'GTC',
  transactTimeMs: 0,
  updateTimeMs: 0,
  ...over,
});

describe('ownRestingSellBase', () => {
  it('sums the unfilled remainder of our own resting SELLs', () => {
    expect(ownRestingSellBase([order()], OURS, 'BTCUSDT').toFixed()).toBe('2');
    expect(
      ownRestingSellBase(
        [order({ status: 'PARTIALLY_FILLED', origQty: '2', executedQty: '0.5' })],
        OURS,
        'BTCUSDT',
      ).toFixed(),
    ).toBe('1.5');
  });

  it('ignores a foreign id, a BUY, and a terminal status', () => {
    expect(
      ownRestingSellBase([order({ clientOrderId: 'foreign' })], OURS, 'BTCUSDT').toFixed(),
    ).toBe('0');
    expect(ownRestingSellBase([order({ side: 'BUY' })], OURS, 'BTCUSDT').toFixed()).toBe('0');
    expect(ownRestingSellBase([order({ status: 'FILLED' })], OURS, 'BTCUSDT').toFixed()).toBe('0');
    expect(ownRestingSellBase([], OURS, 'BTCUSDT').toFixed()).toBe('0');
  });

  it('treats an unparseable origQty as nothing locked and a bad executedQty as nothing filled', () => {
    expect(ownRestingSellBase([order({ origQty: 'x' })], OURS, 'BTCUSDT').toFixed()).toBe('0');
    expect(ownRestingSellBase([order({ origQty: '0' })], OURS, 'BTCUSDT').toFixed()).toBe('0');
    expect(
      ownRestingSellBase([order({ origQty: '2', executedQty: 'x' })], OURS, 'BTCUSDT').toFixed(),
    ).toBe('2');
  });
});

describe('findForeignRestingSell', () => {
  it('matches only a live SELL that is not ours', () => {
    expect(
      findForeignRestingSell([order({ clientOrderId: 'ghost' })], OURS, 'BTCUSDT')?.orderId,
    ).toBe(1);
    expect(findForeignRestingSell([order()], OURS, 'BTCUSDT')).toBeUndefined();
    expect(
      findForeignRestingSell([order({ clientOrderId: 'ghost', side: 'BUY' })], OURS, 'BTCUSDT'),
    ).toBe(undefined);
    expect(
      findForeignRestingSell(
        [order({ clientOrderId: 'ghost', status: 'FILLED' })],
        OURS,
        'BTCUSDT',
      ),
    ).toBeUndefined();
  });
});

describe('symbol scoping', () => {
  it('ignores orders on another pair (a SELL there locks a different base asset)', () => {
    const other = order({ symbol: 'ETHUSDT', clientOrderId: 'ghost' });
    expect(findForeignRestingSell([other], OURS, 'BTCUSDT')).toBeUndefined();
    expect(ownRestingSellBase([order({ symbol: 'ETHUSDT' })], OURS, 'BTCUSDT').toFixed()).toBe('0');
  });
});

describe('classifyProtectiveStopRefusal', () => {
  const params = {
    symbol: 'BTCUSDT',
    ourClientOrderId: OURS,
    required: '2',
    free: new Decimal('0'),
    available: new Decimal('0'),
  };

  it('names the foreign order holding the base', () => {
    expect(
      classifyProtectiveStopRefusal({
        ...params,
        openOrders: [order({ orderId: 9, clientOrderId: 'ghost' })],
      }),
    ).toEqual({
      reason: 'base-locked-by-foreign-order',
      detail: {
        symbol: 'BTCUSDT',
        required: '2',
        free: '0',
        available: '0',
        foreignClientOrderId: 'ghost',
        foreignOrderId: 9,
      },
    });
  });

  it('falls back to the wallet reasons when there is no foreign order to blame', () => {
    // Nothing free at all vs. a free remainder too small for the exchange minimum:
    // two different operator actions, so two different reasons.
    expect(classifyProtectiveStopRefusal({ ...params, openOrders: [] }).reason).toBe(
      'base-short-of-tracked-position',
    );
    expect(
      classifyProtectiveStopRefusal({
        ...params,
        openOrders: [],
        free: new Decimal('0.001'),
        available: new Decimal('0.001'),
      }).reason,
    ).toBe('base-below-exchange-minimum');
  });
});

describe('armableBaseQuantity', () => {
  it('caps the tracked position at free + the base our own stop locks', () => {
    // free 0 with our own stop locking the whole position: still fully armable —
    // the arm cancels its own order in the same batch.
    expect(
      armableBaseQuantity(new Decimal('2'), new Decimal('0'), new Decimal('2')).toFixed(),
    ).toBe('2');
    // A foreign order holds 0.5: only the free remainder is armable.
    expect(
      armableBaseQuantity(new Decimal('2'), new Decimal('1.5'), new Decimal('0')).toFixed(),
    ).toBe('1.5');
    // Never above the tracked position, however much base the wallet holds.
    expect(
      armableBaseQuantity(new Decimal('2'), new Decimal('9'), new Decimal('0')).toFixed(),
    ).toBe('2');
  });

  it('fails OPEN on an unreadable wallet (undefined free ⇒ the tracked position)', () => {
    expect(armableBaseQuantity(new Decimal('2'), undefined, new Decimal('0')).toFixed()).toBe('2');
  });
});

describe('protectiveStopNeedsRearm', () => {
  it('re-arms on a material trigger move and holds inside the band', () => {
    expect(protectiveStopNeedsRearm(order({ stopPrice: '96.00' }), '105.60', '2')).toBe(true);
    expect(protectiveStopNeedsRearm(order({ stopPrice: '96.00' }), '96.01', '2')).toBe(false);
  });

  it('re-arms on a material QUANTITY move — a partially-sized stop is never resized otherwise', () => {
    expect(protectiveStopNeedsRearm(order({ origQty: '0.5' }), '96.00', '2')).toBe(true);
    // Inside the 1% band: a rounding wobble must not churn the resting order.
    expect(protectiveStopNeedsRearm(order({ origQty: '2.001' }), '96.00', '2')).toBe(false);
  });

  it('measures the resting quantity net of what already filled', () => {
    // origQty 2, executedQty 1.5 ⇒ only 0.5 still protects the position.
    expect(
      protectiveStopNeedsRearm(
        order({ status: 'PARTIALLY_FILLED', origQty: '2', executedQty: '1.5' }),
        '96.00',
        '2',
      ),
    ).toBe(true);
  });

  it('treats an unparseable executedQty as nothing filled (the full origQty still protects)', () => {
    expect(protectiveStopNeedsRearm(order({ origQty: '2', executedQty: 'x' }), '96.00', '2')).toBe(
      false,
    );
  });

  it('honours a caller-supplied drift band in both directions', () => {
    // 96.00 vs 96.50 is 0.52%: past the 0.1% default, inside a 1% band. The band
    // is the only knob bounding order spend for a level that advances intraday,
    // so a plugin must be able to widen or tighten it.
    expect(protectiveStopNeedsRearm(order({ stopPrice: '96.00' }), '96.50', '2')).toBe(true);
    expect(
      protectiveStopNeedsRearm(order({ stopPrice: '96.00' }), '96.50', '2', new Decimal('0.01')),
    ).toBe(false);
    expect(
      protectiveStopNeedsRearm(order({ stopPrice: '96.00' }), '96.05', '2', new Decimal('0.0001')),
    ).toBe(true);
  });

  it('leaves an order whose stopPrice or origQty reads back unparseable (no churn)', () => {
    expect(protectiveStopNeedsRearm(order({ stopPrice: undefined }), '96.00', '2')).toBe(false);
    expect(protectiveStopNeedsRearm(order({ stopPrice: 'x' }), '96.00', '2')).toBe(false);
    expect(protectiveStopNeedsRearm(order({ origQty: 'x' }), '96.00', '2')).toBe(false);
  });

  it('re-arms a resting TRAIL unconditionally once a priced stop is wanted', () => {
    // The wrong ORDER TYPE, not a stale price — and it reports no stopPrice, so
    // the drift test above reads it as unparseable and would leave it resting for
    // the life of the position with nothing raising a blocker.
    const trail = order({ stopPrice: undefined, trailingDelta: 400 });
    expect(protectiveStopNeedsRearm(trail, '96.00', '2')).toBe(true);
  });
});

describe('clampedStopDrift', () => {
  it('is a whole percent when the plugin sets no band of its own', () => {
    // The shared 0.1% default rewrites a floor-clamped stop on almost every tick:
    // the level is a fraction of the current price, so it moves with the market.
    expect(clampedStopDrift(null).toString()).toBe('0.01');
  });

  it('never narrows a band the plugin deliberately widened', () => {
    // A plugin widens its band to bound its own order rate. A clamp is a reason
    // to send fewer orders, never more.
    expect(clampedStopDrift(new Decimal('0.05')).toString()).toBe('0.05');
    expect(clampedStopDrift(new Decimal('0.002')).toString()).toBe('0.01');
  });
});

describe('findRestingProtectiveStop', () => {
  it('matches our resting SELL by clientOrderId + the isRestingSell denylist', () => {
    expect(findRestingProtectiveStop([order()], OURS)?.orderId).toBe(1);
    // PARTIALLY_FILLED and PENDING_CANCEL still lock base — the denylist keeps
    // them, so a re-arm is not suppressed by a half-filled or in-flight cancel.
    expect(findRestingProtectiveStop([order({ status: 'PARTIALLY_FILLED' })], OURS)?.orderId).toBe(
      1,
    );
    expect(findRestingProtectiveStop([order({ status: 'PENDING_CANCEL' })], OURS)?.orderId).toBe(1);
  });

  it('ignores a foreign id, a BUY, a terminal status, and an empty book', () => {
    expect(findRestingProtectiveStop([order({ clientOrderId: 'other' })], OURS)).toBeUndefined();
    expect(findRestingProtectiveStop([order({ side: 'BUY' })], OURS)).toBeUndefined();
    expect(findRestingProtectiveStop([order({ status: 'FILLED' })], OURS)).toBeUndefined();
    expect(findRestingProtectiveStop([], OURS)).toBeUndefined();
  });
});

describe('evaluateProtectiveStopArm — shared orchestration', () => {
  const FILTERS: SizeFilters = {
    step: new Decimal('0.001'),
    minQty: new Decimal('0.001'),
    minNotional: new Decimal('10'),
  };

  const stopLevel = (over: Partial<ProtectiveStopLevel> = {}): ProtectiveStopLevel => ({
    stop: new Decimal('95'),
    limit: new Decimal('94'),
    held: new Decimal('1'),
    filters: FILTERS,
    tick: new Decimal('0.01'),
    ...over,
  });

  const bal = (asset: string, free: string, locked = '0'): Balance => ({
    asset,
    free: new Decimal(free),
    locked: new Decimal(locked),
  });

  const account = (balances: Record<string, Balance>, readable = true): AccountSnapshot => ({
    balances,
    readable,
  });

  type Params = ProtectiveStopArmParams<unknown, unknown, Record<string, never>>;

  // No `percentPriceBySide`: the arm must behave exactly as it did before the
  // band existed on every symbol Binance publishes no band for.
  const BTC_FILTERS: SymbolFilters = {
    minNotional: '10',
    tickSize: '0.01',
    stepSize: '0.001',
    minQty: '0.001',
    maxQty: '9000',
    minPrice: '0.01',
    maxPrice: '1000000',
  };

  const armInput = (openOrders: OpenOrder[], acct: AccountSnapshot): Params['input'] =>
    ({
      openOrders,
      account: acct,
      market: {
        symbol: 'BTCUSDT',
        currentPrice: '100.00',
        symbolInfo: { baseAsset: 'BTC', filters: BTC_FILTERS },
      },
    }) as unknown as Params['input'];

  const buildPlace = (desired: DesiredProtectiveStop): Decision => ({
    type: 'place-order',
    intent: { symbol: 'BTCUSDT', side: 'SELL', reason: 'protective-stop', clientOrderId: OURS },
    params: {
      type: 'STOP_LOSS_LIMIT',
      stopPrice: desired.stopPrice,
      price: desired.price,
      quantity: desired.quantity,
      timeInForce: 'GTC',
    },
  });

  const buildCancel = (resting: OpenOrder): Decision => ({
    type: 'cancel-order',
    orderId: resting.orderId,
    symbol: 'BTCUSDT',
    reason: 'superseded',
  });

  const placed = (over: Partial<DesiredProtectiveStop> = {}): Decision =>
    buildPlace({ stopPrice: '95.00', price: '94.00', quantity: '1.000', ...over });

  const run = (over: Partial<Params>): ReturnType<typeof evaluateProtectiveStopArm> =>
    evaluateProtectiveStopArm({
      input: armInput([], account({ BTC: bal('BTC', '5') })),
      enabled: true,
      level: stopLevel(),
      reclaimableBase: new Decimal('0'),
      ourClientOrderId: OURS,
      buildPlace,
      buildCancel,
      ...over,
    } as Params);

  it('disabled ⇒ no decisions and NO cancel, even with a stop resting (by design)', () => {
    const out = run({
      enabled: false,
      input: armInput([order()], account({ BTC: bal('BTC', '5') })),
    });
    expect(out).toEqual({ decisions: [], blocker: null });
  });

  it('no level with a stop resting ⇒ cancels the now-mismatched stop', () => {
    const out = run({ level: null, input: armInput([order()], account({ BTC: bal('BTC', '5') })) });
    expect(out).toEqual({ decisions: [buildCancel(order())], blocker: null });
  });

  it('no level and nothing resting ⇒ no decisions', () => {
    const out = run({ level: null });
    expect(out).toEqual({ decisions: [], blocker: null });
  });

  it('full size below the exchange minimum and nothing resting ⇒ no decisions', () => {
    const out = run({ level: stopLevel({ held: new Decimal('0.0001') }) });
    expect(out).toEqual({ decisions: [], blocker: null });
  });

  it('full size below the exchange minimum with a stop resting ⇒ cancels it', () => {
    const out = run({
      level: stopLevel({ held: new Decimal('0.0001') }),
      input: armInput([order()], account({ BTC: bal('BTC', '5') })),
    });
    expect(out).toEqual({ decisions: [buildCancel(order())], blocker: null });
  });

  it('places a full-quantity stop when the wallet funds it and none is resting', () => {
    const out = run({});
    expect(out.blocker).toBeNull();
    expect(out.decisions).toEqual([placed()]);
  });

  it('leaves a within-band resting stop untouched (no churn)', () => {
    const resting = order({ stopPrice: '95.00', origQty: '1' });
    const out = run({ input: armInput([resting], account({ BTC: bal('BTC', '5') })) });
    expect(out).toEqual({ decisions: [], blocker: null });
  });

  it('cancels and re-places when the resting trigger has drifted past the band', () => {
    const resting = order({ stopPrice: '80.00', origQty: '1' });
    const out = run({ input: armInput([resting], account({ BTC: bal('BTC', '5') })) });
    expect(out.blocker).toBeNull();
    expect(out.decisions).toEqual([buildCancel(resting), placed()]);
  });

  it('FAILS OPEN on an unreadable wallet: arms the full tracked held', () => {
    const out = run({
      input: armInput([order({ clientOrderId: 'ghost' })], { balances: {}, readable: false }),
    });
    expect(out.blocker).toBeNull();
    expect(out.decisions).toEqual([placed()]);
  });

  it('refuses and names the foreign order when nothing is armable', () => {
    const foreign = order({ orderId: 999, clientOrderId: 'ghost' });
    const out = run({ input: armInput([foreign], account({ BTC: bal('BTC', '0', '0') })) });
    expect(out.decisions).toEqual([]);
    expect(out.blocker).toMatchObject({
      reason: 'base-locked-by-foreign-order',
      detail: { foreignOrderId: 999, required: '1.000', free: '0' },
    });
  });

  it('arms on the FREE remainder when a foreign order locks part of the base', () => {
    const foreign = order({ orderId: 999, clientOrderId: 'ghost', origQty: '0.0085' });
    const out = run({
      level: stopLevel({ held: new Decimal('0.3526') }),
      input: armInput([foreign], account({ BTC: bal('BTC', '0.3441', '0.0085') })),
    });
    expect(out.blocker).toBeNull();
    expect(out.decisions).toEqual([placed({ quantity: '0.344' })]);
  });
});

describe('evaluateProtectiveStopArm — PERCENT_PRICE_BY_SIDE band', () => {
  // Live LINKUSDT reproduction. Binance accepts a SELL only inside
  // `ref * askMultiplierDown <= price <= ref * askMultiplierUp`. The arm emitted
  // [cancel, place]; the cancel landed, the place was refused -1013, and the pair
  // was re-derived every tick for 2h18m with the position unguarded. The cancel is
  // the damaging half: it strips real protection to make room for an order the
  // exchange will never accept.
  const LINK_OURS = 'mom-p1-linkusdt-ps';

  const FILTERS: SizeFilters = {
    step: new Decimal('0.01'),
    minQty: new Decimal('0.01'),
    minNotional: new Decimal('5'),
  };

  // The live LINKUSDT filter row. `withBand: false` is the symbol Binance
  // publishes no band for, which must stay indistinguishable from today.
  const symbolFilters = (withBand: boolean): SymbolFilters => ({
    minNotional: '5',
    tickSize: '0.001',
    stepSize: '0.01',
    minQty: '0.01',
    maxQty: '92141578',
    minPrice: '0.001',
    maxPrice: '10000',
    ...(withBand
      ? {
          percentPriceBySide: {
            askMultiplierUp: '2',
            askMultiplierDown: '0.9',
            bidMultiplierUp: '1.1',
            bidMultiplierDown: '0.5',
            avgPriceMins: 5,
          },
        }
      : {}),
  });

  // highSinceEntry 8.779 * (1 - trailingStopPct 0.15) floored to tickSize 0.001,
  // then limitOffsetPercentage 0.98 applied and floored again: the exact pair the
  // live order carried.
  const stopLevel = (over: Partial<ProtectiveStopLevel> = {}): ProtectiveStopLevel => ({
    stop: new Decimal('7.462'),
    limit: new Decimal('7.312'),
    held: new Decimal('3.13'),
    filters: FILTERS,
    tick: new Decimal('0.001'),
    ...over,
  });

  type Params = ProtectiveStopArmParams<unknown, unknown, Record<string, never>>;

  // The whole position sits in `locked` behind our own resting stop, which is what
  // the wallet reads while a stop rests; `reclaimableBase` credits it back.
  const linkAccount = (): AccountSnapshot => ({
    balances: {
      LINK: { asset: 'LINK', free: new Decimal('0'), locked: new Decimal('3.13') } as Balance,
    },
    readable: true,
  });

  const armInput = (
    currentPrice: string,
    withBand: boolean,
    openOrders: OpenOrder[],
  ): Params['input'] =>
    ({
      openOrders,
      account: linkAccount(),
      market: {
        symbol: 'LINKUSDT',
        currentPrice,
        symbolInfo: { baseAsset: 'LINK', quoteAsset: 'USDT', filters: symbolFilters(withBand) },
      },
    }) as unknown as Params['input'];

  const buildPlace = (desired: DesiredProtectiveStop): Decision => ({
    type: 'place-order',
    intent: {
      symbol: 'LINKUSDT',
      side: 'SELL',
      reason: 'protective-stop',
      clientOrderId: LINK_OURS,
    },
    params: {
      type: 'STOP_LOSS_LIMIT',
      stopPrice: desired.stopPrice,
      price: desired.price,
      quantity: desired.quantity,
      timeInForce: 'GTC',
    },
  });

  const buildCancel = (resting: OpenOrder): Decision => ({
    type: 'cancel-order',
    orderId: resting.orderId,
    symbol: 'LINKUSDT',
    reason: 'superseded',
  });

  // The previous trail level, far enough below the recomputed 7.462 to clear the
  // drift band, so today's arm reaches the [cancel, place] re-arm return.
  const resting = (): OpenOrder =>
    order({
      orderId: 4242,
      clientOrderId: LINK_OURS,
      symbol: 'LINKUSDT',
      price: '7.154',
      stopPrice: '7.300',
      origQty: '3.13',
      executedQty: '0',
    });

  const placed = (over: Partial<DesiredProtectiveStop> = {}): Decision =>
    buildPlace({ stopPrice: '7.462', price: '7.312', quantity: '3.13', ...over });

  const run = (over: Partial<Params>): ReturnType<typeof evaluateProtectiveStopArm> =>
    evaluateProtectiveStopArm({
      input: armInput('8.8320', true, [resting()]),
      enabled: true,
      level: stopLevel(),
      reclaimableBase: new Decimal('3.13'),
      ourClientOrderId: LINK_OURS,
      buildPlace,
      buildCancel,
      ...over,
    } as Params);

  it('refuses BOTH halves of the re-arm when the desired price is below the ask floor', () => {
    // reference 8.8320 * askMultiplierDown 0.9 = 7.9488. Both 7.462 and 7.312 sit
    // under it, so the replacement can only ever come back -1013.
    const out = run({});
    expect(out.decisions.filter((d) => d.type === 'place-order')).toEqual([]);
    // The live stop must survive: cancelling it buys nothing when no replacement
    // can be accepted.
    expect(out.decisions.filter((d) => d.type === 'cancel-order')).toEqual([]);
    expect(out.blocker?.reason).toBe('price-outside-exchange-band');
  });

  it('refuses BOTH halves of the re-arm when only the TRIGGER breaches the ask ceiling', () => {
    // reference 3.7 * askMultiplierUp 2 = 7.4. The trigger 7.462 is over it while
    // the limit 7.312 is inside, and the trigger is always the higher leg, so this
    // is the ONLY way a protective stop breaches the ceiling. Binance bands the
    // trigger too, so the replacement can only come back -1013.
    const out = run({ input: armInput('3.7', true, [resting()]) });
    expect(out.blocker?.reason).toBe('price-outside-exchange-band');
    // The absent cancel is the point: emitting it strips the live stop to make
    // room for an order the exchange will never accept, leaving the position naked.
    expect(out.decisions).toEqual([]);
  });

  it('re-arms again once the reference falls back inside the band (no operator action)', () => {
    // 7.312 / 0.9 = 8.1244 is the highest reference that still admits this stop.
    const out = run({ input: armInput('8.10', true, [resting()]) });
    expect(out.blocker).toBeNull();
    expect(out.decisions).toEqual([buildCancel(resting()), placed()]);
  });

  it('places unchanged when the symbol carries no percentPriceBySide filter', () => {
    // Absent filter means unknown band, not a zero-width one. Refusing to protect
    // a position needs proof, so the arm must behave exactly as it does today.
    const out = run({ input: armInput('8.8320', false, [resting()]) });
    expect(out.blocker).toBeNull();
    expect(out.decisions).toEqual([buildCancel(resting()), placed()]);
  });

  it('marks the blocker terminal when the limit offset can never clear the ask floor', () => {
    // limitOffsetPercentage 0.9 against askMultiplierDown 0.9: the limit is
    // stop * 0.9 and the floor is ref * 0.9, and a protective stop's trigger is
    // always at or below the reference, so no price movement can arm it. The
    // operator must widen the offset; waiting will not help, and the gloss has to
    // say so.
    const out = run({ level: stopLevel({ limit: new Decimal('6.715') }) });
    expect(out.blocker?.reason).toBe('price-outside-exchange-band');
    expect(out.blocker?.detail).toMatchObject({ terminal: true });
  });

  it('stays silent when the resting stop is already at the desired level', () => {
    // Nothing would be sent, so no band applies. A blocker here reads to every
    // consumer as "this position has no stop" and paints the symbol red, which is
    // the opposite of true: the stop is resting exactly where it should be.
    const settled = order({
      orderId: 4242,
      clientOrderId: LINK_OURS,
      symbol: 'LINKUSDT',
      price: '7.312',
      stopPrice: '7.462',
      origQty: '3.13',
      executedQty: '0',
    });
    const out = run({ input: armInput('8.8320', true, [settled]) });
    expect(out.decisions).toEqual([]);
    expect(out.blocker).toBeNull();
  });

  it('tells the operator whether a stop still covers the position behind the refusal', () => {
    // Same refusal, two very different amounts of danger: an unguarded position
    // versus one guarded at last tick's level. The detail carries the difference
    // so the UI can stop crying wolf on the second.
    expect(run({}).blocker?.detail).toMatchObject({ guarded: true });
    // Nothing resting and the base sitting free in the wallet: fully armable, and
    // refused only by the band — the genuinely unguarded case.
    const naked = run({
      input: {
        ...armInput('8.8320', true, []),
        account: {
          balances: {
            LINK: { asset: 'LINK', free: new Decimal('3.13'), locked: new Decimal('0') } as Balance,
          },
          readable: true,
        },
      } as Params['input'],
      reclaimableBase: new Decimal('0'),
    });
    expect(naked.blocker?.detail).toMatchObject({ guarded: false });
    expect(naked.decisions).toEqual([]);
  });

  it('does not call a position guarded by a stop that is leaving the book', () => {
    // PENDING_CANCEL is a cancel already in flight. `isRestingSell` reports it as
    // resting because it still locks the base, which is the right answer to that
    // question and the wrong one here: the order is about to stop protecting
    // anything, so the operator must still see red.
    const out = run({
      input: armInput('8.8320', true, [{ ...resting(), status: 'PENDING_CANCEL' }]),
    });
    expect(out.blocker?.detail).toMatchObject({ guarded: false });
    // Still no cancel: leaving it alone costs nothing, and the band would refuse
    // the replacement regardless of how the coverage reads.
    expect(out.decisions).toEqual([]);
  });

  it('still calls a position guarded by a stop that covers more than it', () => {
    // The coverage test is one-sided on purpose. An oversized resting stop does
    // trigger a re-arm, but more protection than asked for is still protection,
    // and painting it red would send the operator hunting for a missing stop.
    const out = run({ input: armInput('8.8320', true, [{ ...resting(), origQty: '4.0' }]) });
    expect(out.blocker?.detail).toMatchObject({ guarded: true });
  });

  it('does not call a position guarded by a stop that covers a fraction of it', () => {
    // A stop armed while a foreign order held most of the base. It exists, it is
    // working, and it protects 16% of the position — reporting that as covered
    // hides a position that is materially naked behind an amber chip.
    const out = run({
      input: armInput('8.8320', true, [{ ...resting(), origQty: '0.5' }]),
    });
    expect(out.blocker?.detail).toMatchObject({ guarded: false });
  });

  it('does not call a position guarded when a foreign lock capped what this tick could size', () => {
    // The same fraction, arrived at from the other direction: a foreign SELL holds
    // 2.13 of the 3.13 position, so this tick can only size 1.00 and the resting
    // stop already matches that reduced size. Judging coverage against what we
    // could size — rather than against full protection — reports a 32%-covered
    // position as guarded, which is the amber chip the operator dismisses.
    const foreign = order({
      orderId: 999,
      clientOrderId: 'ghost',
      symbol: 'LINKUSDT',
      origQty: '2.13',
    });
    const out = run({
      input: armInput('8.8320', true, [{ ...resting(), origQty: '1.00' }, foreign]),
      reclaimableBase: new Decimal('1.00'),
    });
    expect(out.blocker?.reason).toBe('price-outside-exchange-band');
    expect(out.blocker?.detail).toMatchObject({ guarded: false });
  });
});

describe('percentPriceBySideRefusal', () => {
  const desired: DesiredProtectiveStop = {
    stopPrice: '7.462',
    price: '7.312',
    quantity: '3.13',
  };

  const refuse = (
    band: unknown,
    reference = '8.8320',
    over: Partial<DesiredProtectiveStop> = {},
  ): ReturnType<typeof percentPriceBySideRefusal> =>
    percentPriceBySideRefusal({
      symbol: 'LINKUSDT',
      reference,
      band: band as never,
      desired: { ...desired, ...over },
      guarded: false,
    });

  const BAND = {
    askMultiplierUp: '2',
    askMultiplierDown: '0.9',
    bidMultiplierUp: '1.1',
    bidMultiplierDown: '0.5',
    avgPriceMins: 5,
  };

  it('refuses a stop stranded ABOVE the ceiling, not just below the floor', () => {
    // A gap up leaves the previous level far under the market, but the mirror case
    // is real: a trigger above `ref * askMultiplierUp` is refused with the same
    // -1013, and gating only the floor would loop on it exactly as before.
    const out = refuse(BAND, '3.00', { stopPrice: '7.462', price: '7.312' });
    expect(out?.reason).toBe('price-outside-exchange-band');
    // `bound` names the end that was breached: the gloss quotes the floor by
    // default, and quoting a floor at a stop that is too HIGH reads as nonsense.
    expect(out?.detail).toMatchObject({ ceiling: '6', bound: 'ceiling', terminal: false });
  });

  it('bands the trigger as well as the limit price', () => {
    // Binance applies PERCENT_PRICE_BY_SIDE to BOTH legs: a SELL STOP_LOSS whose
    // only price is a stopPrice outside the band is refused -1013, as is a
    // STOP_LOSS_LIMIT whose stopPrice is outside while its price is inside.
    // Judging the limit alone therefore passes an order the exchange rejects.
    // ceiling = 3.7 * 2 = 7.4: the trigger 7.462 is over it, the limit 7.312 is not.
    const out = refuse(BAND, '3.7');
    expect(out?.reason).toBe('price-outside-exchange-band');
    // Only the trigger can breach the ceiling — it is always the higher leg — so
    // the gloss must quote the ceiling, and no offset change can fix a ceiling
    // breach.
    expect(out?.detail).toMatchObject({ ceiling: '7.4', bound: 'ceiling', terminal: false });
  });

  it('imposes no constraint when the band is absent, null, or not an object', () => {
    // Absence is unknown, never zero-width. Refusing to protect a position needs
    // proof the exchange would reject it.
    for (const band of [undefined, null, 'PERCENT_PRICE_BY_SIDE', 42]) {
      expect(refuse(band)).toBeNull();
    }
  });

  it('ignores a multiplier that is zero, negative, or unparseable', () => {
    // `0` would collapse the window to a point and refuse every stop on the
    // symbol — a fail-closed reading of data that simply could not be evaluated.
    expect(refuse({ ...BAND, askMultiplierDown: '0' })).toBeNull();
    expect(refuse({ ...BAND, askMultiplierDown: 'n/a' })).toBeNull();
    expect(refuse({ ...BAND, askMultiplierDown: -0.9 })).toBeNull();
    // Each bound fails open on its own: a garbled floor must not disable the
    // ceiling check that is still evaluable.
    expect(refuse({ ...BAND, askMultiplierUp: 'n/a' }, '8.8320')?.reason).toBe(
      'price-outside-exchange-band',
    );
    // The mirror case: a garbled floor still serialises as null next to a
    // ceiling breach, so the gloss has a bound to quote.
    expect(refuse({ ...BAND, askMultiplierDown: 'n/a' }, '3.00')?.detail).toMatchObject({
      floor: null,
      ceiling: '6',
      bound: 'ceiling',
      terminal: false,
    });
  });

  it('imposes no constraint when the reference or the desired prices do not parse', () => {
    expect(refuse(BAND, 'not-a-price')).toBeNull();
    expect(refuse(BAND, '0')).toBeNull();
    expect(refuse(BAND, '8.8320', { price: '' })).toBeNull();
    expect(refuse(BAND, '8.8320', { stopPrice: 'NaN' })).toBeNull();
  });
});

describe('clampStopToExchangeFloor', () => {
  const BAND = {
    askMultiplierUp: '2',
    askMultiplierDown: '0.9',
    bidMultiplierUp: '1.1',
    bidMultiplierDown: '0.5',
    avgPriceMins: 5,
  };

  const clamp = (
    over: {
      stop?: Decimal | null;
      reference?: string;
      band?: unknown;
      limitOffset?: Decimal;
    } = {},
  ): ReturnType<typeof clampStopToExchangeFloor> =>
    clampStopToExchangeFloor({
      stop: new Decimal('7.462'),
      reference: '8.8320',
      band: BAND,
      limitOffset: new Decimal('0.98'),
      ...over,
    } as Parameters<typeof clampStopToExchangeFloor>[0]);

  it('raises a stop below the floor to the lowest trigger the band accepts', () => {
    const out = clamp();
    expect(out.clamped).toBe(true);
    expect(out.stop?.toString()).toBe('8.1921306122448979592');
    // The property that actually matters: the LIMIT leg, not the trigger, is what
    // the floor binds, so the clamped level must send a limit at or above
    // `reference * askMultiplierDown`.
    expect(out.stop?.mul('0.98').gte(new Decimal('8.8320').mul('0.9'))).toBe(true);
  });

  it('is the identity on every input it cannot evaluate', () => {
    const cases: Array<[string, Parameters<typeof clamp>[0]]> = [
      ['band absent', { band: undefined }],
      ['band null', { band: null }],
      ['band not an object', { band: 'PERCENT_PRICE_BY_SIDE' }],
      ['band is a number', { band: 42 }],
      ['unparseable multiplier', { band: { ...BAND, askMultiplierDown: 'n/a' } }],
      ['zero multiplier', { band: { ...BAND, askMultiplierDown: '0' } }],
      ['unparseable reference', { reference: 'not-a-price' }],
      ['zero reference', { reference: '0' }],
      ['unparseable offset', { limitOffset: new Decimal(NaN) }],
      ['zero offset', { limitOffset: new Decimal('0') }],
      ['negative offset', { limitOffset: new Decimal('-0.98') }],
    ];
    for (const [label, over] of cases) {
      const out = clamp(over);
      expect(out.clamped, label).toBe(false);
      expect(out.stop?.toString(), label).toBe('7.462');
    }
  });

  it('leaves a null stop null rather than inventing a level', () => {
    // Null means "no trail this tick". Clamping it would manufacture a stop the
    // operator never configured out of an exchange filter.
    expect(clamp({ stop: null })).toEqual({ stop: null, clamped: false });
  });

  it('leaves a stop that already clears the floor exactly where it is', () => {
    const settled = clamp({ stop: new Decimal('8.5') });
    expect(settled).toEqual({ stop: new Decimal('8.5'), clamped: false });
  });

  it('refuses to clamp when the floor is not strictly below the reference', () => {
    // askMultiplierDown 0.99 against a 0.98 offset puts the floor above the
    // market. That is the terminal, config-shaped case: clamping there would rest
    // a trigger at or above the current price, which fires on contact — a market
    // sell wearing a stop's name.
    const out = clamp({ band: { ...BAND, askMultiplierDown: '0.99' } });
    expect(out.clamped).toBe(false);
    expect(out.stop?.toString()).toBe('7.462');
  });
});

describe('stillGuarding', () => {
  it('reads an unquantifiable resting stop as NOT covering the position', () => {
    // This flag decides whether the operator is told the position is naked, so
    // every unreadable input has to land on the loud side. An unreadable fill
    // count is the sharp one: reading it as zero fills would report a stop that
    // is almost entirely filled as full coverage.
    expect(stillGuarding(order({ origQty: '' }), '2')).toBe(false);
    expect(stillGuarding(order({ executedQty: 'n/a' }), '2')).toBe(false);
    expect(stillGuarding(order(), 'n/a')).toBe(false);
    expect(stillGuarding(order(), '0')).toBe(false);
    expect(stillGuarding(order(), '2')).toBe(true);
  });
});

describe('nativeTrailingDelta', () => {
  const BOUNDS: TrailingDeltaFilter = {
    minTrailingAboveDelta: 10,
    maxTrailingAboveDelta: 2000,
    minTrailingBelowDelta: 10,
    maxTrailingBelowDelta: 2000,
  };

  const delta = (over: { stopDistancePct?: Decimal; filter?: unknown } = {}) =>
    nativeTrailingDelta({
      stopDistancePct: new Decimal('0.15'),
      filter: BOUNDS,
      ...over,
    } as Parameters<typeof nativeTrailingDelta>[0]);

  it('is the CONFIGURED stop distance in basis points, rounded to a whole delta', () => {
    // Binance takes only whole basis points, so 15% goes out as 1500 — and it is
    // read off the setting, never off the live price, because the exchange
    // already measures the distance from its own high-water mark.
    expect(delta()).toBe(1500);
    expect(delta({ stopDistancePct: new Decimal('0.15505434') })).toBe(1551);
  });

  it('does not move when the price does, so a resting trail is never re-armed for drift', () => {
    // The delta reads no price at all. This is the property the whole mode rests
    // on: a delta re-derived per tick would differ by a basis point on almost
    // every tick, and each replacement restarts the high-water mark Binance has
    // been accumulating — the trail would track nothing.
    expect(delta()).toBe(delta());
  });

  it('reads only the Below bounds, which are the ones a SELL stop trails within', () => {
    // An Above pair that would reject the delta must not: it governs a trailing
    // BUY, and applying it here would refuse a distance the symbol accepts.
    expect(delta({ filter: { ...BOUNDS, minTrailingAboveDelta: 9000 } })).toBe(1500);
  });

  it('returns null rather than clamping a delta outside the symbol bounds', () => {
    // Clamping would rest a stop at a distance the operator never chose while
    // reporting success. Null hands the caller back to the ordinary refusal,
    // which at least says out loud that no stop could be armed.
    expect(delta({ filter: { ...BOUNDS, maxTrailingBelowDelta: 1000 } })).toBeNull();
    expect(delta({ filter: { ...BOUNDS, minTrailingBelowDelta: 2000 } })).toBeNull();
  });

  it('is null on every input it cannot evaluate', () => {
    const cases: Array<[string, Parameters<typeof delta>[0]]> = [
      ['filter absent', { filter: undefined }],
      ['filter null', { filter: null }],
      ['filter not an object', { filter: 'TRAILING_DELTA' }],
      ['non-integer bounds', { filter: { ...BOUNDS, minTrailingBelowDelta: 10.5 } }],
      ['string bounds', { filter: { ...BOUNDS, maxTrailingBelowDelta: '2000' } }],
      // A distance at or below zero is not a stop, and one at or above 1 puts the
      // trigger at or below zero. Both read as "no usable delta" rather than
      // being clamped into range, so a nonsense setting falls back to the refusal.
      ['zero distance', { stopDistancePct: new Decimal(0) }],
      ['negative distance', { stopDistancePct: new Decimal('-0.15') }],
      ['whole distance', { stopDistancePct: new Decimal(1) }],
      ['distance beyond 1', { stopDistancePct: new Decimal('1.5') }],
      ['non-finite distance', { stopDistancePct: new Decimal(NaN) }],
    ];
    for (const [label, over] of cases) {
      expect(delta(over), label).toBeNull();
    }
  });
});

describe('evaluateProtectiveStopArm — exchange-native trailing escape', () => {
  // The same live LINKUSDT refusal, with `onBandBlock: 'native-trail'` chosen:
  // the priced stop cannot be accepted, so the arm hands the distance to Binance
  // instead of leaving the position on last tick's level.
  const LINK_OURS = 'mom-p1-linkusdt-ps';

  const FILTERS: SizeFilters = {
    step: new Decimal('0.01'),
    minQty: new Decimal('0.01'),
    minNotional: new Decimal('5'),
  };

  const symbolFilters = (withTrailing: boolean): SymbolFilters => ({
    minNotional: '5',
    tickSize: '0.001',
    stepSize: '0.01',
    minQty: '0.01',
    maxQty: '92141578',
    minPrice: '0.001',
    maxPrice: '10000',
    percentPriceBySide: {
      askMultiplierUp: '2',
      askMultiplierDown: '0.9',
      bidMultiplierUp: '1.1',
      bidMultiplierDown: '0.5',
      avgPriceMins: 5,
    },
    ...(withTrailing
      ? {
          trailingDelta: {
            minTrailingAboveDelta: 10,
            maxTrailingAboveDelta: 2000,
            minTrailingBelowDelta: 10,
            maxTrailingBelowDelta: 2000,
          },
        }
      : {}),
  });

  const stopLevel = (over: Partial<ProtectiveStopLevel> = {}): ProtectiveStopLevel => ({
    stop: new Decimal('7.462'),
    limit: new Decimal('7.312'),
    held: new Decimal('3.13'),
    filters: FILTERS,
    tick: new Decimal('0.001'),
    ...over,
  });

  type Params = ProtectiveStopArmParams<unknown, unknown, Record<string, never>>;

  const linkAccount = (): AccountSnapshot => ({
    balances: {
      LINK: { asset: 'LINK', free: new Decimal('0'), locked: new Decimal('3.13') } as Balance,
    },
    readable: true,
  });

  const armInput = (
    currentPrice: string,
    withTrailing: boolean,
    openOrders: OpenOrder[],
  ): Params['input'] =>
    ({
      openOrders,
      account: linkAccount(),
      market: {
        symbol: 'LINKUSDT',
        currentPrice,
        symbolInfo: {
          baseAsset: 'LINK',
          quoteAsset: 'USDT',
          filters: symbolFilters(withTrailing),
        },
      },
    }) as unknown as Params['input'];

  const buildPlace = (desired: DesiredProtectiveStop): Decision => ({
    type: 'place-order',
    intent: {
      symbol: 'LINKUSDT',
      side: 'SELL',
      reason: 'protective-stop',
      clientOrderId: LINK_OURS,
    },
    params: {
      type: 'STOP_LOSS_LIMIT',
      stopPrice: desired.stopPrice,
      price: desired.price,
      quantity: desired.quantity,
      timeInForce: 'GTC',
    },
  });

  const buildCancel = (r: OpenOrder): Decision => ({
    type: 'cancel-order',
    orderId: r.orderId,
    symbol: 'LINKUSDT',
    reason: 'superseded',
  });

  // The plugin seam the worker really uses: a STOP_LOSS with a distance and no
  // prices at all.
  const buildNativeTrailPlace = (desired: {
    quantity: string;
    trailingDelta: number;
  }): Decision => ({
    type: 'place-order',
    intent: {
      symbol: 'LINKUSDT',
      side: 'SELL',
      reason: 'protective-stop',
      clientOrderId: LINK_OURS,
    },
    params: {
      type: 'STOP_LOSS',
      quantity: desired.quantity,
      trailingDelta: desired.trailingDelta,
    },
  });

  const priced = (): OpenOrder =>
    order({
      orderId: 4242,
      clientOrderId: LINK_OURS,
      symbol: 'LINKUSDT',
      price: '7.154',
      stopPrice: '7.300',
      origQty: '3.13',
      executedQty: '0',
    });

  const trailing = (trailingDelta: number, origQty = '3.13'): OpenOrder =>
    order({
      orderId: 4243,
      clientOrderId: LINK_OURS,
      symbol: 'LINKUSDT',
      type: 'STOP_LOSS',
      // What Binance reports for a trailing stop: no limit leg, no trigger.
      price: '0',
      stopPrice: undefined,
      trailingDelta,
      origQty,
      executedQty: '0',
    });

  const run = (over: Partial<Params>): ReturnType<typeof evaluateProtectiveStopArm> =>
    evaluateProtectiveStopArm({
      input: armInput('8.8320', true, [priced()]),
      enabled: true,
      level: stopLevel(),
      reclaimableBase: new Decimal('3.13'),
      ourClientOrderId: LINK_OURS,
      buildPlace,
      buildCancel,
      nativeTrail: { stopDistancePct: new Decimal('0.1551'), build: buildNativeTrailPlace },
      ...over,
    } as Params);

  it('places a STOP_LOSS carrying only a trailing distance when the band refuses the priced stop', () => {
    const out = run({ input: armInput('8.8320', true, []) });
    expect(out.blocker).toBeNull();
    expect(out.decisions).toEqual([
      buildNativeTrailPlace({ quantity: '3.13', trailingDelta: 1551 }),
    ]);
    // The three absences ARE the escape: Binance bands a trigger and a limit
    // price, so an order carrying neither is accepted at the operator's full
    // distance instead of being tightened to whatever the floor allows.
    const [place] = out.decisions;
    const params = place?.type === 'place-order' ? place.params : undefined;
    expect(params?.stopPrice).toBeUndefined();
    expect(params?.price).toBeUndefined();
    expect(params?.type).toBe('STOP_LOSS');
  });

  it('swaps a refused priced stop for the trail, cancelling the old one in the same batch', () => {
    const out = run({});
    expect(out.blocker).toBeNull();
    expect(out.decisions).toEqual([
      buildCancel(priced()),
      buildNativeTrailPlace({ quantity: '3.13', trailingDelta: 1551 }),
    ]);
  });

  it('falls back to the ordinary refusal when the symbol publishes no TRAILING_DELTA bounds', () => {
    // Absent bounds are unknown bounds. Guessing a delta would send an order the
    // exchange may reject; the refusal at least tells the operator the truth.
    const out = run({ input: armInput('8.8320', false, [priced()]) });
    expect(out.decisions).toEqual([]);
    expect(out.blocker?.reason).toBe('price-outside-exchange-band');
  });

  it('falls back to the ordinary refusal when the configured distance is outside the symbol bounds', () => {
    const out = run({
      nativeTrail: { stopDistancePct: new Decimal('0.25'), build: buildNativeTrailPlace },
    });
    expect(out.decisions).toEqual([]);
    expect(out.blocker?.reason).toBe('price-outside-exchange-band');
  });

  it('takes the trail only on a FLOOR breach, never on a ceiling one', () => {
    // A ceiling breach means the trigger sits above the market by more than the
    // band allows — an exit meant to fire almost at once. A stop trailing 15.51%
    // DOWN from a high-water mark expresses the opposite, so the escape does not
    // apply and the operator gets told the truth instead.
    const out = run({ input: armInput('3.7', true, [priced()]) });
    expect(out.decisions).toEqual([]);
    expect(out.blocker?.reason).toBe('price-outside-exchange-band');
    expect(out.blocker?.detail.bound).toBe('ceiling');
  });

  it('leaves a resting trail alone while its distance still matches the configuration', () => {
    // Price moves every tick; the trail moves with it. Cancel + re-place would
    // reset the high-water mark Binance has been accumulating and hand back a
    // stop measured from a lower peak — strictly worse protection, for free.
    const out = run({ input: armInput('9.50', true, [trailing(1551)]) });
    expect(out.decisions).toEqual([]);
    expect(out.blocker).toBeNull();
  });

  it('re-arms a resting trail only when the CONFIGURED distance differs from the resting one', () => {
    const out = run({ input: armInput('8.8320', true, [trailing(900)]) });
    expect(out.decisions).toEqual([
      buildCancel(trailing(900)),
      buildNativeTrailPlace({ quantity: '3.13', trailingDelta: 1551 }),
    ]);
  });

  it('re-sizes an undersized resting trail even though its distance still matches', () => {
    // A trail armed while a foreign order held part of the base protects only
    // that partial quantity. Nothing else ever resizes it, so skipping the
    // quantity band for trails leaves the position permanently under-protected.
    const out = run({ input: armInput('8.8320', true, [trailing(1551, '1.00')]) });
    expect(out.decisions).toEqual([
      buildCancel(trailing(1551, '1.00')),
      buildNativeTrailPlace({ quantity: '3.13', trailingDelta: 1551 }),
    ]);
  });

  it('retires a resting trail when the operator leaves native-trail', () => {
    // Switching back to a priced stop must actually reach the exchange. A trail
    // reports no `stopPrice`, so a drift test alone reads it as unparseable and
    // leaves it resting for the life of the position while the arm reports
    // nothing wrong.
    const out = evaluateProtectiveStopArm({
      input: armInput('8.10', true, [trailing(1551)]),
      enabled: true,
      level: stopLevel(),
      reclaimableBase: new Decimal('3.13'),
      ourClientOrderId: LINK_OURS,
      buildPlace,
      buildCancel,
    } as Params);
    expect(out.blocker).toBeNull();
    expect(out.decisions).toEqual([
      buildCancel(trailing(1551)),
      buildPlace({ stopPrice: '7.462', price: '7.312', quantity: '3.13' }),
    ]);
  });

  it('keeps a resting trail when no delta can be derived at all', () => {
    // The symbol stopped publishing its bounds, or the operator switched the mode
    // back. Either way the live order is real protection: tearing it down for an
    // order this tick cannot place is the failure mode the whole band fix exists
    // to prevent.
    const out = run({ input: armInput('8.8320', false, [trailing(1551)]) });
    expect(out.decisions).toEqual([]);
    expect(out.blocker).toBeNull();
  });

  it('behaves exactly as the priced arm does when the operator did not opt in', () => {
    // An absent `nativeTrail` bundle is `onBandBlock: notify` (and an unset key on
    // an existing profile row). Nothing about the trail may leak into that path.
    const notify = evaluateProtectiveStopArm({
      input: armInput('8.8320', true, [priced()]),
      enabled: true,
      level: stopLevel(),
      reclaimableBase: new Decimal('3.13'),
      ourClientOrderId: LINK_OURS,
      buildPlace,
      buildCancel,
    } as Params);
    expect(notify.decisions).toEqual([]);
    expect(notify.blocker?.reason).toBe('price-outside-exchange-band');
  });

  it('places the ordinary priced stop when the band accepts it, trail opted in or not', () => {
    // The escape is a fallback, never a preference: a market-on-trigger sell has
    // no price protection at all, so it is only worth taking when the alternative
    // is no stop.
    const out = run({ input: armInput('8.10', true, [priced()]) });
    expect(out.blocker).toBeNull();
    expect(out.decisions).toEqual([
      buildCancel(priced()),
      buildPlace({ stopPrice: '7.462', price: '7.312', quantity: '3.13' }),
    ]);
  });
});

describe('nativeTrailPreviewNote', () => {
  const BAND = {
    askMultiplierUp: '2',
    askMultiplierDown: '0.9',
    bidMultiplierUp: '1.1',
    bidMultiplierDown: '0.5',
    avgPriceMins: 5,
  };

  const TRAILING: TrailingDeltaFilter = {
    minTrailingAboveDelta: 10,
    maxTrailingAboveDelta: 2000,
    minTrailingBelowDelta: 10,
    maxTrailingBelowDelta: 2000,
  };

  const note = (
    over: {
      stop?: Decimal;
      limit?: Decimal;
      tick?: Decimal | null;
      reference?: string | null;
      stopDistancePct?: Decimal;
      band?: unknown;
      trailing?: unknown;
    } = {},
  ): string | null =>
    nativeTrailPreviewNote({
      stop: new Decimal('7.462'),
      limit: new Decimal('7.312'),
      tick: new Decimal('0.001'),
      reference: '8.8320',
      stopDistancePct: new Decimal('0.15505434'),
      band: BAND,
      trailing: TRAILING,
      ...over,
    } as Parameters<typeof nativeTrailPreviewNote>[0]);

  it('quotes the distance read back OUT of the delta the order will carry', () => {
    // 1551 bips is 15.51%, not the 15.505434% configured: the rounding to whole
    // basis points is real, and the sentence has to describe the order that
    // rests, not the setting that produced it.
    expect(note()).toContain('15.51%');
    expect(note()).toContain('highest price seen since it was placed');
  });

  it('is null whenever the priced stop is what will actually rest', () => {
    // Inside the band, or no band published: the ordinary row with its trigger
    // price is correct, and this note would contradict it.
    expect(note({ reference: '8.10' })).toBeNull();
    expect(note({ band: undefined })).toBeNull();
    expect(note({ reference: null })).toBeNull();
  });

  it('is null when no usable delta exists, so no row claims a trail that cannot be placed', () => {
    expect(note({ trailing: undefined })).toBeNull();
    expect(note({ trailing: { ...TRAILING, maxTrailingBelowDelta: 1000 } })).toBeNull();
  });

  it('judges the band on the tick grid, the way the arm does', () => {
    // Floor is 9.0. The raw limit sits 0.0004 under it, so unrounded the band
    // refuses and this row claims a trail; on the 0.001 grid the same leg rounds
    // to 9.000 and the band accepts, which is what the arm sends. Rounding here
    // is not cosmetic: it decides which of two contradictory rows is printed on
    // the tick the market sits on the boundary.
    const boundary = { stop: new Decimal('9.1'), limit: new Decimal('8.9996'), reference: '10' };
    expect(note({ ...boundary, tick: null })).not.toBeNull();
    expect(note({ ...boundary, tick: new Decimal('0.001') })).toBeNull();
  });
});
