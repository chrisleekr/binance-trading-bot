import { asAccountId, asProfileId, DiscoveryConfigSchema } from '@app/contracts';
import { describe, expect, it } from 'vitest';
import {
  accountPermissionsKey,
  auditStreamKey,
  createBullMQConnection,
  dashboardAggregateCacheKey,
  DISCOVERY_ASSET_POLICY_ABORT_TTL_S,
  EVENTS_CHANNEL_PATTERN,
  eventsChannelKey,
  eventsSeqKey,
  eventsStreamKey,
  GLOBAL_KEYS,
  openOrdersKey,
  PROFILE_KEYS,
  profileKey,
  profilePrefix,
  type GlobalScope,
  type ProfileKeyParts,
  type RedisProfileScope,
} from '../src/redis.js';

describe('createBullMQConnection', () => {
  it('parses credentials, port, and database without exposing ioredis types', () => {
    expect(
      createBullMQConnection({
        url: 'redis://worker:p%40ss%2Fword@redis.internal:6380/4',
      }),
    ).toEqual({
      host: 'redis.internal',
      port: 6380,
      username: 'worker',
      password: 'p@ss/word',
      db: 4,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  });
});

const aliceScope: RedisProfileScope = {
  kind: 'profile',
  accountId: asAccountId('00000000-0000-0000-0000-0000000a0001'),
  profileId: asProfileId('00000000-0000-0000-0000-0000000a1001'),
};

const _globalScope: GlobalScope = { kind: 'global' };
void _globalScope;

describe('PROFILE_KEYS catalogue', () => {
  it('produces the v1 suffix shape (no tenant prefix)', () => {
    expect(PROFILE_KEYS.configurations('BTCUSDT')).toBe('configurations:BTCUSDT');
    expect(PROFILE_KEYS.configurations('global')).toBe('configurations:global');
    expect(PROFILE_KEYS.override('global')).toBe('override:global');
    expect(PROFILE_KEYS.disableAction('BTCUSDT')).toBe('disable-action:BTCUSDT');
    expect(PROFILE_KEYS.accountInfo()).toBe('account-info');
    expect(PROFILE_KEYS.exchangeInfo()).toBe('exchange-info');
    expect(PROFILE_KEYS.exchangeSymbols()).toBe('exchange-symbols');
    expect(PROFILE_KEYS.killSwitch()).toBe('kill-switch');
    expect(PROFILE_KEYS.orderRefusal('BTCUSDT')).toBe('order-refusal:BTCUSDT');
    expect(PROFILE_KEYS.dashboardCache()).toBe('dashboard:cache');
    expect(PROFILE_KEYS.dustEligible()).toBe('dust-eligible');
    expect(PROFILE_KEYS.userStreamEvent()).toBe('user-stream:last-event');
    expect(PROFILE_KEYS.binanceWeight(29_142_001)).toBe('binance:weight:29142001');
  });
});

describe('profileKey / profilePrefix composition', () => {
  it('prepends the tenant prefix to the catalogue suffix', () => {
    const prefix =
      'tenant:00000000-0000-0000-0000-0000000a0001:profile:00000000-0000-0000-0000-0000000a1001:';
    expect(profilePrefix(aliceScope)).toBe(prefix);
    expect(profileKey(aliceScope, 'disableAction', 'BTCUSDT')).toBe(
      `${prefix}disable-action:BTCUSDT`,
    );
    expect(profileKey(aliceScope, 'killSwitch')).toBe(`${prefix}kill-switch`);
    expect(profileKey(aliceScope, 'orderRefusal', 'BTCUSDT')).toBe(
      `${prefix}order-refusal:BTCUSDT`,
    );
    expect(profileKey(aliceScope, 'dashboardCache')).toBe(`${prefix}dashboard:cache`);
    expect(profileKey(aliceScope, 'dustEligible')).toBe(`${prefix}dust-eligible`);
    expect(profileKey(aliceScope, 'userStreamEvent')).toBe(`${prefix}user-stream:last-event`);
    expect(profileKey(aliceScope, 'binanceWeight', 29_142_001)).toBe(
      `${prefix}binance:weight:29142001`,
    );
  });

  it('accepts a bare ProfileKeyParts literal, not only a kind-tagged RedisProfileScope', () => {
    // No `kind` field — pins the structural-subset contract at compile time,
    // matching the per-row `{accountId, profileId}` callsite in profile-aggregate.
    const parts: ProfileKeyParts = {
      accountId: asAccountId('00000000-0000-0000-0000-0000000a0001'),
      profileId: asProfileId('00000000-0000-0000-0000-0000000a1001'),
    };
    expect(profileKey(parts, 'accountInfo')).toBe(profileKey(aliceScope, 'accountInfo'));
  });
});

describe('GLOBAL_KEYS catalogue', () => {
  it('produces market-data global keys without any tenant prefix', () => {
    expect(GLOBAL_KEYS.technicals('BTCUSDT', '1h')).toBe('technicals:BTCUSDT:1h');
    expect(GLOBAL_KEYS.ticker('BTCUSDT')).toBe('ticker:BTCUSDT');
    expect(GLOBAL_KEYS.symbolInfo('BTCUSDT', 'live')).toBe('binance:symbol-info:BTCUSDT');
  });

  it('namespaces symbol-info by Binance mode with disjoint cleanup globs', () => {
    // `live` (the default) is the canonical key every live consumer reads; `test`
    // is a separate keyspace so testnet's coarser tickSize / lot filters never
    // overwrite production's. The `-test` before the `:` keeps the two SCAN globs
    // (`binance:symbol-info:*` vs `binance:symbol-info-test:*`) from matching each
    // other, so a per-mode stale-key sweep cannot delete the other mode's keys.
    expect(GLOBAL_KEYS.symbolInfo('BTCUSDT', 'live')).toBe('binance:symbol-info:BTCUSDT');
    expect(GLOBAL_KEYS.symbolInfo('BTCUSDT', 'test')).toBe('binance:symbol-info-test:BTCUSDT');
    expect(GLOBAL_KEYS.symbolInfo('*', 'live').startsWith('binance:symbol-info:')).toBe(true);
    expect(GLOBAL_KEYS.symbolInfo('*', 'test').startsWith('binance:symbol-info:')).toBe(false);
  });

  it('builds the discovery-cron keys the cron (writer) and the api/tick (readers) share', () => {
    const pid = '00000000-0000-0000-0000-0000000a1001';
    expect(GLOBAL_KEYS.discoveryLastRun(pid)).toBe(`discovery:lastrun:${pid}`);
    expect(GLOBAL_KEYS.discoveryAdded(pid)).toBe(`discovery:added:${pid}`);
    expect(GLOBAL_KEYS.discoveryFlat(pid)).toBe(`discovery:flat:${pid}`);
    expect(GLOBAL_KEYS.discoveryExplain(pid)).toBe(`discovery:explain:${pid}`);
    expect(GLOBAL_KEYS.discoveryEnterOnAdd(pid)).toBe(`discovery:enter-on-add:${pid}`);
    expect(GLOBAL_KEYS.discoveryAssetPolicyAbort(pid)).toBe(`discovery:asset-policy-abort:${pid}`);
  });

  it('keeps the asset-policy abort record alive past the longest legal gap between cycles', () => {
    // The record is cleared by the next cycle that completes, and nothing else retires it. A TTL shorter than the maximum a profile may set its refresh period to would let the finding vanish on its own while the refusal is still in force — the profile would go back to reading as merely stale, which is the exact silence this record exists to end. Derived from the schema's own bound so raising that bound fails here instead of quietly re-opening the gap.
    const maxRefreshPeriodMs = DiscoveryConfigSchema.parse({
      refreshPeriodMs: 86_400_000,
    }).refreshPeriodMs;
    expect(DISCOVERY_ASSET_POLICY_ABORT_TTL_S * 1_000).toBeGreaterThan(maxRefreshPeriodMs);
    expect(() =>
      DiscoveryConfigSchema.parse({ refreshPeriodMs: maxRefreshPeriodMs + 1 }),
    ).toThrow();
  });
});

describe('events / audit stream keys (cross-process worker↔api contract)', () => {
  const a = asAccountId('00000000-0000-0000-0000-0000000a0001');
  const p = asProfileId('00000000-0000-0000-0000-0000000a1001');

  it('pins the byte-exact grammar both processes depend on', () => {
    expect(eventsChannelKey(a, p)).toBe(
      'events:00000000-0000-0000-0000-0000000a0001:00000000-0000-0000-0000-0000000a1001',
    );
    expect(eventsStreamKey(a, p)).toBe(`${eventsChannelKey(a, p)}:stream`);
    expect(eventsSeqKey(a, p)).toBe(`${eventsChannelKey(a, p)}:seq`);
    expect(auditStreamKey(a, p)).toBe(
      'audit:00000000-0000-0000-0000-0000000a0001:00000000-0000-0000-0000-0000000a1001:stream',
    );
  });

  it('the PSUBSCRIBE pattern matches the per-profile channel prefix', () => {
    expect(EVENTS_CHANNEL_PATTERN).toBe('events:*:*');
    // The api PSUBSCRIBEs the pattern; the worker PUBLISHes the channel. Pin
    // that the channel's literal prefix is the pattern's prefix so they cannot
    // drift independently.
    const wildcard = EVENTS_CHANNEL_PATTERN.indexOf('*');
    expect(wildcard).toBeGreaterThan(0);
    const patternPrefix = EVENTS_CHANNEL_PATTERN.slice(0, wildcard);
    expect(eventsChannelKey(a, p).startsWith(patternPrefix)).toBe(true);
  });

  it('dashboardAggregateCacheKey is account-scoped without a profile segment', () => {
    expect(dashboardAggregateCacheKey(a)).toBe(
      'tenant:00000000-0000-0000-0000-0000000a0001:dashboard-aggregate:cache',
    );
  });

  it('openOrdersKey is account-scoped (no profile segment): one order book per account', () => {
    expect(openOrdersKey(asAccountId('00000000-0000-0000-0000-0000000a0001'), 'BTCUSDT')).toBe(
      'tenant:00000000-0000-0000-0000-0000000a0001:open-orders:BTCUSDT',
    );
  });

  it('accountPermissionsKey is account-scoped (no profile segment): permissions belong to the key pair', () => {
    expect(accountPermissionsKey(asAccountId('00000000-0000-0000-0000-0000000a0001'))).toBe(
      'tenant:00000000-0000-0000-0000-0000000a0001:account-permissions',
    );
  });
});

describe('scope construction', () => {
  it('a RedisProfileScope carries accountId and profileId verbatim', () => {
    expect(aliceScope.kind).toBe('profile');
    expect(aliceScope.accountId).toBe('00000000-0000-0000-0000-0000000a0001');
    expect(aliceScope.profileId).toBe('00000000-0000-0000-0000-0000000a1001');
  });
});
