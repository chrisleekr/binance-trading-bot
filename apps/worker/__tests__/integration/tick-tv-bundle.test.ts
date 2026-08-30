// Integration test for the production tick bundle provider against a
// real Redis. Seeds the same `GLOBAL_KEYS.technicals` row the
// `technicals-compute` cron writes, then asserts the bundle provider
// returns the parsed signal the trailing-trade gate expects to consume.

import { afterAll, beforeAll, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { pino } from 'pino';

import {
  asAccountId,
  asProfileId,
  TechnicalsSignalSchema,
  type ManualOverridePayload,
  type TechnicalsBundle,
  type TechnicalsBundleConfig,
  type TechnicalsSignal,
} from '@app/contracts';
import { GLOBAL_KEYS, profileKey } from '@app/db';
import { withRedis, type RedisFixture } from '@app/testcontainers';

import { createTickBundleProvider } from '../../src/tick/bundle-builder.js';

import { describeInfra } from './_infra-gate.js';

const ACCOUNT = asAccountId('00000000-0000-0000-0000-000000000abc');
const PROFILE = asProfileId('00000000-0000-0000-0000-000000000def');
const SYMBOL = 'BTCUSDT';
const INTERVAL = '1h';
const T0_MS = 1_700_000_000_000;
const OVERRIDE_ACTION_ID = '01234567-89ab-4cde-89ab-cdef01234567';
// TT-shaped provider set; this test exercises the technicals slot and asserts
// the override slot is absent (no override key seeded).
const PROVIDERS = ['technicals', 'override'];
const TV_CONFIG: TechnicalsBundleConfig = {
  useOnlyWithinMin: 2,
  ifExpires: 'do-not-buy',
  entryConfirmReads: 1,
  intervals: [
    {
      interval: INTERVAL,
      whenStrongBuy: true,
      whenBuy: true,
      whenSell: false,
      whenStrongSell: false,
      whenNeutral: false,
      mode: 'advisory',
    },
  ],
};

interface ProviderBundle {
  readonly technicals: TechnicalsBundle;
  readonly override: ManualOverridePayload | null;
}

describeInfra('redis', 'tick bundle provider — Redis-backed', () => {
  let redisFx: RedisFixture | undefined;
  let redis: Redis | undefined;

  beforeAll(async () => {
    redisFx = await withRedis();
    redis = new Redis(redisFx.redisUrl);
  }, 60_000);

  afterAll(async () => {
    const swallow = (): void => undefined;
    if (redis) await redis.quit().catch(swallow);
    if (redisFx) await redisFx.stop().catch(swallow);
  });

  it('parses a fresh cron-written row into bundle.technicals.signals[0]', async () => {
    if (!redis) throw new Error('fixture not ready');
    const r = redis;
    const key = GLOBAL_KEYS.technicals(SYMBOL, INTERVAL);
    const seeded: TechnicalsSignal = TechnicalsSignalSchema.parse({
      symbol: SYMBOL,
      recommendation: 'STRONG_BUY',
      receivedAtMs: T0_MS,
    });
    await r.set(key, JSON.stringify(seeded));
    try {
      const provider = createTickBundleProvider({ redis: r, logger: pino({ level: 'silent' }) });
      const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, TV_CONFIG, PROVIDERS))
        .bundle as unknown as ProviderBundle;
      expect(bundle.technicals.signals).toHaveLength(1);
      expect(bundle.technicals.signals[0]).toEqual({ interval: INTERVAL, signal: seeded });
      expect(bundle.technicals.config.useOnlyWithinMin).toBe(2);
      expect(bundle.technicals.config.ifExpires).toBe('do-not-buy');
      expect(bundle.technicals.config.intervals.map((i) => i.interval)).toEqual([INTERVAL]);
      // No override key seeded: the override slot is declared but empty.
      expect(bundle.override).toBeNull();
    } finally {
      await r.del(key);
    }
  });

  it('returns a null inner signal when the row is absent (cron never ran)', async () => {
    if (!redis) throw new Error('fixture not ready');
    const provider = createTickBundleProvider({
      redis,
      logger: pino({ level: 'silent' }),
    });
    const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, TV_CONFIG, PROVIDERS))
      .bundle as unknown as ProviderBundle;
    expect(bundle.technicals.signals).toHaveLength(1);
    expect(bundle.technicals.signals[0]).toEqual({ interval: INTERVAL, signal: null });
  });

  it('reads the override TTL in the pipeline and consumes the key (real ioredis PTTL)', async () => {
    // The only real-ioredis exercise of the pipeline: proves `pipe.pttl()` is a
    // valid chained command and that its reply reaches `overrideTtlMs` BEFORE the
    // consuming DEL. The tick handler re-arms a deferred override off this value.
    if (!redis) throw new Error('fixture not ready');
    const r = redis;
    const overrideKey = profileKey({ accountId: ACCOUNT, profileId: PROFILE }, 'override', SYMBOL);
    await r.set(
      overrideKey,
      JSON.stringify({ kind: 'trigger-sell', overrideActionId: OVERRIDE_ACTION_ID }),
      'PX',
      300_000,
    );
    try {
      const provider = createTickBundleProvider({ redis: r, logger: pino({ level: 'silent' }) });
      const result = await provider(ACCOUNT, PROFILE, SYMBOL, TV_CONFIG, PROVIDERS);
      expect((result.bundle as unknown as ProviderBundle).override).toMatchObject({
        kind: 'trigger-sell',
        overrideActionId: OVERRIDE_ACTION_ID,
      });
      expect(result.overrideTtlMs).toBeGreaterThan(0);
      expect(result.overrideTtlMs).toBeLessThanOrEqual(300_000);
      // Consumed: the key is gone, which is exactly why the TTL had to be read
      // in the same round trip as the value.
      expect(await r.exists(overrideKey)).toBe(0);
    } finally {
      await r.del(overrideKey);
    }
  });
});
