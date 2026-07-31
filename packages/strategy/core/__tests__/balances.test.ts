// The wallet snapshot answers three different questions and collapsing them to a
// single number is how a stop-loss gets suppressed. An EMPTY balance map means
// the snapshot could not be read (a cold or malformed `account-info` degrades to
// `{}`); an asset ABSENT from a POPULATED map is Binance stating we hold none of
// it. Sizing must be able to tell ignorance from a hard zero: fail open on the
// first, fail closed on the second.

import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { AccountSnapshot, Balance } from '../src/index.js';

import { accountEquity, decOrNull, freeBalance, sizableBase } from '../src/balances.js';

const bal = (asset: string, free: string, locked = '0'): Balance => ({
  asset,
  free: new Decimal(free),
  locked: new Decimal(locked),
});

const readable = (balances: Record<string, Balance>): AccountSnapshot => ({
  balances,
  readable: true,
});

describe('freeBalance', () => {
  it('returns the free quantity when the asset line is present', () => {
    expect(freeBalance(readable({ BTC: bal('BTC', '1.5', '0.5') }), 'BTC')?.toFixed()).toBe('1.5');
  });

  it('returns a present-but-zero line as a KNOWN zero, not unknown', () => {
    // Every coin locked into a resting SELL. `free` is genuinely 0, so the caller
    // must cap on it (plus what it can reclaim) rather than fail open.
    const free = freeBalance(readable({ BTC: bal('BTC', '0', '2') }), 'BTC');
    expect(free).toBeInstanceOf(Decimal);
    expect(free?.toFixed()).toBe('0');
  });

  it('returns a KNOWN zero for an asset absent from a POPULATED map', () => {
    // Binance omits assets the account holds none of, so an absent line in a
    // snapshot we DID read is proof of zero. Failing open here would market-sell
    // a phantom position and collect a -2010 rejection every tick.
    expect(freeBalance(readable({ USDT: bal('USDT', '100') }), 'BTC')?.toFixed()).toBe('0');
  });

  it('returns undefined for any asset when the snapshot is unreadable', () => {
    // Not "the wallet is empty" — "we could not read the wallet". The caller
    // sizes from its tracked position instead of refusing to protect it.
    expect(freeBalance({ balances: {}, readable: false }, 'BTC')).toBeUndefined();
    expect(freeBalance({ balances: {}, readable: false }, 'USDT')).toBeUndefined();
  });
});

describe('sizableBase — credits our own resting stop only where the wallet corroborates it', () => {
  const two = new Decimal('2');

  it('credits the full ownLocked when the wallet locks at least that much', () => {
    // A genuinely-resting own stop: its base sits in `locked`, so wallet.locked >=
    // ownLocked and the credit is unchanged.
    const out = sizableBase(readable({ BTC: bal('BTC', '0', '2') }), 'BTC', two);
    expect(out.free?.toFixed()).toBe('0');
    expect(out.reclaimable.toFixed()).toBe('2');
  });

  it('credits NOTHING when a present line reads free:0 locked:0 (a filled stop)', () => {
    // getAccount includes zero balances, so a sold-out asset is a PRESENT line
    // with zero locked. A stale openOrders still listing the filled stop supplies
    // ownLocked=2; crediting it would sell coins that are gone. The wallet wins.
    const out = sizableBase(readable({ BTC: bal('BTC', '0', '0') }), 'BTC', two);
    expect(out.free?.toFixed()).toBe('0');
    expect(out.reclaimable.toFixed()).toBe('0');
  });

  it('caps the credit at the wallet locked when it is less than ownLocked', () => {
    const out = sizableBase(readable({ BTC: bal('BTC', '0', '1') }), 'BTC', two);
    expect(out.reclaimable.toFixed()).toBe('1');
  });

  it('credits nothing for a base absent from a POPULATED map (known zero)', () => {
    const out = sizableBase(readable({ USDT: bal('USDT', '100') }), 'BTC', two);
    expect(out.free?.toFixed()).toBe('0');
    expect(out.reclaimable.toFixed()).toBe('0');
  });

  it('leaves free undefined and credits nothing when the snapshot is unreadable', () => {
    const out = sizableBase({ balances: {}, readable: false }, 'BTC', two);
    expect(out.free).toBeUndefined();
    expect(out.reclaimable.toFixed()).toBe('0');
  });
});

// Unreadability is an EXPLICIT `readable` flag on the AccountSnapshot, never
// inferred from an empty map. An empty map with `readable: true` is a
// genuinely-empty wallet we DID read, so it is a KNOWN zero; only
// `readable: false` is UNKNOWN.
describe('freeBalance — readable flag distinguishes known-zero from unreadable', () => {
  it('returns a KNOWN zero for a readable but empty wallet', () => {
    const free = freeBalance({ balances: {}, readable: true }, 'BTC');
    expect(free).toBeInstanceOf(Decimal);
    expect(free?.toFixed()).toBe('0');
  });

  it('returns undefined for an unreadable wallet even when balances is empty', () => {
    expect(freeBalance({ balances: {}, readable: false }, 'BTC')).toBeUndefined();
  });
});

describe('sizableBase — readable flag distinguishes known-zero from unreadable', () => {
  const two = new Decimal('2');

  it('credits nothing and reports free 0 for a readable but empty wallet', () => {
    const out = sizableBase({ balances: {}, readable: true }, 'BTC', two);
    expect(out.free).toBeInstanceOf(Decimal);
    expect(out.free?.toFixed()).toBe('0');
    expect(out.reclaimable.toFixed()).toBe('0');
  });

  it('leaves free undefined for an unreadable wallet even when balances is empty', () => {
    const out = sizableBase({ balances: {}, readable: false }, 'BTC', two);
    expect(out.free).toBeUndefined();
    expect(out.reclaimable.toFixed()).toBe('0');
  });
});

describe('decOrNull', () => {
  it('rejects a non-string / non-number to null', () => {
    expect(decOrNull(undefined)).toBeNull();
    expect(decOrNull(null)).toBeNull();
    expect(decOrNull({})).toBeNull();
    expect(decOrNull(true)).toBeNull();
  });

  it('rejects the empty string to null', () => {
    expect(decOrNull('')).toBeNull();
  });

  it('rejects a malformed string to null (Decimal ctor throws → catch)', () => {
    expect(decOrNull('abc')).toBeNull();
  });

  it('rejects a parseable-but-non-finite value to null (the isFinite guard)', () => {
    // Guards sizing math from Infinity leaking through the ctor.
    expect(decOrNull('Infinity')).toBeNull();
  });

  it('parses a valid decimal-string to a Decimal', () => {
    expect(decOrNull('12.5')?.toString()).toBe('12.5');
  });

  it('parses a valid number to a Decimal', () => {
    expect(decOrNull(42)?.toString()).toBe('42');
  });
});

// accountEquity is the quote-equity read shared by both strategy plugins: free +
// locked quote cash plus the worker-scoped deployed cost-basis. The cash ctor is
// defensive so a wire-string balance (the momentum plugin used to throw on it) or
// a malformed leg degrades to zero rather than throwing inside a pure tick().
describe('accountEquity', () => {
  // Balances reach the helper as Decimals (the worker's revived boundary) or as
  // decimal-strings (the wire format some callers/tests pass); cover both.
  const balDec = (free: string, locked = '0') => ({
    asset: 'USDT',
    free: new Decimal(free),
    locked: new Decimal(locked),
  });
  const balStr = (free: string, locked = '0') => ({ asset: 'USDT', free, locked });

  it('sums free + locked cash and the deployed cost-basis (Decimal balances)', () => {
    expect(
      accountEquity(
        {
          balances: { USDT: balDec('600', '100') },
          readable: true,
          deployedQuoteAcrossProfiles: '300',
        } as AccountSnapshot,
        'USDT',
      ).toString(),
    ).toBe('1000');
  });

  it('coerces a wire-string balance rather than throwing', () => {
    expect(
      accountEquity(
        {
          balances: { USDT: balStr('600', '100') },
          readable: true,
          deployedQuoteAcrossProfiles: '300',
        } as unknown as AccountSnapshot,
        'USDT',
      ).toString(),
    ).toBe('1000');
  });

  it('treats an absent balance as zero cash', () => {
    expect(
      accountEquity({ balances: {}, readable: true } as AccountSnapshot, 'USDT').toString(),
    ).toBe('0');
    expect(
      accountEquity(
        { balances: { USDT: balDec('50') }, readable: true } as AccountSnapshot,
        'USDT',
      ).toString(),
    ).toBe('50');
  });

  it('degrades a malformed free/locked to zero cash (ctor throws → catch)', () => {
    expect(
      accountEquity(
        {
          balances: { USDT: balStr('not-a-number') },
          readable: true,
          deployedQuoteAcrossProfiles: '300',
        } as unknown as AccountSnapshot,
        'USDT',
      ).toString(),
    ).toBe('300');
  });

  it('adds a present deployed total and treats an absent one as zero', () => {
    expect(
      accountEquity(
        {
          balances: { USDT: balDec('40') },
          readable: true,
          deployedQuoteAcrossProfiles: '10',
        } as AccountSnapshot,
        'USDT',
      ).toString(),
    ).toBe('50');
    expect(
      accountEquity(
        { balances: { USDT: balDec('40') }, readable: true } as AccountSnapshot,
        'USDT',
      ).toString(),
    ).toBe('40');
  });

  it('treats a malformed or non-finite deployed total as zero', () => {
    expect(
      accountEquity(
        {
          balances: { USDT: balDec('40') },
          readable: true,
          deployedQuoteAcrossProfiles: 'oops',
        } as unknown as AccountSnapshot,
        'USDT',
      ).toString(),
    ).toBe('40');
    expect(
      accountEquity(
        {
          balances: { USDT: balDec('40') },
          readable: true,
          deployedQuoteAcrossProfiles: 'Infinity',
        } as unknown as AccountSnapshot,
        'USDT',
      ).toString(),
    ).toBe('40');
  });
});
