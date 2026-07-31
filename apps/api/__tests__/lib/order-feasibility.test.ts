import { asProfileId, asUserId } from '@app/contracts';
import { GLOBAL_KEYS, profileKey, type ProfileRepo } from '@app/db';
import type { AnyStrategy } from '@app/strategy-core';
import { TTConfigSchema, trailingTrade } from '@app/strategy-trailing-trade';
import { describe, expect, it } from 'vitest';

import type { DI } from '../../src/di.js';
import {
  assertOrderFeasible,
  assertOrderFeasibleForProfile,
  orderFeasibilityDiagnostics,
  withDiagnostics,
} from '../../src/lib/order-feasibility.js';

const U = asUserId('00000000-0000-0000-0000-000000000001');
const P = asProfileId('00000000-0000-0000-0000-000000000002');

const SYM_KEY = GLOBAL_KEYS.symbolInfo('BTCUSDT');
const TICKER_KEY = GLOBAL_KEYS.ticker('BTCUSDT');

const symbolInfo = JSON.stringify({
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minNotional: '10',
    tickSize: '0.01',
    stepSize: '0.0001',
    minQty: '0.001',
    maxQty: '9000',
    minPrice: '0.01',
    maxPrice: '1000000',
  },
});
const ticker = JSON.stringify({ price: '100', ts: 1 });

const makeDi = (store: Record<string, string>): DI =>
  ({
    redis: { raw: () => ({ get: async (key: string) => store[key] ?? null }) },
    strategies: {
      describeForProfile: (name: string) =>
        name === 'trailing-trade'
          ? { status: 'current', strategy: trailingTrade }
          : { status: 'unknown', name },
    },
  }) as unknown as DI;

interface Ledger {
  symbol: string;
  avgEntryPrice: string;
  quantity: string;
}

const fakeP = (symbols: string[], ledger: Ledger[] = []): ProfileRepo =>
  ({
    scope: { userId: U, profileId: P },
    profileSymbols: { listForProfile: async () => symbols.map((symbol) => ({ symbol })) },
    avgEntryPrices: {
      findBySymbols: async (syms: readonly string[]) =>
        ledger.filter((l) => syms.includes(l.symbol)),
    },
  }) as unknown as ProfileRepo;

const cfg = (over: Record<string, unknown>): unknown =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '20' }, ...over },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
  });

// A 3-level grid of 20 quote each: total 60. Level 0 trigger must be 1, deeper <1.
const gridConfig = cfg({
  gridLevels: [
    { triggerPercentage: '1', maxPurchaseAmount: '20' },
    { triggerPercentage: '0.97', maxPurchaseAmount: '20' },
    { triggerPercentage: '0.95', maxPurchaseAmount: '20' },
  ],
});
// A single fixed entry sized below minNotional (5 < 10) — balance-independent block.
const subMinConfig = cfg({ entrySizing: { mode: 'fixed', amount: '5' } });

const LIVE = { [SYM_KEY]: symbolInfo, [TICKER_KEY]: ticker };

// A store where ONLY the testnet symbol-info keyspace is populated. A live-mode
// read misses it entirely (symbol reported as unchecked); a test-mode read must
// reach it.
const TEST_SYM_KEY = GLOBAL_KEYS.symbolInfo('BTCUSDT', 'test');
const TEST_ONLY = { [TEST_SYM_KEY]: symbolInfo, [TICKER_KEY]: ticker };

const ACCOUNT_KEY = profileKey({ userId: U, profileId: P }, 'accountInfo');
// Balances snapshot: `free`/`locked` per asset, as the worker writes it.
const account = (balances: Record<string, { free: string; locked: string }>): string =>
  JSON.stringify({ balances });

describe('orderFeasibilityDiagnostics', () => {
  it('does NOT run the full-grid funding check on the live path (no override)', async () => {
    // Grid totals 60; without a clean starting balance the funding check must not
    // fire, so a running/invested profile can still be checked without a false block.
    expect(
      await orderFeasibilityDiagnostics(
        makeDi(LIVE),
        fakeP(['BTCUSDT']),
        trailingTrade,
        gridConfig,
        { mode: 'live' },
      ),
    ).toEqual([]);
  });

  it('still enforces per-order minimums on the live path', async () => {
    const diags = await orderFeasibilityDiagnostics(
      makeDi(LIVE),
      fakeP(['BTCUSDT']),
      trailingTrade,
      subMinConfig,
      { mode: 'live' },
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ level: 'block', code: 'order-below-min-notional' });
    expect(diags[0]?.message).toMatch(/^BTCUSDT: /);
  });

  it('runs the funding check against availableQuoteOverride (backtest balance)', async () => {
    const diags = await orderFeasibilityDiagnostics(
      makeDi(LIVE),
      fakeP([]),
      trailingTrade,
      gridConfig,
      {
        symbols: ['BTCUSDT'],
        availableQuoteOverride: '50',
        mode: 'live',
      },
    );
    expect(diags.map((d) => d.code)).toEqual(['grid-underfunded']);
    expect(diags[0]?.message).toContain('2 of 3');
  });

  it('is clean when the override funds the full grid', async () => {
    const diags = await orderFeasibilityDiagnostics(
      makeDi(LIVE),
      fakeP(['BTCUSDT']),
      trailingTrade,
      gridConfig,
      {
        availableQuoteOverride: '100000',
      },
    );
    expect(diags).toEqual([]);
  });

  it('reports a symbol with no filters or price snapshot as unchecked, not clean', async () => {
    // An empty result is read downstream as "checked and fine" and admits the
    // save with zero validation behind it, so "could not check" must be visible.
    const diags = await orderFeasibilityDiagnostics(
      makeDi({}),
      fakeP(['BTCUSDT']),
      trailingTrade,
      gridConfig,
      { mode: 'live' },
    );
    // With BOTH halves missing the filters guard wins: one unreadable symbol
    // yields one finding, not two overlapping ones. Pins the guard ordering.
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ level: 'warn', code: 'filters-unavailable' });
  });

  it('names the symbol, the mode, and the unverified sizing when filters are missing', async () => {
    const diags = await orderFeasibilityDiagnostics(
      makeDi({ [TICKER_KEY]: ticker }),
      fakeP(['BTCUSDT']),
      trailingTrade,
      gridConfig,
      { mode: 'live' },
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ level: 'warn', code: 'filters-unavailable' });
    // The operator has to be able to tell WHICH symbol on WHICH exchange went
    // unchecked; a bare code cannot be acted on.
    expect(diags[0]?.message).toMatch(/^BTCUSDT: /);
    expect(diags[0]?.message).toMatch(/\bLive\b/);
    expect(diags[0]?.message).toMatch(/not verified/i);
  });

  it('reports filters-unavailable when the symbol-info snapshot is not JSON', async () => {
    const diags = await orderFeasibilityDiagnostics(
      makeDi({ [SYM_KEY]: 'not json', [TICKER_KEY]: ticker }),
      fakeP(['BTCUSDT']),
      trailingTrade,
      gridConfig,
      { mode: 'live' },
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ level: 'warn', code: 'filters-unavailable' });
  });

  it('reports filters-unavailable when the symbol-info snapshot has drifted', async () => {
    // Valid JSON, but the filters block the sizing check reads is gone — the
    // config is just as unchecked as if the key were absent.
    const diags = await orderFeasibilityDiagnostics(
      makeDi({ [SYM_KEY]: JSON.stringify({ quoteAsset: 'USDT' }), [TICKER_KEY]: ticker }),
      fakeP(['BTCUSDT']),
      trailingTrade,
      gridConfig,
      { mode: 'live' },
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ level: 'warn', code: 'filters-unavailable' });
  });

  it('reports price-unavailable when filters are readable but no price snapshot is', async () => {
    // Read through the testnet keyspace so the message must name the testnet
    // environment — a message hardcoded to "Live" would mislead here.
    const diags = await orderFeasibilityDiagnostics(
      makeDi({ [TEST_SYM_KEY]: symbolInfo }),
      fakeP(['BTCUSDT']),
      trailingTrade,
      gridConfig,
      { mode: 'test' },
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ level: 'warn', code: 'price-unavailable' });
    expect(diags[0]?.message).toMatch(/^BTCUSDT: /);
    expect(diags[0]?.message).toMatch(/\bTestnet\b/);
    expect(diags[0]?.message).not.toMatch(/\bLive\b/);
    expect(diags[0]?.message).toMatch(/not verified/i);
  });

  it('reports price-unavailable when the price snapshot is not JSON', async () => {
    const diags = await orderFeasibilityDiagnostics(
      makeDi({ [SYM_KEY]: symbolInfo, [TICKER_KEY]: 'not json' }),
      fakeP(['BTCUSDT']),
      trailingTrade,
      gridConfig,
      { mode: 'live' },
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ level: 'warn', code: 'price-unavailable' });
  });

  it('still checks the symbols it can read in a partly populated basket', async () => {
    // Only BTCUSDT has snapshots. ETHUSDT must be reported as unchecked without
    // costing the block that the readable symbol earns.
    const diags = await orderFeasibilityDiagnostics(
      makeDi(LIVE),
      fakeP(['BTCUSDT', 'ETHUSDT']),
      trailingTrade,
      subMinConfig,
      { mode: 'live' },
    );
    expect(diags).toContainEqual(
      expect.objectContaining({ level: 'block', code: 'order-below-min-notional' }),
    );
    const unavailable = diags.filter((d) => d.code === 'filters-unavailable');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]?.message).toMatch(/^ETHUSDT: /);
  });

  it('reports nothing unavailable when both snapshots are readable', async () => {
    const codes = (
      await orderFeasibilityDiagnostics(
        makeDi(LIVE),
        fakeP(['BTCUSDT']),
        trailingTrade,
        gridConfig,
        { mode: 'live' },
      )
    ).map((d) => d.code);
    expect(codes).not.toContain('filters-unavailable');
    expect(codes).not.toContain('price-unavailable');
  });

  it('reports nothing for a strategy without an order-feasibility check', async () => {
    // Nothing was skipped — there was nothing to check — so an empty keyspace
    // must not manufacture an unavailable warning.
    const noCheck = {
      ...trailingTrade,
      checkOrderFeasibility: undefined,
    } as unknown as AnyStrategy;
    expect(
      await orderFeasibilityDiagnostics(makeDi({}), fakeP(['BTCUSDT']), noCheck, gridConfig, {
        mode: 'live',
      }),
    ).toEqual([]);
  });

  it('reports nothing when the profile has no bound symbols', async () => {
    expect(
      await orderFeasibilityDiagnostics(makeDi({}), fakeP([]), trailingTrade, gridConfig, {
        mode: 'live',
      }),
    ).toEqual([]);
  });

  it('reads the test-mode symbol-info keyspace when mode is test', async () => {
    // Only the testnet keyspace holds filters. A live-default read would miss it
    // and report the symbol as unchecked; passing mode:'test' must reach the test
    // key and enforce the per-order minimum — proving the filters come from
    // testnet, not production.
    const diags = await orderFeasibilityDiagnostics(
      makeDi(TEST_ONLY),
      fakeP(['BTCUSDT']),
      trailingTrade,
      subMinConfig,
      { mode: 'test' },
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ level: 'block', code: 'order-below-min-notional' });
  });

  it('does not read the test keyspace on the default (live) path', async () => {
    // Same testnet-only store, but a live-mode check must not find the test key →
    // the symbol goes unchecked and is reported as such. Pins the keyspace
    // isolation: reaching the test key would have produced the sub-minimum
    // block, so its ABSENCE is what proves the live path never read it.
    const diags = await orderFeasibilityDiagnostics(
      makeDi(TEST_ONLY),
      fakeP(['BTCUSDT']),
      trailingTrade,
      subMinConfig,
      { mode: 'live' },
    );
    expect(diags.map((d) => d.code)).not.toContain('order-below-min-notional');
    expect(diags.map((d) => d.code)).toEqual(['filters-unavailable']);
  });

  it('funds the grid from account value: deployed cost basis covers a low free quote', async () => {
    // Grid needs 60. Free USDT is only 10 (a free-quote-only check would block),
    // but the ledger shows 0.5 base bought at 100 = 50 of committed capital.
    // Valued at COST BASIS (not the live mark), 10 + 50 = 60 → OK — and it stays
    // OK through a drawdown because cost basis does not move with price.
    const store = { ...LIVE, [ACCOUNT_KEY]: account({ USDT: { free: '10', locked: '0' } }) };
    expect(
      await orderFeasibilityDiagnostics(
        makeDi(store),
        fakeP(['BTCUSDT'], [{ symbol: 'BTCUSDT', avgEntryPrice: '100', quantity: '0.5' }]),
        trailingTrade,
        gridConfig,
        { fundFromAccountValue: true, mode: 'live' },
      ),
    ).toEqual([]);
  });

  it('counts locked quote toward account value', async () => {
    // Free USDT 10 + locked USDT 50 = 60, no position → funds the 60 grid. Pins
    // the `+ locked` term so a regression dropping it would fail here.
    const store = { ...LIVE, [ACCOUNT_KEY]: account({ USDT: { free: '10', locked: '50' } }) };
    expect(
      await orderFeasibilityDiagnostics(
        makeDi(store),
        fakeP(['BTCUSDT']),
        trailingTrade,
        gridConfig,
        {
          fundFromAccountValue: true,
          mode: 'live',
        },
      ),
    ).toEqual([]);
  });

  it('blocks when account value cannot fund the full grid', async () => {
    // Free USDT 10, no deployed position → value 10, funds 0 of 3 levels of 20.
    const store = { ...LIVE, [ACCOUNT_KEY]: account({ USDT: { free: '10', locked: '0' } }) };
    const diags = await orderFeasibilityDiagnostics(
      makeDi(store),
      fakeP(['BTCUSDT']),
      trailingTrade,
      gridConfig,
      { fundFromAccountValue: true, mode: 'live' },
    );
    expect(diags.map((d) => d.code)).toEqual(['grid-underfunded']);
    expect(diags[0]?.message).toContain('0 of 3');
  });

  it('lets availableQuoteOverride win over fundFromAccountValue when both are set', async () => {
    // Backtest override (clean balance) must take precedence over live account
    // value — an underfunded live snapshot is ignored when an override is given.
    const store = { ...LIVE, [ACCOUNT_KEY]: account({ USDT: { free: '1', locked: '0' } }) };
    expect(
      await orderFeasibilityDiagnostics(
        makeDi(store),
        fakeP(['BTCUSDT']),
        trailingTrade,
        gridConfig,
        {
          fundFromAccountValue: true,
          availableQuoteOverride: '100000',
          mode: 'live',
        },
      ),
    ).toEqual([]);
  });

  it('skips the funding check when fundFromAccountValue is set but no snapshot exists', async () => {
    // A profile never enabled has no account-info key: fund check is skipped for
    // lack of data (per-order minimums still run), so no false block.
    expect(
      await orderFeasibilityDiagnostics(
        makeDi(LIVE),
        fakeP(['BTCUSDT']),
        trailingTrade,
        gridConfig,
        {
          fundFromAccountValue: true,
          mode: 'live',
        },
      ),
    ).toEqual([]);
  });

  it('skips the funding check when a balance amount is malformed', async () => {
    // A present-but-drifted snapshot (schema-valid string, non-numeric amount)
    // must skip funding rather than throw or false-block.
    const store = {
      ...LIVE,
      [ACCOUNT_KEY]: account({ USDT: { free: 'not-a-number', locked: '0' } }),
    };
    expect(
      await orderFeasibilityDiagnostics(
        makeDi(store),
        fakeP(['BTCUSDT']),
        trailingTrade,
        gridConfig,
        {
          fundFromAccountValue: true,
          mode: 'live',
        },
      ),
    ).toEqual([]);
  });

  it('funds from cost basis alone when the quote asset is absent (free quote spent to zero)', async () => {
    // The motivating case: Binance omits a zero-balance asset, so the snapshot
    // has no USDT entry. The deployed cost basis (0.5 @ 120 = 60) alone funds the
    // 60 grid → no block. Pins the quote-asset-absent fallback to 0.
    const store = { ...LIVE, [ACCOUNT_KEY]: account({}) };
    expect(
      await orderFeasibilityDiagnostics(
        makeDi(store),
        fakeP(['BTCUSDT'], [{ symbol: 'BTCUSDT', avgEntryPrice: '120', quantity: '0.5' }]),
        trailingTrade,
        gridConfig,
        { fundFromAccountValue: true, mode: 'live' },
      ),
    ).toEqual([]);
  });

  it('skips the funding check when a ledger amount is malformed', async () => {
    // A drifted ledger row (non-numeric amount) throws inside the cost-basis
    // multiply; it must be caught and skip funding, not throw or false-block.
    const store = { ...LIVE, [ACCOUNT_KEY]: account({ USDT: { free: '10', locked: '0' } }) };
    expect(
      await orderFeasibilityDiagnostics(
        makeDi(store),
        fakeP(['BTCUSDT'], [{ symbol: 'BTCUSDT', avgEntryPrice: 'oops', quantity: '0.5' }]),
        trailingTrade,
        gridConfig,
        { fundFromAccountValue: true, mode: 'live' },
      ),
    ).toEqual([]);
  });
});

describe('assertOrderFeasible', () => {
  it('throws VALIDATION_FAILED when a block is found', async () => {
    await expect(
      assertOrderFeasible(makeDi(LIVE), fakeP(['BTCUSDT']), trailingTrade, subMinConfig, {
        mode: 'live',
      }),
    ).rejects.toThrow(/minimum order value/i);
  });

  it('reports nothing when the config is feasible', async () => {
    await expect(
      assertOrderFeasible(makeDi(LIVE), fakeP(['BTCUSDT']), trailingTrade, gridConfig, {
        mode: 'live',
      }),
    ).resolves.toEqual([]);
  });

  it('does not reject a live-mode save when the symbol could not be checked', async () => {
    // An unreadable snapshot is an advisory warn, not a block: a stale cache
    // must never 422 an otherwise valid config edit. It is still handed back so
    // the caller can tell the operator the save went in unverified.
    await expect(
      assertOrderFeasible(makeDi({}), fakeP(['BTCUSDT']), trailingTrade, subMinConfig, {
        mode: 'live',
      }),
    ).resolves.toEqual([expect.objectContaining({ level: 'warn', code: 'filters-unavailable' })]);
  });

  it('does not reject a test-mode save when the symbol could not be checked', async () => {
    // The live keyspace holds a snapshot that WOULD block this sub-minimum
    // config. A test-mode read must miss it and still resolve, so this pins the
    // mode routing and the non-blocking behaviour in one call.
    await expect(
      assertOrderFeasible(makeDi(LIVE), fakeP(['BTCUSDT']), trailingTrade, subMinConfig, {
        mode: 'test',
      }),
    ).resolves.toEqual([expect.objectContaining({ level: 'warn', code: 'filters-unavailable' })]);
  });

  it('keeps the routine no-price state off the save surface by default', async () => {
    // A config save checks every bound symbol, and an operator configuring a
    // profile that is not enabled yet can do nothing about any of them.
    const priceless = { [SYM_KEY]: symbolInfo };
    const diags = await orderFeasibilityDiagnostics(
      makeDi(priceless),
      fakeP(['BTCUSDT']),
      trailingTrade,
      gridConfig,
      { mode: 'live' },
    );
    // The settings-lint surface still receives it; only the save surface drops it.
    expect(diags.map((d) => d.code)).toEqual(['price-unavailable']);
    await expect(
      assertOrderFeasible(makeDi(priceless), fakeP(['BTCUSDT']), trailingTrade, gridConfig, {
        mode: 'live',
      }),
    ).resolves.toEqual([]);
  });

  it('reports the missing price when the caller opts in', async () => {
    // The add-symbol bind checks exactly one symbol, and that symbol is not
    // subscribed yet, so its sizing check is skipped every time. Silence there
    // would be a claim of verification the route can never honour.
    await expect(
      assertOrderFeasible(
        makeDi({ [SYM_KEY]: symbolInfo }),
        fakeP(['BTCUSDT']),
        trailingTrade,
        gridConfig,
        { mode: 'live', reportMissingPrice: true },
      ),
    ).resolves.toEqual([expect.objectContaining({ level: 'warn', code: 'price-unavailable' })]);
  });

  it('drops a plugin finding that spells a host code', async () => {
    // Plugin `code` and `message` reach the wire verbatim, and the host hands
    // plugins a wallet figure to size against, which the shipped strategy already
    // interpolates into its copy. Selecting by code would let any plugin put
    // arbitrary text on a body that is anonymously readable under the public
    // demo, so the selection is by provenance instead.
    const impostor = {
      ...trailingTrade,
      checkOrderFeasibility: () => [
        { level: 'warn' as const, code: 'filters-unavailable', message: 'balance is 1234' },
      ],
    } as unknown as AnyStrategy;
    const lint = await orderFeasibilityDiagnostics(
      makeDi(LIVE),
      fakeP(['BTCUSDT']),
      impostor,
      gridConfig,
      { mode: 'live' },
    );
    // It still reaches the authenticated settings-lint surface, so this is a
    // boundary rule and not a swallowed finding.
    expect(lint).toEqual([expect.objectContaining({ message: 'BTCUSDT: balance is 1234' })]);
    await expect(
      assertOrderFeasible(makeDi(LIVE), fakeP(['BTCUSDT']), impostor, gridConfig, {
        mode: 'live',
      }),
    ).resolves.toEqual([]);
  });

  it('carries no value beyond the four wire fields', async () => {
    // The findings ride back in a mutation response, and the public demo makes
    // every unguarded response anonymously readable. A fixed four-field
    // projection is what makes a credential-equivalent value impossible to
    // attach by construction, so pin the key set rather than trusting review.
    const diags = await assertOrderFeasible(
      makeDi({}),
      fakeP(['BTCUSDT']),
      trailingTrade,
      subMinConfig,
      { mode: 'live' },
    );
    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags) {
      expect(Object.keys(d).every((k) => ['level', 'code', 'message', 'path'].includes(k))).toBe(
        true,
      );
    }
  });
});

describe('assertOrderFeasibleForProfile', () => {
  const profile = { strategyName: 'trailing-trade', strategyVersion: '2.0.0' };

  it('resolves + parses then blocks an infeasible config', async () => {
    await expect(
      assertOrderFeasibleForProfile(
        makeDi(LIVE),
        fakeP(['BTCUSDT']),
        profile,
        subMinConfig,
        'live',
      ),
    ).rejects.toThrow(/minimum order value/i);
  });

  // Both branches below leave nothing to size against, so the check cannot run.
  // They used to return nothing at all, which the caller could not tell apart
  // from a config that passed every check.
  it('reports config-unverified for an unknown strategy', async () => {
    await expect(
      assertOrderFeasibleForProfile(
        makeDi(LIVE),
        fakeP(['BTCUSDT']),
        { strategyName: 'nope', strategyVersion: '1' },
        subMinConfig,
        'live',
      ),
    ).resolves.toEqual([expect.objectContaining({ level: 'warn', code: 'config-unverified' })]);
  });

  it('reports config-unverified when the raw config no longer parses', async () => {
    await expect(
      assertOrderFeasibleForProfile(
        makeDi(LIVE),
        fakeP(['BTCUSDT']),
        profile,
        { buy: 'not-a-config' },
        'live',
      ),
    ).resolves.toEqual([expect.objectContaining({ level: 'warn', code: 'config-unverified' })]);
  });

  // The mode is a REQUIRED positional the caller reads from the account row. It
  // used to be inferred from a `binanceMode` field on the profile argument —
  // which these tests satisfied by hand-building `{ ...profile, binanceMode }`,
  // a shape no production caller can produce, because the column lives on
  // `accounts` and not `profiles`. Every real call therefore resolved `live`,
  // and a testnet profile was validated against production filters. Passing the
  // mode explicitly is what makes these tests exercise the real call shape.
  it('routes the filter read to the testnet keyspace when the account is test-mode', async () => {
    await expect(
      assertOrderFeasibleForProfile(
        makeDi(TEST_ONLY),
        fakeP(['BTCUSDT']),
        profile,
        subMinConfig,
        'test',
      ),
    ).rejects.toThrow(/minimum order value/i);
  });

  it('a live-mode account does not reach the test keyspace', async () => {
    // Live mode against a testnet-only store → the test key is not read, the
    // symbol goes unchecked (an advisory warn), and the save is not blocked.
    // Pins keyspace isolation.
    await expect(
      assertOrderFeasibleForProfile(
        makeDi(TEST_ONLY),
        fakeP(['BTCUSDT']),
        profile,
        subMinConfig,
        'live',
      ),
    ).resolves.toEqual([expect.objectContaining({ level: 'warn', code: 'filters-unavailable' })]);
  });
});

describe('withDiagnostics', () => {
  it('omits the field entirely when there is nothing to report', () => {
    const body = { runId: 'r1', deduped: false };
    // Not `diagnostics: []`. Absence is what keeps a clean response identical to
    // what every existing client already parses.
    expect(withDiagnostics(body, [])).not.toHaveProperty('diagnostics');
    expect(withDiagnostics(body, [])).toEqual(body);
  });

  it('attaches a copy without mutating the body it was given', () => {
    const body = { runId: 'r1', deduped: false };
    const diags = [{ level: 'warn' as const, code: 'filters-unavailable', message: 'x' }];
    expect(withDiagnostics(body, diags)).toEqual({ ...body, diagnostics: diags });
    expect(body).not.toHaveProperty('diagnostics');
  });
});
