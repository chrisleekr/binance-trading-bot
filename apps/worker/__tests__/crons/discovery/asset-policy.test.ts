import { describe, expect, it, vi } from 'vitest';
import type { SymbolAdmission } from '../../../src/crons/discovery/symbol-admission.js';
import {
  createAssetPolicyResolver,
  deriveAssetPolicy,
  projectProducts,
  SNAPSHOT_MAX_AGE_MS,
  validateAssetPolicy,
} from '../../../src/crons/discovery/asset-policy.js';
import {
  liveAdmission,
  NEW_STABLECOIN_ROW,
  PRODUCT_ROWS,
  productsPayload,
  type ProductRowFixture,
} from './_asset-policy-fixture.js';

const PRODUCTS_URL =
  'https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=true';

const MINUTE_MS = 60_000;

const noopLogger = (): { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } => ({
  warn: vi.fn(),
  info: vi.fn(),
});

/** A minimal `fetch` result: only `ok`/`status`/`statusText`/`headers`/`json` are read. */
const okResponse = (body: unknown, headers: Record<string, string> = {}): unknown => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: new Headers(headers),
  json: async () => body,
});

/** A hand-driven clock, so a test can move time DURING a fetch and observe which side of the await the freshness stamp was taken on. */
const fakeClock = (
  startMs = 1_700_000_000_000,
): { nowMs: () => number; advance: (ms: number) => void } => {
  let now = startMs;
  return {
    nowMs: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const sortedBases = (policy: { stablecoinOrFiatBases: ReadonlySet<string> }): string[] =>
  [...policy.stablecoinOrFiatBases].sort();

const policyFrom = (rows: readonly ProductRowFixture[]): ReturnType<typeof deriveAssetPolicy> =>
  deriveAssetPolicy(projectProducts(productsPayload(rows)));

describe('projectProducts', () => {
  it('reads the feed short keys and ignores every other key on the row', () => {
    const decorated = { ...PRODUCT_ROWS[0], an: 'Ripple USD', qv: '1', c: '1', etf: false };
    const out = projectProducts(productsPayload([decorated]));
    expect(out).toEqual([
      {
        s: 'RLUSDUSDT',
        st: 'TRADING',
        b: 'RLUSD',
        q: 'USDT',
        pm: 'USDT',
        pn: 'USDT',
        tags: ['stablecoin'],
      },
    ]);
  });

  it('projects every fixture row', () => {
    expect(projectProducts(productsPayload(PRODUCT_ROWS))).toHaveLength(PRODUCT_ROWS.length);
  });

  it('skips a row spelled with the long-form key names (schema drift)', () => {
    const drifted = {
      symbol: 'RLUSDUSDT',
      status: 'TRADING',
      baseAsset: 'RLUSD',
      quoteAsset: 'USDT',
      parentMarket: 'USDT',
      parentName: 'USDT',
      tags: ['stablecoin'],
    };
    expect(projectProducts(productsPayload([drifted]))).toEqual([]);
  });

  it('skips a row whose tags are not a string array', () => {
    const badTags = { ...PRODUCT_ROWS[0], tags: 'stablecoin' };
    const missingTags = { s: 'X', st: 'TRADING', b: 'X', q: 'USDT', pm: 'USDT', pn: 'USDT' };
    expect(projectProducts(productsPayload([badTags, missingTags]))).toEqual([]);
  });

  it('refuses a row count far past the live feed rather than truncating it', () => {
    const flood = Array.from({ length: 20_001 }, (_, i) => ({
      ...PRODUCT_ROWS[0],
      s: `X${i}USDT`,
    }));
    // Truncation would shrink the symbol set, which the completeness check would then misreport as an exchangeInfo mismatch and point the operator at the wrong fault.
    expect(() => projectProducts(productsPayload(flood))).toThrow(/exceeds/i);
  });

  it('returns nothing when the envelope carries no data array', () => {
    expect(projectProducts({ code: '000000', success: true })).toEqual([]);
    expect(projectProducts({ code: '000000', success: true, data: 'nope' })).toEqual([]);
    expect(projectProducts(null)).toEqual([]);
    expect(projectProducts('not json')).toEqual([]);
  });
});

describe('deriveAssetPolicy', () => {
  it('classifies every stablecoin-tagged base and every fiat quote asset, and nothing else', () => {
    const policy = policyFrom(PRODUCT_ROWS);
    expect(sortedBases(policy)).toEqual(['EUR', 'FDUSD', 'RLUSD', 'TRY', 'USDC', 'USDE']);
  });

  it('classifies EUR from the fiat rows quote side, not from its own empty tags', () => {
    // EURUSDT's own tags are []; only ADAEUR/AVAXEUR's `q` says EUR is fiat. Dropping those two rows must drop EUR.
    const withoutFiatRows = PRODUCT_ROWS.filter((r) => r.pm !== 'FIAT' && r.pn !== 'FIAT');
    expect(withoutFiatRows.some((r) => r.s === 'EURUSDT')).toBe(true);
    expect(sortedBases(policyFrom(withoutFiatRows))).not.toContain('EUR');
    expect(sortedBases(policyFrom(PRODUCT_ROWS))).toContain('EUR');
  });

  it('never classifies the BASE of a fiat row', () => {
    // ADAEUR and AVAXEUR are pm/pn FIAT rows whose bases are ordinary crypto. Reading `b` instead of `q` would veto both coins outright.
    const bases = sortedBases(policyFrom(PRODUCT_ROWS));
    expect(bases).not.toContain('ADA');
    expect(bases).not.toContain('AVAX');
    expect(bases).not.toContain('BTC');
    expect(bases).not.toContain('ETH');
  });

  it('classifies a base whose own pairing lacks the tag, from any other pairing that carries it', () => {
    // USDC is tagged on USDCUSDT. Strip the tag from that row and the USDCTRY row still carries it, so the base stays classified on every pairing.
    const rows = PRODUCT_ROWS.map((r) => (r.s === 'USDCUSDT' ? { ...r, tags: [] } : r));
    expect(sortedBases(policyFrom(rows))).toContain('USDC');
  });

  it('classifies a recased stablecoin tag, so a capitalisation change upstream is not a silent veto loss', () => {
    const recased = PRODUCT_ROWS.map((r) => ({
      ...r,
      tags: r.tags.map((tag) => (tag === 'stablecoin' ? 'Stablecoin' : tag)),
    }));
    expect(deriveAssetPolicy(recased).taggedStablecoinBases).toEqual(
      deriveAssetPolicy(PRODUCT_ROWS).taggedStablecoinBases,
    );
  });

  it('classifies a base named nowhere in the code, purely from the feed', () => {
    expect(sortedBases(policyFrom(PRODUCT_ROWS))).not.toContain('NEWSTAB');
    expect(sortedBases(policyFrom([...PRODUCT_ROWS, NEW_STABLECOIN_ROW]))).toContain('NEWSTAB');
  });

  it('ignores a non-TRADING row entirely, as a symbol and as a veto source', () => {
    // The feed publishes only TRADING products today, so no fixture row exercises
    // this branch. It still has to hold: a halted row describes a market
    // discovery could not enter, and counting its symbol would make the
    // completeness cross-check demand a live pairing that does not exist.
    const halted = {
      s: 'HALTEDUSDT',
      st: 'BREAK',
      b: 'HALTEDSTABLE',
      q: 'ZWL',
      pm: 'FIAT',
      pn: 'FIAT',
      tags: ['stablecoin'],
    };
    const policy = deriveAssetPolicy(projectProducts(productsPayload([...PRODUCT_ROWS, halted])));
    expect(policy.tradingSymbols.has('HALTEDUSDT')).toBe(false);
    expect(policy.taggedStablecoinBases.has('HALTEDSTABLE')).toBe(false);
    expect(policy.fiatQuoteAssets.has('ZWL')).toBe(false);
    expect(sortedBases(policy)).toEqual(sortedBases(policyFrom(PRODUCT_ROWS)));
  });

  it('requires pm AND pn to agree before reading a row as fiat', () => {
    // The conjunction is the guard against a single renamed field promoting an
    // ordinary market to fiat and vetoing its quote asset across the exchange.
    const halfMarked = [
      { s: 'ADAXAU', st: 'TRADING', b: 'ADA', q: 'XAU', pm: 'FIAT', pn: 'ALTS', tags: [] },
      { s: 'AVAXXAU', st: 'TRADING', b: 'AVAX', q: 'XAU', pm: 'ALTS', pn: 'FIAT', tags: [] },
    ];
    const policy = deriveAssetPolicy(projectProducts(productsPayload(halfMarked)));
    expect([...policy.fiatQuoteAssets]).toEqual([]);
    expect(policy.tradingSymbols.size).toBe(2);
  });

  it('records the feed TRADING symbol set for the completeness cross-check', () => {
    expect([...policyFrom(PRODUCT_ROWS).tradingSymbols].sort()).toEqual(
      PRODUCT_ROWS.map((r) => r.s).sort(),
    );
  });
});

describe('validateAssetPolicy', () => {
  it('accepts a policy that matches the live TRADING admission set exactly', () => {
    expect(() => validateAssetPolicy(policyFrom(PRODUCT_ROWS), liveAdmission())).not.toThrow();
  });

  it('aborts when the feed yielded no rows at all (schema drift)', () => {
    const drifted = projectProducts(productsPayload([{ symbol: 'BTCUSDT', status: 'TRADING' }]));
    expect(() => validateAssetPolicy(deriveAssetPolicy(drifted), liveAdmission())).toThrow(
      /no product rows/i,
    );
  });

  it('aborts when the feed classified nothing as stablecoin or fiat', () => {
    const ordinaryOnly = PRODUCT_ROWS.filter((r) => r.s === 'BTCUSDT' || r.s === 'ETHUSDT');
    expect(() =>
      validateAssetPolicy(policyFrom(ordinaryOnly), liveAdmission(ordinaryOnly)),
    ).toThrow(/stablecoin tag route classified nothing/i);
  });

  it('aborts when only the stablecoin tag route died, though the merged set is still non-empty', () => {
    // The exact shape a merged non-empty check cannot see: every row intact and still TRADING, every FIAT marker in place, only the tag spelling changed. The fiat route alone keeps the merged veto set populated, so a floor on the merge passes while every peg has silently become admissible.
    const tagRenamed = PRODUCT_ROWS.map((r) => ({
      ...r,
      tags: r.tags.map((tag) => (tag === 'stablecoin' ? 'peggedAsset' : tag)),
    }));
    const policy = policyFrom(tagRenamed);
    expect(policy.stablecoinOrFiatBases.size).toBeGreaterThan(0);
    expect(policy.taggedStablecoinBases.size).toBe(0);
    expect(() => validateAssetPolicy(policy, liveAdmission(tagRenamed))).toThrow(
      /stablecoin tag route classified nothing/i,
    );
  });

  it('aborts when only the fiat parent-market route died', () => {
    const fiatMarkersDropped = PRODUCT_ROWS.map((r) =>
      r.pm === 'FIAT' ? { ...r, pm: 'USDT', pn: 'USDT' } : r,
    );
    const policy = policyFrom(fiatMarkersDropped);
    expect(policy.stablecoinOrFiatBases.size).toBeGreaterThan(0);
    expect(policy.fiatQuoteAssets.size).toBe(0);
    expect(() => validateAssetPolicy(policy, liveAdmission(fiatMarkersDropped))).toThrow(
      /fiat parent-market route classified nothing/i,
    );
  });

  it('aborts when a live TRADING symbol has no product row', () => {
    const admission = liveAdmission();
    admission.set('SOLUSDT', { status: 'TRADING', baseAsset: 'SOL', quoteAsset: 'USDT' });
    expect(() => validateAssetPolicy(policyFrom(PRODUCT_ROWS), admission)).toThrow(
      /mismatch.*SOLUSDT|SOLUSDT.*mismatch/is,
    );
  });

  it('aborts when a product row has no live TRADING symbol', () => {
    const admission = liveAdmission();
    admission.delete('ETHUSDT');
    expect(() => validateAssetPolicy(policyFrom(PRODUCT_ROWS), admission)).toThrow(
      /mismatch.*ETHUSDT|ETHUSDT.*mismatch/is,
    );
  });

  it('aborts on an empty admission map rather than admitting the whole universe', () => {
    expect(() =>
      validateAssetPolicy(policyFrom(PRODUCT_ROWS), new Map<string, SymbolAdmission>()),
    ).toThrow(/empty symbol-admission/i);
  });

  it('ignores a product symbol the bot cannot represent, rather than halting on it forever', () => {
    // Live right now: Binance lists CJK-tickered pairs, and the exchange-info refresh drops them from the admission map by this same SymbolName boundary. Demanding they appear there would abort every cycle on every wake, permanently, over a pair discovery could never bind.
    const withCjk = [
      ...PRODUCT_ROWS,
      { ...PRODUCT_ROWS[0], s: '\u5e01\u5b89\u4eba\u751fUSDT', b: '\u5e01\u5b89\u4eba\u751f' },
    ] as ProductRowFixture[];
    expect(() =>
      validateAssetPolicy(policyFrom(withCjk), liveAdmission(PRODUCT_ROWS)),
    ).not.toThrow();
  });

  it('does not require a product row for a live pair that is not TRADING', () => {
    // exchangeInfo keeps halted pairs with a non-TRADING status; the product feed only lists TRADING ones, so a BREAK pair absent from the feed is not a mismatch.
    const admission = liveAdmission();
    admission.set('HALTEDUSDT', { status: 'BREAK', baseAsset: 'HALTED', quoteAsset: 'USDT' });
    expect(() => validateAssetPolicy(policyFrom(PRODUCT_ROWS), admission)).not.toThrow();
  });

  it('cross-checks against the LIVE admission map, never a mode-scoped one', () => {
    // A test-mode wake still validates completeness against live exchangeInfo: the testnet universe is a different, smaller set, and validating against it would both miss live gaps and reject testnet-only pairs the feed never lists.
    const testModeAdmission = liveAdmission([PRODUCT_ROWS[0] as ProductRowFixture]);
    testModeAdmission.set('TESTONLYUSDT', {
      status: 'TRADING',
      baseAsset: 'TESTONLY',
      quoteAsset: 'USDT',
    });
    expect(() => validateAssetPolicy(policyFrom(PRODUCT_ROWS), liveAdmission())).not.toThrow();
    expect(() => validateAssetPolicy(policyFrom(PRODUCT_ROWS), testModeAdmission)).toThrow(
      /mismatch/i,
    );
  });
});

describe('createAssetPolicyResolver', () => {
  const resolverWith = (
    fetchImpl: ReturnType<typeof vi.fn>,
    clock: ReturnType<typeof fakeClock>,
  ): (() => Promise<ReturnType<typeof deriveAssetPolicy>>) =>
    createAssetPolicyResolver({ fetchImpl, clock, logger: noopLogger() });

  const okFetch = (payloads: readonly unknown[]): ReturnType<typeof vi.fn> => {
    let i = 0;
    return vi.fn(async () => okResponse(payloads[Math.min(i++, payloads.length - 1)]));
  };

  it('refuses a body whose declared size is past the ceiling, before parsing it', async () => {
    // Node's fetch has no built-in body cap, so without this the allocation size
    // is the upstream's choice. The rejection has to happen on the header, not
    // after `json()`, or the ceiling costs the very memory it exists to bound.
    const json = vi.fn(async () => productsPayload(PRODUCT_ROWS));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-length': String(64 * 1024 * 1024) }),
      json,
    }));
    await expect(resolverWith(fetchImpl, fakeClock())()).rejects.toThrow(/exceeds .*B/);
    expect(json).not.toHaveBeenCalled();
  });

  it('accepts a body whose declared size is within the ceiling', async () => {
    // The other half of the boundary: a real payload declares a content-length
    // too, and a ceiling that rejected it would take the whole feed offline.
    const fetchImpl = vi.fn(async () =>
      okResponse(productsPayload(PRODUCT_ROWS), { 'content-length': String(645 * 1024) }),
    );
    await expect(resolverWith(fetchImpl, fakeClock())()).resolves.toBeDefined();
  });

  it('aborts a hung request at the timeout instead of stalling the wake', async () => {
    // The likeliest real failure on an unauthenticated public endpoint is a
    // request that neither answers nor fails. Nothing else here would notice:
    // the cron would simply stop rotating, silently, for as long as it hung.
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(new Error('The operation was aborted.')),
            );
          }),
      );
      const pending = resolverWith(fetchImpl, fakeClock())();
      const assertion = expect(pending).rejects.toThrow(/aborted/i);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests the product feed with redirects refused and an abort signal armed', async () => {
    const fetchImpl = okFetch([productsPayload(PRODUCT_ROWS)]);
    await resolverWith(fetchImpl, fakeClock())();
    expect(fetchImpl).toHaveBeenCalledWith(
      PRODUCTS_URL,
      expect.objectContaining({ redirect: 'error' }),
    );
    const init = fetchImpl.mock.calls[0]?.[1] as { signal?: unknown };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('stamps freshness from a clock read taken AFTER the load resolves', async () => {
    // The clock jumps ten minutes DURING the fetch. Stamped before the await, the snapshot is born ten minutes stale: the resolver either rejects immediately or refetches on the very next call. Stamped after, it is fresh — and this fake is the only thing that tells the two apart, since a clock that never moves during the fetch makes the elapsed time trivially zero.
    const clock = fakeClock();
    const fetchImpl = vi.fn(async () => {
      clock.advance(10 * MINUTE_MS);
      return okResponse(productsPayload(PRODUCT_ROWS));
    });
    const getAssetPolicy = resolverWith(fetchImpl, clock);

    const first = await getAssetPolicy();
    expect(sortedBases(first)).toContain('RLUSD');

    await getAssetPolicy();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fetches at most once per wake, however many profiles are due', async () => {
    const fetchImpl = okFetch([productsPayload(PRODUCT_ROWS)]);
    const getAssetPolicy = resolverWith(fetchImpl, fakeClock());
    await getAssetPolicy();
    await getAssetPolicy();
    await getAssetPolicy();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('serves concurrent callers one fetch, so the cron and the diagnosis probe cannot classify differently', async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn(async () => okResponse(productsPayload(PRODUCT_ROWS)));
    const resolve = createAssetPolicyResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock,
      logger: noopLogger(),
    });
    const [a, b] = await Promise.all([resolve(), resolve()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('reuses a snapshot up to the last millisecond of its max age', async () => {
    // Both boundary cases read the constant rather than restating it, so raising
    // or lowering the max age moves the pins with it instead of leaving two
    // literals asserting a window the code no longer has.
    const clock = fakeClock();
    const fetchImpl = okFetch([productsPayload(PRODUCT_ROWS)]);
    const getAssetPolicy = resolverWith(fetchImpl, clock);
    await getAssetPolicy();
    clock.advance(SNAPSHOT_MAX_AGE_MS - 1);
    await getAssetPolicy();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refetches the moment the snapshot reaches its max age', async () => {
    const clock = fakeClock();
    const fetchImpl = okFetch([productsPayload(PRODUCT_ROWS)]);
    const getAssetPolicy = resolverWith(fetchImpl, clock);
    await getAssetPolicy();
    clock.advance(SNAPSHOT_MAX_AGE_MS);
    await getAssetPolicy();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('picks up a newly classified base on the refresh, with no code change', async () => {
    const clock = fakeClock();
    const fetchImpl = okFetch([
      productsPayload(PRODUCT_ROWS),
      productsPayload([...PRODUCT_ROWS, NEW_STABLECOIN_ROW]),
    ]);
    const getAssetPolicy = resolverWith(fetchImpl, clock);
    expect(sortedBases(await getAssetPolicy())).not.toContain('NEWSTAB');
    clock.advance(5 * MINUTE_MS);
    expect(sortedBases(await getAssetPolicy())).toContain('NEWSTAB');
  });

  it('propagates a failed refresh instead of serving the stale snapshot', async () => {
    const clock = fakeClock();
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return okResponse(productsPayload(PRODUCT_ROWS));
      throw new Error('upstream boom');
    });
    const getAssetPolicy = resolverWith(fetchImpl, clock);
    await getAssetPolicy();
    clock.advance(5 * MINUTE_MS);
    await expect(getAssetPolicy()).rejects.toThrow(/boom/);
    // Still no stale service on the following call, and no silent fallback to the cached snapshot.
    await expect(getAssetPolicy()).rejects.toThrow(/boom/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects a non-ok upstream response', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({}),
    }));
    await expect(resolverWith(fetchImpl, fakeClock())()).rejects.toThrow(/503/);
  });
});
