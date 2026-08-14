import { describe, it, expect } from 'vitest';
import type { AccountDto, OpenOrderDto } from '@app/binance';
import { Decimal } from '@app/money';
import { accountSnapshotFromDto, openOrdersFromDtos } from '../../src/lib/binance-snapshot.js';

describe('accountSnapshotFromDto', () => {
  it('keys balances by asset (Record shape, not array)', () => {
    const dto: AccountDto = {
      balances: [
        { asset: 'BTC', free: '0.5', locked: '0' },
        { asset: 'USDT', free: '100', locked: '15' },
      ],
      canTrade: true,
    };
    const snap = accountSnapshotFromDto(dto);
    expect(snap.balances).toEqual({
      BTC: { asset: 'BTC', free: new Decimal('0.5'), locked: new Decimal('0') },
      USDT: { asset: 'USDT', free: new Decimal('100'), locked: new Decimal('15') },
    });
  });

  it('returns empty record on empty balances array', () => {
    expect(accountSnapshotFromDto({ balances: [], canTrade: true })).toEqual({
      balances: {},
      readable: true,
    });
  });
});

describe('openOrdersFromDtos', () => {
  const dto = (overrides: Partial<OpenOrderDto> = {}): OpenOrderDto => ({
    symbol: 'BTCUSDT',
    orderId: 42,
    clientOrderId: 'co-1',
    side: 'BUY',
    type: 'LIMIT',
    price: '50000',
    origQty: '0.001',
    executedQty: '0',
    status: 'NEW',
    stopPrice: '0',
    time: 1_700_000_000_000,
    updateTime: 1_700_000_000_500,
    cummulativeQuoteQty: '0',
    timeInForce: 'GTC',
    ...overrides,
  });

  it('maps DTO timestamps to *Ms fields and preserves enums', () => {
    const [o] = openOrdersFromDtos([dto()]);
    expect(o).toEqual({
      orderId: 42,
      clientOrderId: 'co-1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      status: 'NEW',
      price: '50000',
      origQty: '0.001',
      executedQty: '0',
      cummulativeQuoteQty: '0',
      timeInForce: 'GTC',
      transactTimeMs: 1_700_000_000_000,
      updateTimeMs: 1_700_000_000_500,
    });
  });

  it('omits stopPrice when DTO reports any zero-valued decimal (non-stop order)', () => {
    // Binance reports zero stop-price in several forms depending on
    // endpoint/symbol — all mean "no stop price set".
    for (const zero of ['0', '0.0', '0.00000000', '']) {
      const [o] = openOrdersFromDtos([dto({ stopPrice: zero })]);
      expect(o).not.toHaveProperty('stopPrice');
    }
  });

  it('includes stopPrice when DTO reports a real value', () => {
    const [o] = openOrdersFromDtos([dto({ stopPrice: '49000' })]);
    expect(o.stopPrice).toBe('49000');
  });

  it('omits timeInForce when DTO omits it', () => {
    const [o] = openOrdersFromDtos([dto({ timeInForce: undefined })]);
    expect(o).not.toHaveProperty('timeInForce');
  });

  it('throws on unknown enum values so the strategy never reasons about coerced state', () => {
    expect(() => openOrdersFromDtos([dto({ type: 'SOME_FUTURE_TYPE' })])).toThrow(/unknown type/);
    expect(() => openOrdersFromDtos([dto({ status: 'BROKEN' })])).toThrow(/unknown status/);
  });

  it('narrows a resting exchange-native trailing stop instead of throwing on it', () => {
    // A STOP_LOSS rests whenever a protective stop went out as a native trail.
    // The throw above lands INSIDE the tick, so an unlisted type would
    // dead-letter every tick on that symbol for as long as the order rests —
    // the position would go wholly unmanaged, which is the opposite of what
    // arming a stop was for.
    const [o] = openOrdersFromDtos([
      dto({ type: 'STOP_LOSS', side: 'SELL', stopPrice: '0', trailingDelta: 1551 }),
    ]);
    expect(o.type).toBe('STOP_LOSS');
    // The distance is the only field that can tell a later tick whether the
    // resting order still matches the configured stop: a trailing order has no
    // readable trigger, because the exchange moves it.
    expect(o.trailingDelta).toBe(1551);
    expect(o).not.toHaveProperty('stopPrice');
  });

  it('omits trailingDelta on every order that does not carry one', () => {
    expect(openOrdersFromDtos([dto()])[0]).not.toHaveProperty('trailingDelta');
    // Binance omits the field entirely on a non-trailing order; a non-numeric
    // value is a payload we cannot read, and reading it as a distance would
    // compare a resting order against a number it does not hold.
    expect(
      openOrdersFromDtos([dto({ trailingDelta: '1551' } as Partial<OpenOrderDto>)])[0],
    ).not.toHaveProperty('trailingDelta');
  });
});
