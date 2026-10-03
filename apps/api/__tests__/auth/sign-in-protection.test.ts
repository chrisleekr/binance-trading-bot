import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { normalizeEmail } from '../../src/auth/sign-in-protection.js';
import type { SecurityServices } from '../../src/auth/security.js';

import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const attempt = (ipAddress: string, knownDevice = false) => ({
  ipAddress,
  userAgent: 'vitest',
  knownDevice,
});

describe('normalizeEmail', () => {
  it('folds case, surrounding space and compatibility look-alikes onto one address', () => {
    expect(normalizeEmail('  Operator@Example.TEST ')).toBe('operator@example.test');
    // Full-width capital O (U+FF2F) folds to a plain o under NFKC.
    expect(normalizeEmail('Ｏperator@example.test')).toBe('operator@example.test');
  });
});

// Every assertion below uses the default settings (see `DEFAULT_AUTH_SECURITY_SETTINGS`): 3 attempts per address per 5 minutes, a 15-minute first block, 5 attempts per email per 5 minutes, lockout on the 5th failure, site-wide backoff on the 20th failure, 20 other auth requests per address per minute.
describeIfInfra('sign-in protection against real Redis', () => {
  let fx: ApiFixture;
  let security: SecurityServices;
  let redis: Redis;

  const securityEvents = async (
    event: string,
  ): Promise<{ ip: string | null; payload: Record<string, unknown> }[]> =>
    (
      await fx.di.pool.query<{ ip: string | null; payload: Record<string, unknown> }>(
        `select ip, payload from audit_logs where category = 'security' and event = $1 order by created_at`,
        [event],
      )
    ).rows;

  beforeAll(async () => {
    fx = await setupApp({ realLimiter: true });
    security = fx.di.security;
    redis = new Redis(fx.redisUrl);
  });
  beforeEach(async () => {
    await redis.flushdb();
    await fx.di.pool.query(`delete from audit_logs where category = 'security'`);
  });
  afterAll(async () => {
    await redis.quit();
    await fx.cleanup();
  });

  it('refuses the 4th attempt from one address, blocks it, and records the block once', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect(
        await security.protection.checkPasswordAttempt(
          attempt('198.51.100.1'),
          `p${i}@example.test`,
        ),
      ).toBeNull();
    }
    const tripped = await security.protection.checkPasswordAttempt(
      attempt('198.51.100.1'),
      'p3@example.test',
    );
    expect(tripped).toMatchObject({
      limit: 'sign_in_ip_address',
      reason: 'ip_address',
      retryAfterMs: 900_000,
    });
    const whileBlocked = await security.protection.checkPasswordAttempt(
      attempt('198.51.100.1'),
      'p4@example.test',
    );
    expect(whileBlocked?.limit).toBe('sign_in_ip_address_block');
    expect(whileBlocked?.retryAfterMs).toBeGreaterThan(890_000);
    const rows = await securityEvents('ip-address-blocked');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ip).toBe('198.51.100.1');
    // Another address is unaffected.
    expect(
      await security.protection.checkPasswordAttempt(attempt('198.51.100.2'), 'p5@example.test'),
    ).toBeNull();
  });

  it('doubles the block on a repeat trip within a day, capped at the maximum', async () => {
    const trip = async (): Promise<number | undefined> => {
      await redis.del('auth:gcra:sign-in:ip:v4:198.51.100.3', 'auth:block:ip:v4:198.51.100.3');
      let refusal = null;
      for (let i = 0; i < 4 && refusal === null; i += 1) {
        refusal = await security.protection.checkPasswordAttempt(
          attempt('198.51.100.3'),
          `e${i}-${Math.random()}@example.test`,
        );
      }
      return refusal?.retryAfterMs;
    };
    expect(await trip()).toBe(900_000);
    expect(await trip()).toBe(1_800_000);
    // The stored block carries the doubled length, not just the reported one.
    expect(await redis.pttl('auth:block:ip:v4:198.51.100.3')).toBeGreaterThan(1_790_000);
    await redis.set('auth:block:trips:v4:198.51.100.3', '30', 'PX', 60_000);
    expect(await trip()).toBe(86_400_000);
  });

  it('groups an IPv6 /64 into one allowance and maps IPv4-mapped IPv6 onto the IPv4 address', async () => {
    for (let i = 1; i <= 3; i += 1) {
      expect(
        await security.protection.checkPasswordAttempt(
          attempt(`2001:db8:1:2::${i}`),
          `v6-${i}@example.test`,
        ),
      ).toBeNull();
    }
    expect(
      (
        await security.protection.checkPasswordAttempt(
          attempt('2001:db8:1:2::ffff'),
          'v6-4@example.test',
        )
      )?.limit,
    ).toBe('sign_in_ip_address');

    for (let i = 1; i <= 3; i += 1) {
      expect(
        await security.protection.checkPasswordAttempt(
          attempt('::ffff:198.51.100.9'),
          `m-${i}@example.test`,
        ),
      ).toBeNull();
    }
    expect(
      (await security.protection.checkPasswordAttempt(attempt('198.51.100.9'), 'm-4@example.test'))
        ?.limit,
    ).toBe('sign_in_ip_address');
  });

  it('concurrent refusals from one address count, record and report the block once', async () => {
    for (let i = 0; i < 3; i += 1)
      await security.protection.checkPasswordAttempt(
        attempt('198.51.100.60'),
        `c${i}@example.test`,
      );
    const refusals = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        security.protection.checkPasswordAttempt(attempt('198.51.100.60'), `r${i}@example.test`),
      ),
    );
    const limits = refusals.map((refusal) => refusal?.limit).sort();
    expect(limits.filter((limit) => limit === 'sign_in_ip_address')).toHaveLength(1);
    expect(limits.filter((limit) => limit === 'sign_in_ip_address_block')).toHaveLength(4);
    for (const refusal of refusals) {
      expect(refusal?.retryAfterMs).toBeGreaterThan(890_000);
      expect(refusal?.retryAfterMs).toBeLessThanOrEqual(900_000);
    }
    expect(await securityEvents('ip-address-blocked')).toHaveLength(1);
    expect(await redis.get('auth:block:trips:v4:198.51.100.60')).toBe('1');
  });

  it('locks an email on exactly the 5th failure, for an address that does not exist too, and case variants share the lock', async () => {
    for (let i = 0; i < 4; i += 1)
      await security.protection.recordPasswordFailure(
        attempt(`203.0.113.${i + 1}`),
        'nobody@example.test',
      );
    expect(await securityEvents('account-locked')).toHaveLength(0);
    expect(
      await security.protection.checkPasswordAttempt(
        attempt('203.0.113.49'),
        'nobody@example.test',
      ),
    ).toBeNull();
    await security.protection.recordPasswordFailure(attempt('203.0.113.5'), 'nobody@example.test');
    expect(await securityEvents('account-locked')).toHaveLength(1);
    const refusal = await security.protection.checkPasswordAttempt(
      attempt('203.0.113.50'),
      ' NOBODY@Example.test',
    );
    expect(refusal).toMatchObject({ limit: 'account_lockout', reason: 'locked' });
    expect(refusal?.retryAfterMs).toBeGreaterThan(3_590_000);
    // Redis holds only keyed digests, never the address itself.
    expect((await redis.keys('*nobody*')).length).toBe(0);
  });

  it('a known device is exempt from the email lockout but not from the per-address allowance', async () => {
    for (let i = 0; i < 5; i += 1)
      await security.protection.recordPasswordFailure(
        attempt(`203.0.113.${i + 1}`),
        'operator@example.test',
      );
    expect(
      await security.protection.checkPasswordAttempt(
        attempt('192.0.2.7', true),
        'operator@example.test',
      ),
    ).toBeNull();
    expect(
      (
        await security.protection.checkPasswordAttempt(
          attempt('192.0.2.8'),
          'operator@example.test',
        )
      )?.limit,
    ).toBe('account_lockout');
    await security.protection.checkPasswordAttempt(
      attempt('192.0.2.7', true),
      'operator@example.test',
    );
    await security.protection.checkPasswordAttempt(
      attempt('192.0.2.7', true),
      'operator@example.test',
    );
    expect(
      (
        await security.protection.checkPasswordAttempt(
          attempt('192.0.2.7', true),
          'operator@example.test',
        )
      )?.limit,
    ).toBe('sign_in_ip_address');
  });

  it('strangers exhausting the email allowance leave the known device its own', async () => {
    for (let i = 0; i < 5; i += 1)
      expect(
        await security.protection.checkPasswordAttempt(
          attempt(`203.0.113.${i + 1}`),
          'operator@example.test',
        ),
      ).toBeNull();
    expect(
      (
        await security.protection.checkPasswordAttempt(
          attempt('203.0.113.6'),
          'operator@example.test',
        )
      )?.limit,
    ).toBe('sign_in_email');
    expect(
      await security.protection.checkPasswordAttempt(
        attempt('192.0.2.9', true),
        'operator@example.test',
      ),
    ).toBeNull();
  });

  it('starts a site-wide backoff on exactly the 20th failure, limiting unknown devices to one attempt per period', async () => {
    for (let i = 0; i < 19; i += 1)
      await security.protection.recordPasswordFailure(
        attempt(`203.0.113.${i + 1}`),
        `site-${i}@example.test`,
      );
    expect(await redis.exists('auth:backoff:site')).toBe(0);
    await security.protection.recordPasswordFailure(
      attempt('203.0.113.20'),
      'site-19@example.test',
    );
    expect(await securityEvents('site-wide-backoff-started')).toHaveLength(1);
    expect(
      await security.protection.checkPasswordAttempt(attempt('192.0.2.20'), 'x1@example.test'),
    ).toBeNull();
    expect(
      (await security.protection.checkPasswordAttempt(attempt('192.0.2.20'), 'x2@example.test'))
        ?.limit,
    ).toBe('site_wide_backoff');
    // A known device keeps its normal per-address allowance during the backoff.
    expect(
      await security.protection.checkPasswordAttempt(
        attempt('192.0.2.21', true),
        'x3@example.test',
      ),
    ).toBeNull();
    expect(
      await security.protection.checkPasswordAttempt(
        attempt('192.0.2.21', true),
        'x4@example.test',
      ),
    ).toBeNull();
  });

  it('clearLockout lifts the lockout, both attempt allowances and the site-wide backoff, for the recovery command', async () => {
    for (let i = 0; i < 20; i += 1)
      await security.protection.recordPasswordFailure(
        attempt(`203.0.113.${i + 1}`),
        'operator@example.test',
      );
    for (let i = 0; i < 6; i += 1)
      await security.protection.checkPasswordAttempt(
        attempt(`198.51.100.${i + 70}`, true),
        'operator@example.test',
      );
    expect(await redis.exists('auth:backoff:site')).toBe(1);
    expect((await redis.keys('auth:gcra:sign-in:email:*:known-device')).length).toBe(1);
    await security.protection.clearLockout('Operator@example.test');
    expect(await redis.exists('auth:backoff:site')).toBe(0);
    expect((await redis.keys('auth:gcra:sign-in:email:*')).length).toBe(0);
    expect((await redis.keys('auth:lock:email:*')).length).toBe(0);
    expect(
      await security.protection.checkPasswordAttempt(
        attempt('192.0.2.30'),
        'operator@example.test',
      ),
    ).toBeNull();
  });

  it('clearLockout also lifts every address block and its escalation, since the host cannot know which address the operator was blocked from', async () => {
    // Two addresses, one IPv4 and one IPv6, each blocked twice so the escalation counter is armed. Between the two rounds the blocks and allowances are dropped by hand, as if they had expired, while the trip counters stay.
    const ips = ['198.51.100.90', '2001:db8:1:2::9'];
    for (let round = 0; round < 2; round += 1) {
      if (round === 1)
        await redis.del(
          ...(await redis.keys('auth:block:ip:*')),
          ...(await redis.keys('auth:gcra:sign-in:ip:*')),
        );
      for (const ip of ips)
        for (let i = 0; i < 4; i += 1)
          await security.protection.checkPasswordAttempt(attempt(ip), `b${round}${i}@example.test`);
    }
    expect(await redis.get('auth:block:trips:v4:198.51.100.90')).toBe('2');
    expect((await redis.keys('auth:block:ip:*')).length).toBe(2);
    expect((await redis.keys('auth:block:trips:*')).length).toBe(2);
    await security.protection.clearLockout('operator@example.test');
    expect(await redis.keys('auth:block:*')).toEqual([]);
    expect(await redis.keys('auth:gcra:sign-in:ip:*')).toEqual([]);
    for (const ip of ips)
      expect(
        await security.protection.checkPasswordAttempt(attempt(ip), 'operator@example.test'),
      ).toBeNull();
  });

  it('single sign-on starts are limited site-wide, not per address', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect(
        await security.protection.checkAddressLimit(
          'single_sign_on_starts',
          attempt(`198.51.100.${i + 10}`),
        ),
      ).toBeNull();
    }
    expect(
      (
        await security.protection.checkAddressLimit(
          'single_sign_on_starts',
          attempt('198.51.100.99'),
        )
      )?.limit,
    ).toBe('single_sign_on_starts');
    expect(await securityEvents('rate-limited')).toHaveLength(1);
  });

  it('an agent token request is limited per client id and per address, so rotating the client id gains nothing', async () => {
    // Default: 20 other auth requests per address per minute, 4 client ids' worth per address.
    for (let i = 0; i < 20; i += 1)
      expect(
        await security.protection.checkAddressLimit('agent_token', attempt('198.51.100.80'), 'one'),
      ).toBeNull();
    expect(
      (await security.protection.checkAddressLimit('agent_token', attempt('198.51.100.80'), 'one'))
        ?.limit,
    ).toBe('agent_token');

    for (let i = 0; i < 80; i += 1)
      expect(
        await security.protection.checkAddressLimit(
          'agent_token',
          attempt('198.51.100.81'),
          `rotated-${i}`,
        ),
      ).toBeNull();
    expect(
      (
        await security.protection.checkAddressLimit(
          'agent_token',
          attempt('198.51.100.81'),
          'rotated-fresh',
        )
      )?.limit,
    ).toBe('agent_token');
  });

  it('anonymous API requests get the smaller allowance, signed-in ones the larger', async () => {
    for (let i = 0; i < 60; i += 1)
      expect(await security.protection.checkApiFlood('198.51.100.40', false)).toBeNull();
    expect((await security.protection.checkApiFlood('198.51.100.40', false))?.limit).toBe(
      'anonymous_api',
    );
    expect(await security.protection.checkApiFlood('198.51.100.40', true)).toBeNull();
    expect(await securityEvents('api-request-limited')).toHaveLength(1);
  });
});
