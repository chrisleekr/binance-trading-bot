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
} from '../src/index.js';
import {
  armableBaseQuantity,
  classifyProtectiveStopRefusal,
  evaluateProtectiveStopArm,
  findForeignRestingSell,
  findRestingProtectiveStop,
  ownRestingSellBase,
  protectiveStopNeedsRearm,
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

  const armInput = (openOrders: OpenOrder[], acct: AccountSnapshot): Params['input'] =>
    ({
      openOrders,
      account: acct,
      market: { symbol: 'BTCUSDT', symbolInfo: { baseAsset: 'BTC' } },
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
