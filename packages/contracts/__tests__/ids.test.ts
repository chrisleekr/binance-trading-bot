import { describe, it, expect, expectTypeOf } from 'vitest';
import { asProfileId, asUserId, unwrapId, type ProfileId, type UserId } from '../src/ids.js';

describe('@app/contracts/ids', () => {
  it('passes the underlying string through unchanged at runtime', () => {
    const raw = '00000000-0000-0000-0000-000000000001';
    expect(asUserId(raw)).toBe(raw);
    expect(asProfileId(raw)).toBe(raw);
  });

  it('is structurally distinct at the type level', () => {
    expectTypeOf<UserId>().not.toEqualTypeOf<ProfileId>();
  });

  it('unwrapId is the inverse of the as*Id constructors — round-trips the raw string', () => {
    const raw = '00000000-0000-4000-8000-00000000a001';
    expect(unwrapId(asUserId(raw))).toBe(raw);
    expect(unwrapId(asProfileId(raw))).toBe(raw);
  });

  it('unwrapId returns a plain string, accepting any branded id but not a raw string', () => {
    expectTypeOf(unwrapId(asUserId('x'))).toEqualTypeOf<string>();
    // A raw string is rejected at the type level — unwrapId only strips brands.
    // @ts-expect-error a plain string is not a branded id
    unwrapId('not-a-branded-id');
  });
});
