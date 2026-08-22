import { describe, expect, it } from 'vitest';
import { GLOBAL_KEYS, profileKey } from '@app/db';
import {
  asAccountId,
  asProfileId,
  type ManualOverridePayload,
  type TechnicalsBundle,
  type TechnicalsBundleConfig,
  type TechnicalsIntervalConfig,
  unwrapId,
} from '@app/contracts';

import { createTickBundleProvider } from '../../src/tick/bundle-builder.js';

const ACCOUNT = asAccountId('00000000-0000-0000-0000-000000000abc');
const PROFILE = asProfileId('00000000-0000-0000-0000-000000000def');
const SYMBOL = 'BTCUSDT';
const INTERVAL = '1h';
const OVERRIDE_ACTION_ID = '01234567-89ab-4cde-89ab-cdef01234567';
// TT-shaped provider set; these existing cases exercise both technicals and
// override slots. The provider now selects slots off this declared set.
const ALL_PROVIDERS = ['technicals', 'override'];

/**
 * One-interval config matching the built-in defaults: buy on STRONG_BUY/BUY, no
 * force-sell triggers. Keeps the v1.0 single-interval test rows readable
 * — multi-interval tests build their own configs inline.
 */
const tvConfig = (interval: string = INTERVAL): TechnicalsBundleConfig => ({
  useOnlyWithinMin: 2,
  ifExpires: 'do-not-buy',
  entryConfirmReads: 1,
  intervals: [defaultIntervalRow(interval)],
});

const defaultIntervalRow = (interval: string): TechnicalsIntervalConfig => ({
  interval,
  mode: 'block',
  whenStrongBuy: true,
  whenBuy: true,
  whenSell: false,
  whenStrongSell: false,
  whenNeutral: false,
});

interface PipeCommand {
  op: 'get' | 'hget' | 'pttl';
  key: string;
}

// Composite key the fake uses to store one hash member, so `hget(key, field)`
// resolves off the same flat `store` map as `get(key)`.
const hashMemberKey = (key: string, field: string): string => `${key}::${field}`;

/**
 * Minimal ioredis stub. `pipeline()` returns a chain that records GET / HGET /
 * PTTL calls; `exec()` resolves with one `[err, value]` reply per recorded
 * command, in declared order. The override slot is consumed out-of-band
 * via the top-level `del`. Errors injected via the `errorFor` predicate
 * land as the per-slot `err` half so the production parser can exercise
 * the "reply errored" warn path. `delThrows` forces `del` to reject so
 * the consume-failure deferral path is exercisable.
 *
 * `ttls` holds each key's remaining lifetime in ms. `del` drops it along with
 * the value, mirroring Redis — so a PTTL read AFTER the consuming DEL answers
 * -2 and the TTL-capture test can only pass if the read really happened first.
 */
const buildFakeRedis = (
  store: Map<string, string>,
  errorFor: (op: PipeCommand['op'], key: string) => Error | null = () => null,
  delThrows = false,
  ttls: Map<string, number> = new Map(),
): import('ioredis').Redis => {
  // `commitPipeline` looks up the chain's commit method via a
  // runtime-constructed name (`'e' + 'xec'`). The chain object below
  // exposes that property directly so the lookup hits.
  const makeChain = (cmds: PipeCommand[]) => {
    const chain = {
      get(key: string) {
        cmds.push({ op: 'get', key });
        return chain;
      },
      hget(key: string, field: string) {
        cmds.push({ op: 'hget', key: hashMemberKey(key, field) });
        return chain;
      },
      pttl(key: string) {
        cmds.push({ op: 'pttl', key });
        return chain;
      },
      exec: async (): Promise<readonly (readonly [Error | null, string | number | null])[]> => {
        return cmds.map((cmd) => {
          const err = errorFor(cmd.op, cmd.key);
          if (err) return [err, null] as const;
          if (cmd.op === 'pttl') {
            // Redis: -2 = key gone, -1 = key present with no expiry.
            const ttl = ttls.get(cmd.key) ?? (store.has(cmd.key) ? -1 : -2);
            return [null, ttl] as const;
          }
          const value = store.get(cmd.key) ?? null;
          return [null, value] as const;
        });
      },
    };
    return chain;
  };
  return {
    pipeline: () => makeChain([]),
    del: async (key: string): Promise<number> => {
      if (delThrows) throw new Error('redis del failed');
      const had = store.has(key);
      store.delete(key);
      ttls.delete(key);
      return had ? 1 : 0;
    },
  } as unknown as import('ioredis').Redis;
};

interface BundleShape {
  readonly technicals: TechnicalsBundle;
  readonly override: ManualOverridePayload | null;
}

describe('createTickBundleProvider', () => {
  it('returns the parsed signal when Redis has a fresh row', async () => {
    const store = new Map<string, string>([
      [
        GLOBAL_KEYS.technicals(SYMBOL, INTERVAL),
        JSON.stringify({ symbol: SYMBOL, recommendation: 'BUY', receivedAtMs: 1_700_000_000_000 }),
      ],
    ]);
    const provider = createTickBundleProvider({ redis: buildFakeRedis(store) });
    const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ALL_PROVIDERS))
      .bundle as unknown as BundleShape;
    expect(bundle.technicals.signals).toHaveLength(1);
    expect(bundle.technicals.signals[0]).toEqual({
      interval: INTERVAL,
      signal: {
        symbol: SYMBOL,
        recommendation: 'BUY',
        // The display-only fields default to null when the cached row carries
        // only the gate-required keys, as this thin fixture row does.
        maRecommendation: null,
        oscRecommendation: null,
        receivedAtMs: 1_700_000_000_000,
        indicators: null,
      },
    });
    expect(bundle.technicals.config).toEqual(tvConfig());
    expect(bundle.override).toBeNull();
  });

  it('returns a stale signal unmodified — freshness is the gate, not the builder', async () => {
    const store = new Map<string, string>([
      [
        GLOBAL_KEYS.technicals(SYMBOL, INTERVAL),
        JSON.stringify({ symbol: SYMBOL, recommendation: 'SELL', receivedAtMs: 0 }),
      ],
    ]);
    const provider = createTickBundleProvider({ redis: buildFakeRedis(store) });
    const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ALL_PROVIDERS))
      .bundle as unknown as BundleShape;
    expect(bundle.technicals.signals[0]?.signal?.recommendation).toBe('SELL');
    expect(bundle.technicals.signals[0]?.signal?.receivedAtMs).toBe(0);
  });

  it('returns a null per-interval signal when the Redis row is absent', async () => {
    const provider = createTickBundleProvider({ redis: buildFakeRedis(new Map()) });
    const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ALL_PROVIDERS))
      .bundle as unknown as BundleShape;
    expect(bundle.technicals.signals).toEqual([{ interval: INTERVAL, signal: null }]);
    expect(bundle.technicals.config).toEqual(tvConfig());
  });

  it('threads operator-configured tvConfig onto bundle.technicals.config', async () => {
    // Locks the contract that the per-profile freshness gate the tick-
    // context plumbs in lands on the bundle verbatim. Without this the
    // strategy's technicals-gate would silently fall back to defaults and the
    // operator's edit would never take effect.
    const provider = createTickBundleProvider({ redis: buildFakeRedis(new Map()) });
    const cfg: TechnicalsBundleConfig = {
      useOnlyWithinMin: 10,
      ifExpires: 'allow-anyway',
      entryConfirmReads: 1,
      intervals: [defaultIntervalRow(INTERVAL)],
    };
    const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, cfg, ALL_PROVIDERS))
      .bundle as unknown as BundleShape;
    expect(bundle.technicals.config).toEqual(cfg);
  });

  it('returns null and logs when the Redis row is malformed JSON', async () => {
    const store = new Map<string, string>([
      [GLOBAL_KEYS.technicals(SYMBOL, INTERVAL), '{not-json'],
    ]);
    const warnings: { ctx: unknown; msg: string }[] = [];
    const provider = createTickBundleProvider({
      redis: buildFakeRedis(store),
      logger: {
        warn: (ctx: unknown, msg: string) => {
          warnings.push({ ctx, msg });
        },
      } as unknown as import('pino').Logger,
    });
    const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ALL_PROVIDERS))
      .bundle as unknown as BundleShape;
    expect(bundle.technicals.signals[0]?.signal).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toMatch(/malformed JSON/);
  });

  it('returns null and logs when the Redis row fails schema validation', async () => {
    const store = new Map<string, string>([
      [
        GLOBAL_KEYS.technicals(SYMBOL, INTERVAL),
        JSON.stringify({ symbol: SYMBOL, recommendation: 'PROBABLY_BUY', receivedAtMs: -1 }),
      ],
    ]);
    const warnings: { ctx: unknown; msg: string }[] = [];
    const provider = createTickBundleProvider({
      redis: buildFakeRedis(store),
      logger: {
        warn: (ctx: unknown, msg: string) => {
          warnings.push({ ctx, msg });
        },
      } as unknown as import('pino').Logger,
    });
    const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ALL_PROVIDERS))
      .bundle as unknown as BundleShape;
    expect(bundle.technicals.signals[0]?.signal).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toMatch(/failed schema/);
  });

  it('reads one Redis key per configured interval and preserves config order', async () => {
    // Multi-interval contract: each (symbol, interval) is its own Redis key
    // and the builder emits one entry per configured row in operator order.
    const store = new Map<string, string>([
      [
        GLOBAL_KEYS.technicals(SYMBOL, '1h'),
        JSON.stringify({ symbol: SYMBOL, recommendation: 'BUY', receivedAtMs: 1 }),
      ],
      [
        GLOBAL_KEYS.technicals(SYMBOL, '1d'),
        JSON.stringify({ symbol: SYMBOL, recommendation: 'NEUTRAL', receivedAtMs: 2 }),
      ],
    ]);
    const provider = createTickBundleProvider({ redis: buildFakeRedis(store) });
    const cfg: TechnicalsBundleConfig = {
      useOnlyWithinMin: 2,
      ifExpires: 'do-not-buy',
      entryConfirmReads: 1,
      intervals: [defaultIntervalRow('1h'), defaultIntervalRow('1d')],
    };
    const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, cfg, ALL_PROVIDERS))
      .bundle as unknown as BundleShape;
    expect(bundle.technicals.signals).toHaveLength(2);
    expect(bundle.technicals.signals[0]?.interval).toBe('1h');
    expect(bundle.technicals.signals[0]?.signal?.recommendation).toBe('BUY');
    expect(bundle.technicals.signals[1]?.interval).toBe('1d');
    expect(bundle.technicals.signals[1]?.signal?.recommendation).toBe('NEUTRAL');
  });

  it('emits an empty signals array when the operator opted out of Technicals', async () => {
    // Empty intervals list = operator cleared the TV block. The strategy's
    // technicals-gate then treats the buy gate as fully open.
    const provider = createTickBundleProvider({ redis: buildFakeRedis(new Map()) });
    const cfg: TechnicalsBundleConfig = {
      useOnlyWithinMin: 2,
      ifExpires: 'do-not-buy',
      entryConfirmReads: 1,
      intervals: [],
    };
    const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, cfg, ALL_PROVIDERS))
      .bundle as unknown as BundleShape;
    expect(bundle.technicals.signals).toEqual([]);
  });

  it('consumes the manual-override row and projects into bundle.override', async () => {
    // The API writes the override key; on a healthy tick the worker reads
    // it then DELs it so a second tick on the same symbol does not double-
    // act. chainByKey serialises ticks per symbol so the GET/DEL is safe.
    const overrideKey = profileKey({ accountId: ACCOUNT, profileId: PROFILE }, 'override', SYMBOL);
    const store = new Map<string, string>([
      [
        overrideKey,
        JSON.stringify({
          kind: 'manual-order',
          overrideActionId: OVERRIDE_ACTION_ID,
          payload: { side: 'BUY', type: 'MARKET', quoteAmount: '20' },
        }),
      ],
    ]);
    const provider = createTickBundleProvider({ redis: buildFakeRedis(store) });
    const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ALL_PROVIDERS))
      .bundle as unknown as BundleShape;
    expect(bundle.override).toMatchObject({
      kind: 'manual-order',
      overrideActionId: OVERRIDE_ACTION_ID,
      payload: { side: 'BUY', type: 'MARKET', quoteAmount: '20' },
    });
    // Consumed by the first tick's DEL: the second invocation sees nothing.
    const bundle2 = (await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ALL_PROVIDERS))
      .bundle as unknown as BundleShape;
    expect(bundle2.override).toBeNull();
  });

  it('captures the override TTL in the pipeline, before the consuming DEL', async () => {
    // The remaining TTL is only knowable BEFORE the DEL destroys the key, and the
    // tick handler needs it to re-arm the override with the operator's original
    // expiry when the strategy defers. The fake drops the TTL on DEL, so a PTTL
    // issued after the DEL would read -2 and surface as `undefined` here.
    const overrideKey = profileKey({ accountId: ACCOUNT, profileId: PROFILE }, 'override', SYMBOL);
    const store = new Map<string, string>([
      [overrideKey, JSON.stringify({ kind: 'trigger-sell', overrideActionId: OVERRIDE_ACTION_ID })],
    ]);
    const ttls = new Map<string, number>([[overrideKey, 240_000]]);
    const provider = createTickBundleProvider({
      redis: buildFakeRedis(store, () => null, false, ttls),
    });
    const result = await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ALL_PROVIDERS);
    expect((result.bundle as unknown as BundleShape).override).toMatchObject({
      kind: 'trigger-sell',
    });
    expect(result.overrideTtlMs).toBe(240_000);
    // Key consumed: the next tick has no override, and therefore no TTL either.
    const second = await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ALL_PROVIDERS);
    expect(second.overrideTtlMs).toBeUndefined();
  });

  it('omits the override TTL when the PTTL slot errors', async () => {
    // A per-command failure on the TTL slot must not poison the override itself:
    // the override still projects (the strategy acts on it), but with no known
    // window the handler consumes rather than re-arming on a guessed lifetime.
    const overrideKey = profileKey({ accountId: ACCOUNT, profileId: PROFILE }, 'override', SYMBOL);
    const store = new Map<string, string>([
      [overrideKey, JSON.stringify({ kind: 'trigger-sell', overrideActionId: OVERRIDE_ACTION_ID })],
    ]);
    const provider = createTickBundleProvider({
      redis: buildFakeRedis(
        store,
        (op) => (op === 'pttl' ? new Error('pttl slot failed') : null),
        false,
        new Map([[overrideKey, 240_000]]),
      ),
    });
    const result = await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ALL_PROVIDERS);
    expect((result.bundle as unknown as BundleShape).override).not.toBeNull();
    expect(result.overrideTtlMs).toBeUndefined();
  });

  it('omits the override TTL when the key carries no expiry', async () => {
    // A hand-written override with no TTL (-1) has no operator window to restore,
    // so the handler must consume rather than re-arm with a guessed lifetime.
    const overrideKey = profileKey({ accountId: ACCOUNT, profileId: PROFILE }, 'override', SYMBOL);
    const store = new Map<string, string>([
      [overrideKey, JSON.stringify({ kind: 'trigger-sell', overrideActionId: OVERRIDE_ACTION_ID })],
    ]);
    const provider = createTickBundleProvider({ redis: buildFakeRedis(store) });
    const result = await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ALL_PROVIDERS);
    expect((result.bundle as unknown as BundleShape).override).not.toBeNull();
    expect(result.overrideTtlMs).toBeUndefined();
  });

  it('defers the override when the consuming DEL fails', async () => {
    // At-most-once safeguard: if the DEL that consumes the slot rejects, the
    // provider must not project the override (it could not guarantee the row
    // is gone) and leaves it for the next tick to retry.
    const overrideKey = profileKey({ accountId: ACCOUNT, profileId: PROFILE }, 'override', SYMBOL);
    const store = new Map<string, string>([
      [
        overrideKey,
        JSON.stringify({
          kind: 'manual-order',
          overrideActionId: OVERRIDE_ACTION_ID,
          payload: { side: 'BUY', type: 'MARKET', quoteAmount: '20' },
        }),
      ],
    ]);
    const warnings: { msg: string }[] = [];
    const provider = createTickBundleProvider({
      redis: buildFakeRedis(store, () => null, true),
      logger: {
        warn: (_ctx: unknown, msg: string) => {
          warnings.push({ msg });
        },
      } as unknown as import('pino').Logger,
    });
    const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ALL_PROVIDERS))
      .bundle as unknown as BundleShape;
    expect(bundle.override).toBeNull();
    expect(warnings.some((w) => /DEL\) failed/.test(w.msg))).toBe(true);
    // Row survives for the next tick — the failed DEL left it in place.
    expect(store.has(overrideKey)).toBe(true);
  });

  it('returns null override and logs when the row is malformed JSON', async () => {
    const overrideKey = profileKey({ accountId: ACCOUNT, profileId: PROFILE }, 'override', SYMBOL);
    const store = new Map<string, string>([[overrideKey, '{not-json']]);
    const warnings: { ctx: unknown; msg: string }[] = [];
    const provider = createTickBundleProvider({
      redis: buildFakeRedis(store),
      logger: {
        warn: (ctx: unknown, msg: string) => {
          warnings.push({ ctx, msg });
        },
      } as unknown as import('pino').Logger,
    });
    const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ALL_PROVIDERS))
      .bundle as unknown as BundleShape;
    expect(bundle.override).toBeNull();
    expect(warnings.some((w) => /malformed JSON in override row/.test(w.msg))).toBe(true);
  });

  it('issues exactly one pipelined round trip per tick', async () => {
    // Lock the contract that the signal GETs and the override GET ride a
    // single EXEC. Regression here means the optimisation rolled back.
    const store = new Map<string, string>();
    let pipelineCount = 0;
    const realFactory = buildFakeRedis(store).pipeline;
    const redis = {
      pipeline: () => {
        pipelineCount += 1;
        return realFactory();
      },
    } as unknown as import('ioredis').Redis;
    const provider = createTickBundleProvider({ redis });
    await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ALL_PROVIDERS);
    expect(pipelineCount).toBe(1);
  });

  it('defers the override without consuming it when any signal slot errored', async () => {
    // The override is read non-destructively (GET, not GETDEL), so a
    // degraded signal tick must NOT consume it: the slot survives in Redis
    // and the next clean tick applies it. The bundle drops the override
    // for this tick so the strategy never acts under a broken signal
    // context; a warn surfaces the deferral.
    const overrideKey = profileKey({ accountId: ACCOUNT, profileId: PROFILE }, 'override', SYMBOL);
    const store = new Map<string, string>([
      [
        overrideKey,
        JSON.stringify({
          kind: 'manual-order',
          overrideActionId: OVERRIDE_ACTION_ID,
          payload: { side: 'BUY', type: 'MARKET', quoteAmount: '20' },
        }),
      ],
    ]);
    const warnings: { msg: string }[] = [];
    const provider = createTickBundleProvider({
      redis: buildFakeRedis(store, (op, key) =>
        op === 'get' && key === GLOBAL_KEYS.technicals(SYMBOL, INTERVAL)
          ? new Error('connection reset')
          : null,
      ),
      logger: {
        warn: (_ctx: unknown, msg: string) => {
          warnings.push({ msg });
        },
      } as unknown as import('pino').Logger,
    });
    const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ALL_PROVIDERS))
      .bundle as unknown as BundleShape;
    expect(bundle.override).toBeNull();
    expect(warnings.some((w) => /deferring override/.test(w.msg))).toBe(true);
    // Override slot survives for the next clean tick — not consumed.
    expect(store.has(overrideKey)).toBe(true);
  });

  it('throws a context-rich error when the pipeline returns null (mid-EXEC abort)', async () => {
    // Synthetic null reply path: the commit returns null even though the
    // call did not reject. Operator needs accountId/profileId/symbol in the
    // error to triage; opaque "pipeline returned null" buries the cause.
    const redis = {
      pipeline: () => ({
        get() {
          return this;
        },
        pttl() {
          return this;
        },
        exec: async () => null,
      }),
    } as unknown as import('ioredis').Redis;
    const provider = createTickBundleProvider({ redis });
    await expect(provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ALL_PROVIDERS)).rejects.toThrow(
      new RegExp(`symbol=${SYMBOL}`),
    );
  });

  it('consumes the override via a separate DEL on a healthy tick', async () => {
    // The override rides the signal pipeline as a non-destructive GET; on
    // a healthy tick with a pending override the provider then DELs the
    // slot so the strategy acts on it exactly once.
    const overrideKey = profileKey({ accountId: ACCOUNT, profileId: PROFILE }, 'override', SYMBOL);
    const store = new Map<string, string>([
      [
        GLOBAL_KEYS.technicals(SYMBOL, INTERVAL),
        JSON.stringify({ symbol: SYMBOL, recommendation: 'BUY', receivedAtMs: 1 }),
      ],
      [
        overrideKey,
        JSON.stringify({
          kind: 'manual-order',
          overrideActionId: OVERRIDE_ACTION_ID,
          payload: { side: 'BUY', type: 'MARKET', quoteAmount: '20' },
        }),
      ],
    ]);
    const provider = createTickBundleProvider({ redis: buildFakeRedis(store) });
    const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ALL_PROVIDERS))
      .bundle as unknown as BundleShape;
    expect(bundle.technicals.signals[0]?.signal?.recommendation).toBe('BUY');
    expect(bundle.override).not.toBeNull();
    // The separate DEL consumed the slot.
    expect(store.has(overrideKey)).toBe(false);
  });

  it('returns null for one per-slot error without poisoning sibling slots', async () => {
    const store = new Map<string, string>([
      [
        GLOBAL_KEYS.technicals(SYMBOL, '1h'),
        JSON.stringify({ symbol: SYMBOL, recommendation: 'BUY', receivedAtMs: 1 }),
      ],
      [
        GLOBAL_KEYS.technicals(SYMBOL, '1d'),
        JSON.stringify({ symbol: SYMBOL, recommendation: 'NEUTRAL', receivedAtMs: 2 }),
      ],
    ]);
    const warnings: { msg: string }[] = [];
    const provider = createTickBundleProvider({
      redis: buildFakeRedis(store, (op, key) =>
        op === 'get' && key === GLOBAL_KEYS.technicals(SYMBOL, '1h')
          ? new Error('connection reset')
          : null,
      ),
      logger: {
        warn: (_ctx: unknown, msg: string) => {
          warnings.push({ msg });
        },
      } as unknown as import('pino').Logger,
    });
    const cfg: TechnicalsBundleConfig = {
      useOnlyWithinMin: 2,
      ifExpires: 'do-not-buy',
      entryConfirmReads: 1,
      intervals: [defaultIntervalRow('1h'), defaultIntervalRow('1d')],
    };
    const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, cfg, ALL_PROVIDERS))
      .bundle as unknown as BundleShape;
    expect(bundle.technicals.signals[0]?.signal).toBeNull();
    expect(bundle.technicals.signals[1]?.signal?.recommendation).toBe('NEUTRAL');
    expect(warnings.some((w) => /reply errored/.test(w.msg))).toBe(true);
  });

  it('returns null override and logs when the row fails schema validation', async () => {
    const overrideKey = profileKey({ accountId: ACCOUNT, profileId: PROFILE }, 'override', SYMBOL);
    const store = new Map<string, string>([
      [overrideKey, JSON.stringify({ kind: 'unknown-kind', overrideActionId: OVERRIDE_ACTION_ID })],
    ]);
    const warnings: { ctx: unknown; msg: string }[] = [];
    const provider = createTickBundleProvider({
      redis: buildFakeRedis(store),
      logger: {
        warn: (ctx: unknown, msg: string) => {
          warnings.push({ ctx, msg });
        },
      } as unknown as import('pino').Logger,
    });
    const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ALL_PROVIDERS))
      .bundle as unknown as BundleShape;
    expect(bundle.override).toBeNull();
    expect(warnings.some((w) => /override row failed schema/.test(w.msg))).toBe(true);
  });

  it('reads nothing for a strategy that declares no bundle providers', async () => {
    // momentum (bundleProviders: []) must pay no technicals/override Redis
    // round-trip: the provider returns an empty bundle without pipelining.
    let pipelineCalls = 0;
    const redis = {
      pipeline: () => {
        pipelineCalls += 1;
        throw new Error('bundle-builder should not pipeline when no providers are declared');
      },
      del: async (): Promise<number> => 0,
    } as unknown as import('ioredis').Redis;
    const provider = createTickBundleProvider({ redis });
    const { bundle } = await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), []);
    expect(bundle).toEqual({});
    expect(pipelineCalls).toBe(0);
  });

  it('assembles only technicals when override is not declared', async () => {
    const store = new Map<string, string>([
      [
        GLOBAL_KEYS.technicals(SYMBOL, INTERVAL),
        JSON.stringify({ symbol: SYMBOL, recommendation: 'BUY', receivedAtMs: 1 }),
      ],
      // An override sits in Redis, but the strategy did not declare the
      // provider — the builder must not read or project it.
      [
        profileKey({ accountId: ACCOUNT, profileId: PROFILE }, 'override', SYMBOL),
        JSON.stringify({ kind: 'trigger-buy', overrideActionId: OVERRIDE_ACTION_ID }),
      ],
    ]);
    const provider = createTickBundleProvider({ redis: buildFakeRedis(store) });
    const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ['technicals']))
      .bundle as Record<string, unknown>;
    expect(bundle).toHaveProperty('technicals');
    expect(bundle).not.toHaveProperty('override');
  });

  it('assembles only override when technicals is not declared', async () => {
    const store = new Map<string, string>([
      [
        profileKey({ accountId: ACCOUNT, profileId: PROFILE }, 'override', SYMBOL),
        JSON.stringify({ kind: 'trigger-buy', overrideActionId: OVERRIDE_ACTION_ID }),
      ],
    ]);
    const provider = createTickBundleProvider({ redis: buildFakeRedis(store) });
    const bundle = (await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ['override']))
      .bundle as Record<string, unknown>;
    expect(bundle).not.toHaveProperty('technicals');
    expect(bundle).toHaveProperty('override');
    expect((bundle['override'] as { kind: string }).kind).toBe('trigger-buy');
  });
});

describe('createTickBundleProvider — discovery entry-hint provider', () => {
  const ENTRY_HINT_KEY = GLOBAL_KEYS.discoveryEnterOnAdd(unwrapId(PROFILE));

  it('arms entryHint when the discovery enter-on-add hash has the symbol member', async () => {
    const store = new Map<string, string>([
      [hashMemberKey(ENTRY_HINT_KEY, SYMBOL), String(1_700_000_000_000)],
    ]);
    const provider = createTickBundleProvider({ redis: buildFakeRedis(store) });
    const bundle = (
      await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ['technicals', 'override', 'entry-hint'])
    ).bundle as Record<string, unknown>;
    expect(bundle['entryHint']).toEqual({ enterOnAdd: true });
  });

  it('parses a rich JSON hint value into the guard fields (#473)', async () => {
    const store = new Map<string, string>([
      [
        hashMemberKey(ENTRY_HINT_KEY, SYMBOL),
        JSON.stringify({
          at: 1_700_000_000_000,
          high24h: '100',
          maxDistanceFrom24hHighPercent: '3',
          knifeCandles: 3,
          knifeDropPercent: '5',
        }),
      ],
    ]);
    const provider = createTickBundleProvider({ redis: buildFakeRedis(store) });
    const bundle = (
      await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ['technicals', 'entry-hint'])
    ).bundle as Record<string, unknown>;
    expect(bundle['entryHint']).toEqual({
      enterOnAdd: true,
      high24h: '100',
      maxDistanceFrom24hHighPercent: '3',
      knifeCandles: 3,
      knifeDropPercent: '5',
    });
  });

  it('honours an explicit enterOnAdd:false in the hint payload, keeping the guard fields (#486)', async () => {
    const store = new Map<string, string>([
      [
        hashMemberKey(ENTRY_HINT_KEY, SYMBOL),
        JSON.stringify({
          at: 1_700_000_000_000,
          enterOnAdd: false,
          high24h: '100',
          maxDistanceFrom24hHighPercent: '3',
        }),
      ],
    ]);
    const provider = createTickBundleProvider({ redis: buildFakeRedis(store) });
    const bundle = (
      await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ['technicals', 'entry-hint'])
    ).bundle as Record<string, unknown>;
    expect(bundle['entryHint']).toEqual({
      enterOnAdd: false,
      high24h: '100',
      maxDistanceFrom24hHighPercent: '3',
    });
  });

  it('drops a non-integer knifeCandles so it cannot become a whole-array knife window (#486)', async () => {
    const store = new Map<string, string>([
      [
        hashMemberKey(ENTRY_HINT_KEY, SYMBOL),
        JSON.stringify({ at: 1_700_000_000_000, enterOnAdd: false, knifeCandles: 2.5 }),
      ],
    ]);
    const provider = createTickBundleProvider({ redis: buildFakeRedis(store) });
    const bundle = (
      await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ['technicals', 'entry-hint'])
    ).bundle as Record<string, unknown>;
    expect(bundle['entryHint']).toEqual({ enterOnAdd: false });
  });

  it('drops a negative decimal guard field so it cannot fail-close the tick boundary', async () => {
    // The tick boundary now parses the assembled bundle against the strategy's
    // bundleSchema, which requires each decimal guard >= 0. A corrupt Redis hint
    // must degrade (field omitted, hint still armed on its valid fields), never
    // survive to DLQ the tick — an advisory input must not halt exits.
    const store = new Map<string, string>([
      [
        hashMemberKey(ENTRY_HINT_KEY, SYMBOL),
        JSON.stringify({
          at: 1_700_000_000_000,
          high24h: '-5',
          maxDistanceFrom24hHighPercent: '3',
        }),
      ],
    ]);
    const provider = createTickBundleProvider({ redis: buildFakeRedis(store) });
    const bundle = (
      await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ['technicals', 'entry-hint'])
    ).bundle as Record<string, unknown>;
    expect(bundle['entryHint']).toEqual({ enterOnAdd: true, maxDistanceFrom24hHighPercent: '3' });
  });

  it('drops a non-decimal guard field ("n/a") rather than passing it to the schema', async () => {
    const store = new Map<string, string>([
      [
        hashMemberKey(ENTRY_HINT_KEY, SYMBOL),
        JSON.stringify({
          at: 1_700_000_000_000,
          high24h: 'n/a',
          knifeDropPercent: 'nope',
        }),
      ],
    ]);
    const provider = createTickBundleProvider({ redis: buildFakeRedis(store) });
    const bundle = (
      await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ['technicals', 'entry-hint'])
    ).bundle as Record<string, unknown>;
    expect(bundle['entryHint']).toEqual({ enterOnAdd: true });
  });

  it('parses a legacy bare-number hint value as enterOnAdd-only (no guard fields)', async () => {
    const store = new Map<string, string>([
      [hashMemberKey(ENTRY_HINT_KEY, SYMBOL), String(1_700_000_000_000)],
    ]);
    const provider = createTickBundleProvider({ redis: buildFakeRedis(store) });
    const bundle = (
      await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ['technicals', 'entry-hint'])
    ).bundle as Record<string, unknown>;
    expect(bundle['entryHint']).toEqual({ enterOnAdd: true });
  });

  it('fails safe to null (not armed) on a malformed hint value', async () => {
    const store = new Map<string, string>([[hashMemberKey(ENTRY_HINT_KEY, SYMBOL), '{not-json']]);
    const provider = createTickBundleProvider({ redis: buildFakeRedis(store) });
    const bundle = (
      await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ['technicals', 'entry-hint'])
    ).bundle as Record<string, unknown>;
    expect(bundle['entryHint']).toBeNull();
  });

  it('leaves entryHint null when the symbol is not in the enter-on-add hash', async () => {
    const provider = createTickBundleProvider({ redis: buildFakeRedis(new Map()) });
    const bundle = (
      await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ['technicals', 'entry-hint'])
    ).bundle as Record<string, unknown>;
    expect(bundle['entryHint']).toBeNull();
  });

  it('does not read entryHint when the strategy omits the provider', async () => {
    const store = new Map<string, string>([
      [hashMemberKey(ENTRY_HINT_KEY, SYMBOL), String(1_700_000_000_000)],
    ]);
    const provider = createTickBundleProvider({ redis: buildFakeRedis(store) });
    const bundle = (
      await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ['technicals', 'override'])
    ).bundle as Record<string, unknown>;
    expect(bundle).not.toHaveProperty('entryHint');
  });

  it('defers the hint (null) when a technicals signal slot errored, even though the member is present', async () => {
    // Mirrors the override deferral: a degraded technicals read must not relax
    // the gate, since we cannot confirm there is no fresh STRONG_SELL.
    const store = new Map<string, string>([
      [hashMemberKey(ENTRY_HINT_KEY, SYMBOL), String(1_700_000_000_000)],
    ]);
    const provider = createTickBundleProvider({
      redis: buildFakeRedis(store, (op) => (op === 'get' ? new Error('technicals boom') : null)),
    });
    const bundle = (
      await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ['technicals', 'entry-hint'])
    ).bundle as Record<string, unknown>;
    expect(bundle['entryHint']).toBeNull();
  });

  it('fails safe to null (not armed) when the hash read errors', async () => {
    const store = new Map<string, string>([
      [hashMemberKey(ENTRY_HINT_KEY, SYMBOL), String(1_700_000_000_000)],
    ]);
    const provider = createTickBundleProvider({
      redis: buildFakeRedis(store, (op) => (op === 'hget' ? new Error('boom') : null)),
    });
    const bundle = (
      await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ['technicals', 'entry-hint'])
    ).bundle as Record<string, unknown>;
    expect(bundle['entryHint']).toBeNull();
  });

  it('lands entryHint on the right slot when override is not declared', async () => {
    const store = new Map<string, string>([
      [hashMemberKey(ENTRY_HINT_KEY, SYMBOL), String(1_700_000_000_000)],
    ]);
    const provider = createTickBundleProvider({ redis: buildFakeRedis(store) });
    const bundle = (
      await provider(ACCOUNT, PROFILE, SYMBOL, tvConfig(), ['technicals', 'entry-hint'])
    ).bundle as Record<string, unknown>;
    expect(bundle).not.toHaveProperty('override');
    expect(bundle['entryHint']).toEqual({ enterOnAdd: true });
  });
});
