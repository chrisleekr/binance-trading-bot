// Binance tradability is AND-of-ORs over `permissionSets`: the account must
// hold at least one tag from EVERY published set. Getting this backwards either
// admits a symbol that is refused on every order forever, or hides tradable
// pairs from an operator who can trade them.

import { describe, expect, it } from 'vitest';

import {
  isSymbolPermittedForAccount,
  parseAccountPermissions,
  projectPermissionSets,
} from '../src/symbols.js';

describe('isSymbolPermittedForAccount', () => {
  it('permits when the account holds a tag from every published set', () => {
    expect(
      isSymbolPermittedForAccount({
        permissionSets: [
          ['SPOT', 'TRD_GRP_025'],
          ['MARGIN', 'TRD_GRP_025'],
        ],
        accountPermissions: ['TRD_GRP_025'],
      }),
    ).toBe(true);
  });

  it('refuses when one published set has no overlap with the account', () => {
    // The live defect: a tokenized equity publishes SPOT/TRD_GRP_005..261 while
    // the account carries only LEVERAGED/TRD_GRP_025, so the intersection is
    // empty and the refusal is permanent, not transient.
    expect(
      isSymbolPermittedForAccount({
        permissionSets: [['SPOT', 'MARGIN', 'TRD_GRP_005', 'TRD_GRP_261']],
        accountPermissions: ['LEVERAGED', 'TRD_GRP_025'],
      }),
    ).toBe(false);
  });

  it('refuses on a partial match across sets, not just a total miss', () => {
    expect(
      isSymbolPermittedForAccount({
        permissionSets: [['SPOT'], ['TRD_GRP_005']],
        accountPermissions: ['SPOT'],
      }),
    ).toBe(false);
  });

  it('fails open on an unknown signal at either end', () => {
    // An unreadable cache is "unknown", never "forbidden". Both directions must
    // permit, or a cold Redis silently halts every profile on the account.
    const sets = [['SPOT']];
    expect(isSymbolPermittedForAccount({ permissionSets: null, accountPermissions: ['X'] })).toBe(
      true,
    );
    expect(isSymbolPermittedForAccount({ permissionSets: [], accountPermissions: ['X'] })).toBe(
      true,
    );
    expect(isSymbolPermittedForAccount({ permissionSets: sets, accountPermissions: null })).toBe(
      true,
    );
    expect(isSymbolPermittedForAccount({ permissionSets: sets, accountPermissions: [] })).toBe(
      true,
    );
    expect(isSymbolPermittedForAccount({})).toBe(true);
  });
});

describe('projectPermissionSets', () => {
  it('accepts a well-formed nested array', () => {
    expect(projectPermissionSets([['SPOT', 'MARGIN']])).toEqual([['SPOT', 'MARGIN']]);
  });

  it('returns null for anything else, so the caller omits the key entirely', () => {
    // An empty array would read as "no sets published" (permitted); null lets
    // the projection drop the field and keep absent and malformed identical.
    expect(projectPermissionSets(undefined)).toBeNull();
    expect(projectPermissionSets([])).toBeNull();
    expect(projectPermissionSets([[]])).toBeNull();
    expect(projectPermissionSets(['SPOT'])).toBeNull();
    expect(projectPermissionSets([[1]])).toBeNull();
  });
});

describe('parseAccountPermissions', () => {
  it('reads the cached JSON list', () => {
    expect(parseAccountPermissions('["SPOT","TRD_GRP_025"]')).toEqual(['SPOT', 'TRD_GRP_025']);
  });

  it('yields an empty list for every unreadable form', () => {
    expect(parseAccountPermissions(null)).toEqual([]);
    expect(parseAccountPermissions('not json')).toEqual([]);
    expect(parseAccountPermissions('{"a":1}')).toEqual([]);
  });

  it('treats a partially-typed list as unusable, so it fails open instead of refusing', () => {
    expect(parseAccountPermissions('["SPOT",1,"",null,"MARGIN"]')).toEqual([]);
  });
});
