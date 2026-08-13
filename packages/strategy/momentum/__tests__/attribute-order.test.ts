import { describe, expect, it } from 'vitest';
import {
  entryClientOrderId,
  exitClientOrderId,
  momentumAttributeOrder,
  protectiveStopClientOrderId,
} from '../src/client-order-id.js';

const PROFILE = '11111111-1111-1111-1111-111111111111';
const OTHER_PROFILE = '22222222-2222-2222-2222-222222222222';
const SYMBOL = 'BTCUSDT';

// Attribution decides which profile an orphaned exchange order is handed back to,
// so a false claim is worse than no claim: adopting an order into a profile whose
// strategy cannot recognise it locks that profile's base asset behind an order it
// will never reprice or cancel. Under-claiming is safe (the operator cancels on
// Binance); over-claiming wedges a profile.
describe('momentumAttributeOrder', () => {
  it('claims the protective stop it would itself place for this (profile, symbol)', () => {
    expect(
      momentumAttributeOrder({
        clientOrderId: protectiveStopClientOrderId(PROFILE, SYMBOL),
        profileId: PROFILE,
        symbol: SYMBOL,
      }),
    ).toEqual({ intent: 'protective-stop' });
  });

  it('refuses the same stop id when it belongs to a SIBLING profile', () => {
    // The id folds the profile, so a sibling's stop is not ours to adopt — this is
    // the check that stops one profile absorbing another's resting order.
    expect(
      momentumAttributeOrder({
        clientOrderId: protectiveStopClientOrderId(OTHER_PROFILE, SYMBOL),
        profileId: PROFILE,
        symbol: SYMBOL,
      }),
    ).toBeNull();
  });

  it('refuses its own stop id raised against a DIFFERENT symbol', () => {
    expect(
      momentumAttributeOrder({
        clientOrderId: protectiveStopClientOrderId(PROFILE, 'ETHUSDT'),
        profileId: PROFILE,
        symbol: SYMBOL,
      }),
    ).toBeNull();
  });

  it('refuses its own entry and exit ids: they fold a candle time it cannot re-derive', () => {
    // Deliberate under-claim. Entry/exit ids are seeded with runtime data that is
    // not recoverable from the order alone, so momentum cannot prove one is its
    // own — and a guess here is the wedge this whole gate exists to prevent.
    const candleMs = 1_700_000_000_000;
    for (const id of [
      entryClientOrderId(PROFILE, SYMBOL, candleMs),
      exitClientOrderId(PROFILE, SYMBOL, candleMs),
    ]) {
      expect(
        momentumAttributeOrder({ clientOrderId: id, profileId: PROFILE, symbol: SYMBOL }),
      ).toBeNull();
    }
  });

  it("refuses another strategy's order outright", () => {
    expect(
      momentumAttributeOrder({
        clientOrderId: 'tt-1fdb6900-x',
        profileId: PROFILE,
        symbol: SYMBOL,
      }),
    ).toBeNull();
  });
});
