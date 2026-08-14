// Binance reports `n`/`N` (commission) PER TRADE while `z`/`Z` are cumulative,
// so the order's total fee has to be summed across its execution reports. These
// cover the summing itself; the router wiring is covered separately.

import { describe, expect, it } from 'vitest';

import {
  createOrderCommissionAccumulator,
  orderCommissionKey,
} from '../../src/executor/order-commission-accumulator.js';

const KEY = orderCommissionKey('acct-1', 'TSTUSDT', 42);

/** Movable clock: the accumulator never reads ambient time. */
const makeClock = (startMs = 1_000) => {
  let nowMs = startMs;
  return { nowMs: () => nowMs, advance: (ms: number) => (nowMs += ms) };
};

const makeAcc = () => createOrderCommissionAccumulator(makeClock());

const trade = (tradeId: number, commission: string, commissionAsset = 'TST') => ({
  executionType: 'TRADE',
  tradeId,
  commission,
  commissionAsset,
});

describe('order-commission accumulator', () => {
  it('sums the per-trade commissions of one order and repeats the total for the profile fan-out', () => {
    const acc = makeAcc();

    acc.record(KEY, trade(1, '0.5'));
    acc.record(KEY, trade(2, '0.25'));
    acc.record(KEY, trade(3, '0.9323'));

    expect(acc.take(KEY)).toEqual({ commissions: { TST: '1.6823' } });
    // One account, N profiles, one stream: the same terminal report is routed
    // once per profile and each must be able to hand the adopter the whole fee.
    expect(acc.take(KEY)).toEqual({ commissions: { TST: '1.6823' } });
  });

  it('evicts a terminal entry once the fan-out window has passed', () => {
    const clock = makeClock();
    const acc = createOrderCommissionAccumulator(clock);

    acc.record(KEY, trade(1, '0.5'));
    expect(acc.take(KEY)).toEqual({ commissions: { TST: '0.5' } });

    // The fan-out is milliseconds; well past it the entry must not linger.
    clock.advance(120_000);
    expect(acc.take(KEY)).toBeNull();
  });

  it('folds partials that arrive out of trade-id order', () => {
    const acc = makeAcc();

    // The user-stream pool dispatches handlers without awaiting, so a later
    // trade can be folded first. A monotonic watermark would drop trade 1.
    acc.record(KEY, trade(3, '0.9323'));
    acc.record(KEY, trade(1, '0.5'));
    acc.record(KEY, trade(2, '0.25'));

    expect(acc.take(KEY)).toEqual({ commissions: { TST: '1.6823' } });
  });

  it('preserves per-asset totals when the other-asset trade arrives late', () => {
    const acc = makeAcc();

    acc.record(KEY, trade(3, '0.9323', 'TST'));
    acc.record(KEY, trade(1, '0.00004', 'BNB'));

    expect(acc.take(KEY)).toEqual({ commissions: { BNB: '0.00004', TST: '0.9323' } });
  });

  it('makes the order commission unknown when a trade id is not an integer', () => {
    const acc = makeAcc();

    // Without a stable trade identity, an identical reconnect replay cannot be
    // distinguished from a second fee and no total can be stated honestly.
    acc.record(KEY, trade(Number.NaN, '0.5'));
    acc.record(KEY, trade(Number.NaN, '0.5'));

    expect(acc.take(KEY)).toBeNull();
  });

  it('ignores a replayed trade id, so a Binance reconnect cannot double-count', () => {
    const acc = makeAcc();

    acc.record(KEY, trade(1, '0.5'));
    acc.record(KEY, trade(2, '0.25'));
    acc.record(KEY, trade(2, '0.25'));
    acc.record(KEY, trade(1, '0.5'));

    expect(acc.take(KEY)).toEqual({ commissions: { TST: '0.75' } });
  });

  it('ignores non-TRADE reports (a bare NEW/CANCELED carries no fee)', () => {
    const acc = makeAcc();

    acc.record(KEY, { executionType: 'NEW', tradeId: -1, commission: '0', commissionAsset: '' });
    acc.record(KEY, {
      executionType: 'CANCELED',
      tradeId: -1,
      commission: '0',
      commissionAsset: '',
    });

    expect(acc.take(KEY)).toBeNull();
  });

  it('preserves the subtotal for every commission asset on a mixed-fee order', () => {
    const acc = makeAcc();

    // A BNB balance running out mid-order switches the fee asset. The adopter
    // needs both subtotals so it can subtract only the base-asset fee.
    acc.record(KEY, trade(1, '0.00004', 'BNB'));
    acc.record(KEY, trade(2, '0.9323', 'TST'));

    expect(acc.take(KEY)).toEqual({ commissions: { BNB: '0.00004', TST: '0.9323' } });
  });

  it.each([
    ['unparsable commission', trade(2, 'not-a-number')],
    ['non-finite commission', trade(2, 'NaN')],
    ['empty commission asset', trade(2, '0.25', '')],
    ['conflicting replay amount', trade(1, '0.6')],
    ['conflicting replay asset', trade(1, '0.5', 'BNB')],
  ])('makes the whole order unknowable after a %s', (_case, corruptTrade) => {
    const acc = makeAcc();

    acc.record(KEY, trade(1, '0.5'));
    acc.record(KEY, corruptTrade);

    expect(acc.take(KEY)).toBeNull();
  });

  it('keys orders by symbol as well as id (Binance order ids are unique per symbol)', () => {
    const acc = makeAcc();
    const other = orderCommissionKey('acct-1', 'BTCUSDT', 42);

    acc.record(KEY, trade(1, '1.5'));
    acc.record(other, trade(1, '0.002', 'BTC'));

    expect(acc.take(KEY)).toEqual({ commissions: { TST: '1.5' } });
    expect(acc.take(other)).toEqual({ commissions: { BTC: '0.002' } });
  });

  it('keys orders by account as well as symbol and id', () => {
    const acc = makeAcc();
    // Binance order ids are unique per symbol, not per account, so two accounts
    // trading the same symbol legitimately collide on (symbol, orderId) — and
    // an account-blind key would merge their fees into one order's total.
    const otherAccount = orderCommissionKey('acct-2', 'TSTUSDT', 42);

    acc.record(KEY, trade(1, '1.5'));
    acc.record(otherAccount, trade(1, '0.25'));

    expect(acc.take(KEY)).toEqual({ commissions: { TST: '1.5' } });
    expect(acc.take(otherAccount)).toEqual({ commissions: { TST: '0.25' } });
  });

  it('ignores a zero or unparsable commission rather than folding a bogus number', () => {
    const acc = makeAcc();

    acc.record(KEY, trade(1, '0'));
    acc.record(KEY, trade(2, 'not-a-number'));

    expect(acc.take(KEY)).toBeNull();
  });

  it('does not expose a partial total after a NaN commission', () => {
    const acc = makeAcc();

    // A later valid report must not turn a known-corrupt order into a
    // trustworthy partial total.
    acc.record(KEY, trade(1, 'NaN'));
    acc.record(KEY, trade(2, '0.5'));

    expect(acc.take(KEY)).toBeNull();
  });
});
