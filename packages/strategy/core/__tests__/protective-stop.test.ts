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
} from '../src/index.js';
import {
  armableBaseQuantity,
  classifyProtectiveStopRefusal,
  evaluateProtectiveStopArm,
  findForeignRestingSell,
  findRestingProtectiveStop,
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

  it('bands the limit price only, never the trigger', () => {
    // `PRICE_FILTER` spells out that it covers price AND stopPrice;
    // PERCENT_PRICE_BY_SIDE names only the order price. Banding the trigger as
    // well would defer a stop the exchange accepts, and a deferred first arm is
    // an unguarded position waiting on a rule Binance does not enforce.
    // ceiling = 3.7 * 2 = 7.4: the trigger 7.462 is over it, the limit 7.312 is not.
    expect(refuse(BAND, '3.7')).toBeNull();
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
