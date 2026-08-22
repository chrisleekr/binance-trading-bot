import { describe, expect, it } from 'vitest';
import { asAccountId, asProfileId } from '@app/contracts';
import {
  buildAccountInfoKey,
  buildDisableActionKey,
  buildDustEligibleKey,
  buildKillSwitchKey,
  buildOpenOrdersKey,
  buildOrderRefusalKey,
  buildProfileTickMetaKey,
  buildSymbolInfoKey,
  buildSymbolStateKey,
  buildUserStreamEventKey,
  buildWeightKey,
} from '../../src/executor/redis-namespace.js';

describe('catalogued profile key builders', () => {
  // These builders are thin wrappers over `@app/db`'s `profileKey`; the
  // assertions pin the worker-side bytes so a catalogue suffix change cannot
  // silently desync the worker writer from the projection / API reader.
  const accountId = asAccountId('user-1');
  const profileId = asProfileId('profile-1');
  const prefix = 'tenant:user-1:profile:profile-1:';

  it('produce the tenant-prefixed key for each catalogue entry', () => {
    expect(buildKillSwitchKey(accountId, profileId)).toBe(`${prefix}kill-switch`);
    expect(buildSymbolStateKey(accountId, profileId, 'BTCUSDT')).toBe(
      `${prefix}symbol-state:BTCUSDT`,
    );
    expect(buildOrderRefusalKey(accountId, profileId, 'BTCUSDT')).toBe(
      `${prefix}order-refusal:BTCUSDT`,
    );
    expect(buildProfileTickMetaKey(accountId, profileId)).toBe(`${prefix}profile-tick-meta`);
    expect(buildAccountInfoKey(accountId, profileId)).toBe(`${prefix}account-info`);
    expect(buildDustEligibleKey(accountId, profileId)).toBe(`${prefix}dust-eligible`);
    expect(buildUserStreamEventKey(accountId, profileId)).toBe(`${prefix}user-stream:last-event`);
    expect(buildWeightKey(accountId, profileId, 29_142_001)).toBe(
      `${prefix}binance:weight:29142001`,
    );
  });
});

describe('buildOpenOrdersKey (account-domain, no profile segment)', () => {
  // Issue #649 C1/E4: the open-orders snapshot is an ACCOUNT fact (one order
  // book per Binance key pair), not a per-profile fact. The key drops the
  // `profile:<pid>:` segment so every profile under an account shares one
  // WS-merged snapshot and cold-loads once, not P times.
  //
  // RED until Phase B: today's builder still takes `(accountId, profileId,
  // symbol)` and emits the profile-prefixed key, so this fails tsc (2-arg call
  // against the 3-arg signature) AND fails the value assertion at runtime
  // (esbuild strips types, so vitest still runs it). Both flip green once
  // Phase B drops the profileId parameter.
  it('produces tenant:<account>:open-orders:<symbol> with no profile segment', () => {
    expect(buildOpenOrdersKey(asAccountId('acct-1'), 'BTCUSDT')).toBe(
      'tenant:acct-1:open-orders:BTCUSDT',
    );
  });
});

describe('buildDisableActionKey (per-symbol pause, issue #658)', () => {
  // The per-coin "Pause" writes `disable-action:<symbol>` under the profile
  // tenant prefix. Mirrors the buildKillSwitchKey shape assertion so the worker
  // writer/reader byte-agree with the API/projection layer.
  it('produces tenant:<account>:profile:<profile>:disable-action:<symbol>', () => {
    expect(buildDisableActionKey(asAccountId('user-1'), asProfileId('profile-1'), 'BTCUSDT')).toBe(
      'tenant:user-1:profile:profile-1:disable-action:BTCUSDT',
    );
  });
});

describe('buildSymbolInfoKey (mode-namespaced)', () => {
  it('keeps the canonical live key and namespaces test separately', () => {
    // Live is the byte-exact `@app/db` catalogue key the API also reads. `mode`
    // is required — a default would silently read production filters for a
    // testnet account, so every caller names its environment.
    expect(buildSymbolInfoKey('BTCUSDT', 'live')).toBe('binance:symbol-info:BTCUSDT');
    expect(buildSymbolInfoKey('BTCUSDT', 'test')).toBe('binance:symbol-info-test:BTCUSDT');
  });

  it("test keys fall outside the live glob so each mode's cleanup cannot delete the other's", () => {
    // The live stale-key cleanup scans `binance:symbol-info:*`; a Redis glob
    // requires the literal `:` after `symbol-info`, which the `-test` keyspace
    // lacks — so it is not matched (and not wiped) by the live refresh.
    const liveGlobPrefix = buildSymbolInfoKey('', 'live'); // 'binance:symbol-info:'
    expect(buildSymbolInfoKey('BTCUSDT', 'test').startsWith(liveGlobPrefix)).toBe(false);
  });
});
