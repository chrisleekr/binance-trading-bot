import { Decimal } from '@app/money';
import { describe, expect, it } from 'vitest';

import {
  assertClientOrderId,
  BINANCE_CLIENT_ORDER_ID_MAX,
  djb2Hex,
} from '../src/client-order-id.js';
import type { SymbolFilters } from '../src/contract.js';
import { finalise, parseFilters } from '../src/sizing.js';
import { asStringOrNull, currentSchemaBody } from '../src/state-body.js';

describe('currentSchemaBody', () => {
  it('returns the body when the schemaVersion matches', () => {
    const body = { schemaVersion: '2.0.0', x: 1 };
    expect(currentSchemaBody('2.0.0', body)).toBe(body);
  });

  it('returns null for a foreign / un-migrated schema version', () => {
    expect(currentSchemaBody('2.0.0', { schemaVersion: '1.0.0' })).toBeNull();
    expect(currentSchemaBody('2.0.0', { x: 1 })).toBeNull();
  });

  it('returns null for a non-object body', () => {
    expect(currentSchemaBody('2.0.0', null)).toBeNull();
    expect(currentSchemaBody('2.0.0', 'str')).toBeNull();
    expect(currentSchemaBody('2.0.0', 42)).toBeNull();
    expect(currentSchemaBody('2.0.0', undefined)).toBeNull();
  });
});

describe('asStringOrNull', () => {
  it('passes a string through', () => {
    expect(asStringOrNull('x')).toBe('x');
  });

  it('maps null and undefined to null', () => {
    expect(asStringOrNull(null)).toBeNull();
    expect(asStringOrNull(undefined)).toBeNull();
  });

  it('maps a populated-but-malformed (non-string) value to undefined', () => {
    expect(asStringOrNull(42)).toBeUndefined();
    expect(asStringOrNull({})).toBeUndefined();
  });
});

describe('assertClientOrderId', () => {
  it('returns an id exactly at the Binance length limit', () => {
    const id = 'a'.repeat(BINANCE_CLIENT_ORDER_ID_MAX);
    expect(assertClientOrderId(id)).toBe(id);
  });

  it('throws for an over-length id (would dead-end at the exchange)', () => {
    const id = 'a'.repeat(BINANCE_CLIENT_ORDER_ID_MAX + 1);
    expect(() => assertClientOrderId(id)).toThrow(/exceeds Binance 36-char limit/);
  });
});

describe('djb2Hex', () => {
  it('is deterministic and stable for known inputs (locks the order-id suffix)', () => {
    // These exact outputs are the suffixes both strategy plugins produced from
    // their now-deleted local copies. Locking them proves the hoist is
    // behaviour-preserving: any drift would change a clientOrderId and break
    // retry coalescing (invariant #2).
    expect(djb2Hex('')).toBe('00001505');
    expect(djb2Hex('abc')).toBe('0b885c8b');
    expect(djb2Hex('p1|BTCUSDT')).toBe('57638a9b');
    expect(djb2Hex('p1|BTCUSDT|2')).toBe('be70ad89');
    expect(djb2Hex('00000000-0000-4000-8000-00000000a101|ETHUSDT|1717400000000')).toBe('ee721c55');
  });

  it('always returns 8 lowercase hex chars (fits the Binance suffix budget)', () => {
    for (const s of ['', 'x', 'a much longer input string with spaces and 123', '|||']) {
      expect(djb2Hex(s)).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('returns the same suffix on repeated calls (retry-stability)', () => {
    const s = 'profile-9|SOLUSDT|7';
    expect(djb2Hex(s)).toBe(djb2Hex(s));
  });
});

const filters = (
  o: Partial<{ stepSize: string; minQty: string; minNotional: string }> = {},
): SymbolFilters =>
  ({ stepSize: '0.001', minQty: '0.001', minNotional: '10', ...o }) as unknown as SymbolFilters;

describe('parseFilters', () => {
  it('parses valid filters into Decimals', () => {
    const p = parseFilters(filters());
    expect(p).not.toBeNull();
    expect(p?.step.toString()).toBe('0.001');
    expect(p?.minQty.toString()).toBe('0.001');
    expect(p?.minNotional.toString()).toBe('10');
  });

  it('returns null for an unparseable filter value', () => {
    expect(parseFilters(filters({ stepSize: 'abc' }))).toBeNull();
  });

  it('returns null for a non-positive step', () => {
    expect(parseFilters(filters({ stepSize: '0' }))).toBeNull();
  });
});

describe('finalise', () => {
  const f = {
    step: new Decimal('0.001'),
    minQty: new Decimal('0.5'),
    minNotional: new Decimal('10'),
  };

  it('returns the step-formatted quantity for a valid order', () => {
    expect(finalise(new Decimal('1.234'), new Decimal('100'), f)).toEqual({ quantity: '1.234' });
  });

  it('skips min-qty for a sub-minQty or non-positive quantity', () => {
    expect(finalise(new Decimal('0.4'), new Decimal('100'), f)).toEqual({ skip: 'min-qty' });
    expect(finalise(new Decimal('0'), new Decimal('100'), f)).toEqual({ skip: 'min-qty' });
  });

  it('skips min-notional when quantity * price is below the floor', () => {
    // qty 0.6 (>= minQty) * price 1 = 0.6 notional, below minNotional 10.
    expect(finalise(new Decimal('0.6'), new Decimal('1'), f)).toEqual({ skip: 'min-notional' });
  });
});
