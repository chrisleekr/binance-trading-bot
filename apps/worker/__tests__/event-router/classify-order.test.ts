import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { asAccountId, asProfileId, asUserId, type ProfileId } from '@app/contracts';
import { AccountNotOwnedError, ProfileNotOwnedError } from '@app/db';

import { createClassifyOrder } from '../../src/event-router/classify-order.js';
import { createPlacementOwner } from '../../src/executor/placement-owner.js';
import { buildPlacementOwnerKey } from '../../src/executor/redis-namespace.js';
import { fakeDb, silentLogger } from '../boot/builders/fakes.js';

// The gate resolves its repos through `accountRepo` / `profileRepo`, both of which run a live ownership query. Only those two are stubbed; the rest of `@app/db` stays real so the error classes the fail-safe branch does `instanceof` against are the genuine ones.
const state = {
  // The account-domain `orders` row for the id under test, or null when nothing has committed.
  orderRow: null as { profileId: string | null } | null,
  // Every profile on the shared account, in the order `listForAccount` yields them. Includes disabled rows, exactly as the repo does.
  profileIds: ['p1', 'p2'],
  // The subset the account's user-data stream is actually routed to. Separate from `profileIds` on purpose: only these can receive a report, so only these can adopt a fill.
  activeProfileIds: ['p1', 'p2'],
  // The symbols the asking profile is subscribed to. Only the no-evidence fallthrough reads this, and only to decide whether adopting would tick a coin the profile does not trade.
  boundSymbols: ['BTCUSDT'],
  // The profile owning a matching `manual_orders` row, or null when no profile does.
  manualOwner: null as string | null,
  // Makes the ownership resolve fail, so the fail-safe branch is reachable. An Error value is thrown as-is, which is how the quiet-suppression arm is reached with the real error classes.
  lookupThrows: false as boolean | Error,
};

vi.mock('@app/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@app/db')>()),
  accountRepo: () => {
    if (state.lookupThrows)
      return Promise.reject(
        state.lookupThrows instanceof Error ? state.lookupThrows : new Error('connection lost'),
      );
    return Promise.resolve({
      orders: { findByBinanceOrderId: () => Promise.resolve(state.orderRow) },
      profiles: {
        listForAccount: () => Promise.resolve(state.profileIds.map((id) => ({ id }))),
      },
    });
  },
  profileRepo: (_db: unknown, _operatorId: unknown, _accountId: unknown, id: string) =>
    Promise.resolve({
      manualOrders: {
        findByBinanceOrderId: () =>
          Promise.resolve(state.manualOwner === id ? { id: 'manual-1' } : null),
      },
    }),
}));

const OPERATOR = asUserId('u1');
const ACCOUNT = asAccountId('a1');
const P1 = asProfileId('p1');
const P2 = asProfileId('p2');
const SYMBOL = 'BTCUSDT';
const BINANCE_ORDER_ID = 4242;
const CLIENT_ORDER_ID = 'co-4242';
// Minted through the same builder the placement path writes with, never a literal: two independently-hardcoded keys that happen to agree would still let writer and reader drift.
const MARKER_KEY = buildPlacementOwnerKey(ACCOUNT, CLIENT_ORDER_ID);

// Byte-exact key lookup: a marker read that misses answers null, exactly as Redis would, so a gate that consults the wrong key reads as "no marker" instead of silently passing.
//
// `set` carries the NX semantics the warning throttle rides on, over the same store. A Redis without it makes the throttle fail open, and every warn assertion below would then be measuring the fail-open path rather than the throttle.
const makeRedis = (entries: Record<string, string> = {}): Redis => {
  const store = new Map<string, string>(Object.entries(entries));
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: string) => {
      if (store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve('OK');
    }),
  } as unknown as Redis;
};

const activeProfileIds = (): readonly ProfileId[] => state.activeProfileIds.map(asProfileId);
const isSymbolBound = (_profileId: ProfileId, symbol: string): boolean =>
  state.boundSymbols.includes(symbol);

const gate = (redis: Redis = makeRedis()) =>
  createClassifyOrder({
    db: fakeDb(),
    redis,
    logger: silentLogger(),
    activeProfileIds,
    isSymbolBound,
  });

beforeEach(() => {
  state.orderRow = null;
  state.profileIds = ['p1', 'p2'];
  state.activeProfileIds = ['p1', 'p2'];
  state.boundSymbols = ['BTCUSDT'];
  state.manualOwner = null;
  state.lookupThrows = false;
});

describe('createClassifyOrder', () => {
  it('returns own when the orders row names the asking profile', async () => {
    state.orderRow = { profileId: 'p2' };
    await expect(
      gate()(OPERATOR, ACCOUNT, P2, SYMBOL, BINANCE_ORDER_ID, CLIENT_ORDER_ID),
    ).resolves.toBe('own');
  });

  it('returns sibling when the orders row names a different profile', async () => {
    state.orderRow = { profileId: 'p1' };
    await expect(
      gate()(OPERATOR, ACCOUNT, P2, SYMBOL, BINANCE_ORDER_ID, CLIENT_ORDER_ID),
    ).resolves.toBe('sibling');
  });

  it('returns detached when the orders row has no profile', async () => {
    state.orderRow = { profileId: null };
    await expect(
      gate()(OPERATOR, ACCOUNT, P2, SYMBOL, BINANCE_ORDER_ID, CLIENT_ORDER_ID),
    ).resolves.toBe('detached');
  });

  // A committed row is the authoritative answer and the marker is only evidence about the window before it exists, so the row has to win even when a marker contradicts it. Arranged as a contradiction because agreement proves nothing: without it, hoisting the marker consult above the row lookup would leave every other case in this file green while a stale marker started overriding a committed row, including reporting a DETACHED order as adoptable.
  it.each([
    ['own', 'p2', 'p1', 'own'],
    ['sibling', 'p1', 'p2', 'sibling'],
    ['detached', null, 'p2', 'detached'],
  ])(
    'lets the orders row decide %s even when the marker contradicts it',
    async (_label, rowOwner, markerOwner, verdict) => {
      state.orderRow = { profileId: rowOwner };
      const redis = makeRedis({ [MARKER_KEY]: markerOwner });
      await expect(
        gate(redis)(OPERATOR, ACCOUNT, P2, SYMBOL, BINANCE_ORDER_ID, CLIENT_ORDER_ID),
      ).resolves.toBe(verdict);
    },
  );

  // The no-evidence branch answers identically for EVERY profile on the account, so the verdict has to turn on whether there is a sibling to corrupt. With one profile there is nobody to leak into and adopting keeps the operator's hand-placed fill in the position state that mirrors their wallet; with two, `own` would tell both of them to adopt the same fill, which is the corruption this gate exists to prevent.
  //
  // The third case is the one a row count gets wrong. `listForAccount` returns disabled rows too, and a profile that is not being routed cannot receive this report, so counting it would drop the fill of the only profile that trades.
  it.each([
    ['adopts', ['p2'], ['p2'], 'own'],
    ['drops', ['p1', 'p2'], ['p1', 'p2'], 'sibling'],
    ['adopts', ['p1', 'p2'], ['p2'], 'own'],
  ])(
    '%s a report nothing names an owner for, by whether a sibling is actually being routed',
    async (_label, profileIds, active, verdict) => {
      state.profileIds = profileIds;
      state.activeProfileIds = active;
      await expect(
        gate()(OPERATOR, ACCOUNT, P2, SYMBOL, BINANCE_ORDER_ID, CLIENT_ORDER_ID),
      ).resolves.toBe(verdict);
    },
  );

  // The sole-profile carve-out adopts, which enqueues a tick, and `enqueue` has no binding check of its own. On a symbol the profile does not trade that writes a `symbol_states` row and an operator-visible `condition_states` blocker for a coin it will never tick again, which is the exact shape migration 0094 purges. Without the binding test the purge does not survive the operator's next hand-placed order. Both directions asserted over one arrangement: the bound symbol still adopts, so this pins the carve-out rather than disabling it.
  it.each([
    ['adopts', 'BTCUSDT', 'own'],
    ['drops', 'DOGEUSDT', 'sibling'],
    // A symbol the profile does trade is unaffected.
  ])(
    '%s an unowned report by whether the profile is bound to the symbol',
    async (_label, symbol, verdict) => {
      state.profileIds = ['p2'];
      state.activeProfileIds = ['p2'];
      state.boundSymbols = ['BTCUSDT'];
      await expect(
        gate()(OPERATOR, ACCOUNT, P2, symbol, BINANCE_ORDER_ID, CLIENT_ORDER_ID),
      ).resolves.toBe(verdict);
    },
  );

  // `disable` deletes from the active set synchronously, while the callbacks the same report fanned out to are still suspended on the lookups above, so the removed profile and the survivor both read the same post-removal set. A size-only check answers "sole profile on the account" to BOTH and the one hand-placed fill is adopted twice, which is the corruption this gate exists to prevent. Asserted as a pair over one arrangement: either verdict on its own is satisfied by a gate that always answers the same way.
  it('lets only the profile still being routed adopt when a sibling leaves mid-report', async () => {
    state.profileIds = ['p1', 'p2'];
    state.activeProfileIds = ['p2'];
    await expect(
      gate()(OPERATOR, ACCOUNT, P1, SYMBOL, BINANCE_ORDER_ID, CLIENT_ORDER_ID),
    ).resolves.toBe('sibling');
    await expect(
      gate()(OPERATOR, ACCOUNT, P2, SYMBOL, BINANCE_ORDER_ID, CLIENT_ORDER_ID),
    ).resolves.toBe('own');
  });

  // This branch decides on the ABSENCE of evidence, and it is the branch the incident came out of. It is also the only signal that the marker path has stopped working, meaning Redis down, a lapsed TTL, or an id the keyspace cannot use, so it must never be silent (CLAUDE.md: no silent failures). Pinned to the fallthrough alone: the arms that resolve a positive owner stay quiet.
  it('warns when nothing names an owner', async () => {
    const warn = vi.fn();
    const logger = { ...silentLogger(), warn } as unknown as Logger;
    const classify = createClassifyOrder({
      db: fakeDb(),
      redis: makeRedis(),
      logger,
      activeProfileIds,
      isSymbolBound,
    });

    await expect(
      classify(OPERATOR, ACCOUNT, P2, SYMBOL, BINANCE_ORDER_ID, CLIENT_ORDER_ID),
    ).resolves.toBe('sibling');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: OPERATOR,
        accountId: ACCOUNT,
        profileId: P2,
        binanceOrderId: BINANCE_ORDER_ID,
        clientOrderId: CLIENT_ORDER_ID,
      }),
      expect.stringContaining('names an owner'),
    );
    // The benign cause is named BEFORE the fault causes: an operator's hand-placed order lands here too, and a message that reads as a fault first teaches the operator to ignore the one occurrence that says the isolation control is disarmed.
    const message = String(warn.mock.calls[0]?.[1]);
    expect(message).toContain('placed by hand');
    expect(message.indexOf('placed by hand')).toBeLessThan(message.indexOf('lost marker'));
  });

  // One hand-placed order emits a NEW, its TRADE partials and a terminal report, and every profile on the account receives all of them, so the unthrottled line is roughly 3-4 per profile per order. Keyed per (account, order) rather than per profile, which is why the second call here asks as a DIFFERENT profile: a per-profile key would let each sibling log the same order again.
  it('logs the same unowned order once across the whole fan-out', async () => {
    const warn = vi.fn();
    const logger = { ...silentLogger(), warn } as unknown as Logger;
    const redis = makeRedis();
    const classify = createClassifyOrder({
      db: fakeDb(),
      redis,
      logger,
      activeProfileIds,
      isSymbolBound,
    });

    await classify(OPERATOR, ACCOUNT, P2, SYMBOL, BINANCE_ORDER_ID, CLIENT_ORDER_ID);
    await classify(OPERATOR, ACCOUNT, P1, SYMBOL, BINANCE_ORDER_ID, CLIENT_ORDER_ID);
    expect(warn).toHaveBeenCalledTimes(1);

    // A different order is new information, not a repeat of the suppressed one.
    await classify(OPERATOR, ACCOUNT, P2, SYMBOL, BINANCE_ORDER_ID + 1, CLIENT_ORDER_ID);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  // Binance order ids are unique per SYMBOL, not per account, which is the fact `orderCommissionKey` is already shaped around. Keyed on (account, order) alone, the second symbol's order collapses onto the first one's window and logs nothing, and this line is the only signal that the marker path has stopped working. Same numeric id on purpose: any key that carries the symbol passes, any key that does not fails.
  it('logs an unowned order on a second symbol that reuses the numeric order id', async () => {
    const warn = vi.fn();
    const logger = { ...silentLogger(), warn } as unknown as Logger;
    const classify = createClassifyOrder({
      db: fakeDb(),
      redis: makeRedis(),
      logger,
      activeProfileIds,
      isSymbolBound,
    });

    await classify(OPERATOR, ACCOUNT, P2, 'BTCUSDT', BINANCE_ORDER_ID, CLIENT_ORDER_ID);
    await classify(OPERATOR, ACCOUNT, P2, 'ETHUSDT', BINANCE_ORDER_ID, CLIENT_ORDER_ID);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  // All three positive-owner arms, including the MARKER arm this MR adds — without that third case a warn added inside the marker arm leaves every test green, and the arm this change exists to introduce would be the one that is unpinned.
  it.each([
    ['the orders row names it', () => (state.orderRow = { profileId: 'p2' }), makeRedis()],
    ['a manual order names it', () => (state.manualOwner = 'p2'), makeRedis()],
    [
      'the placement marker names it',
      () => undefined,
      makeRedis({ [buildPlacementOwnerKey(ACCOUNT, CLIENT_ORDER_ID)]: 'p2' }),
    ],
  ])('stays quiet when %s', async (_label, arrange, redis) => {
    arrange();
    const warn = vi.fn();
    const logger = { ...silentLogger(), warn } as unknown as Logger;

    await expect(
      createClassifyOrder({ db: fakeDb(), redis, logger, activeProfileIds, isSymbolBound })(
        OPERATOR,
        ACCOUNT,
        P2,
        SYMBOL,
        BINANCE_ORDER_ID,
        CLIENT_ORDER_ID,
      ),
    ).resolves.toBe('own');
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns own when the asking profile owns the matching manual order', async () => {
    state.manualOwner = 'p2';
    await expect(
      gate()(OPERATOR, ACCOUNT, P2, SYMBOL, BINANCE_ORDER_ID, CLIENT_ORDER_ID),
    ).resolves.toBe('own');
  });

  it('returns sibling when another profile owns the matching manual order', async () => {
    state.manualOwner = 'p1';
    await expect(
      gate()(OPERATOR, ACCOUNT, P2, SYMBOL, BINANCE_ORDER_ID, CLIENT_ORDER_ID),
    ).resolves.toBe('sibling');
  });

  // Fail-open, not fail-safe, for THIS read specifically: a marker the gate cannot reach leaves it on the verdict it gave before markers existed, rather than dropping every report on the account for as long as Redis is unwell. Arranged so a manual order names the asking profile, because that is a verdict only the arms AFTER the marker consult can produce: a marker fault that aborted the gate would answer `sibling` instead.
  it('falls back to the pre-marker verdict when the marker read fails', async () => {
    state.manualOwner = 'p2';
    const redis = {
      get: () => Promise.reject(new Error('CONNRESET')),
      set: () => Promise.resolve('OK'),
    } as unknown as Redis;
    await expect(
      gate(redis)(OPERATOR, ACCOUNT, P2, SYMBOL, BINANCE_ORDER_ID, CLIENT_ORDER_ID),
    ).resolves.toBe('own');
  });

  // An empty clientOrderId is one shared key for every report Binance sent without `c`, so the gate must not read it at all: a marker written by ANY profile would otherwise answer for all of them. Proven by planting exactly that key and showing the verdict ignores it. The account is given a single profile so the no-evidence fallthrough answers `own`, which the planted marker naming `p1` could not produce.
  it('ignores the marker keyspace entirely when the report carries no clientOrderId', async () => {
    state.profileIds = ['p2'];
    state.activeProfileIds = ['p2'];
    const redis = makeRedis({ [buildPlacementOwnerKey(ACCOUNT, '')]: 'p1' });
    await expect(gate(redis)(OPERATOR, ACCOUNT, P2, SYMBOL, BINANCE_ORDER_ID, '')).resolves.toBe(
      'own',
    );
  });

  it('returns sibling when the ownership lookup fails, so a foreign fill is never adopted', async () => {
    state.lookupThrows = true;
    await expect(
      gate()(OPERATOR, ACCOUNT, P2, SYMBOL, BINANCE_ORDER_ID, CLIENT_ORDER_ID),
    ).resolves.toBe('sibling');
  });

  // An ownership error is not a fault, it is the answer: the profile was deleted or moved between the report and the lookup, and the stream fans one report out to every profile on the account, so warning would emit noise on every sibling for a routine race. The verdict still has to be the fail-safe one.
  it.each([
    ['ProfileNotOwnedError', () => new ProfileNotOwnedError(OPERATOR, ACCOUNT, P2)],
    ['AccountNotOwnedError', () => new AccountNotOwnedError(OPERATOR, ACCOUNT)],
  ])('drops the report QUIETLY when the lookup throws %s', async (_label, mkErr) => {
    state.lookupThrows = mkErr();
    const warn = vi.fn();
    const logger = { ...silentLogger(), warn } as unknown as Logger;

    const verdict = await createClassifyOrder({
      db: fakeDb(),
      redis: makeRedis(),
      logger,
      activeProfileIds,
      isSymbolBound,
    })(OPERATOR, ACCOUNT, P2, SYMBOL, BINANCE_ORDER_ID, CLIENT_ORDER_ID);

    expect(verdict).toBe('sibling');
    expect(warn).not.toHaveBeenCalled();
  });

  // The report lands before the placing profile's `orders` row commits, so the row lookup misses for everyone. Without a positive owner the gate can only fall back to a guess, which is how a profile bound to four BTC symbols acquired state for symbols it never traded. The placement marker is the only evidence of ownership in that window.
  it('returns sibling when no orders row exists and marker-names-sibling', async () => {
    const redis = makeRedis({ [MARKER_KEY]: 'p1' });
    await expect(
      gate(redis)(OPERATOR, ACCOUNT, P2, SYMBOL, BINANCE_ORDER_ID, CLIENT_ORDER_ID),
    ).resolves.toBe('sibling');
  });
});

// Producer and consumer meeting through real code on BOTH ends. The gate is only armed if the bytes the placement path writes are the bytes the gate reads, and every test that stubs one side alone stays green when they diverge, so this one runs the real `register` and the real gate over ONE Redis, with no key named anywhere in the test.
describe('placement marker, written by the executor and read by the gate', () => {
  const inMemoryRedis = (): Redis => {
    const store = new Map<string, string>();
    return {
      set: (key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve('OK');
      },
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
    } as unknown as Redis;
  };

  it('tells a sibling to drop an order whose row has not committed', async () => {
    const redis = inMemoryRedis();
    const logger = silentLogger();
    await createPlacementOwner({ redis, logger }).register(ACCOUNT, P1, CLIENT_ORDER_ID);

    const verdict = await createClassifyOrder({
      db: fakeDb(),
      redis,
      logger,
      activeProfileIds,
      isSymbolBound,
    })(OPERATOR, ACCOUNT, P2, SYMBOL, BINANCE_ORDER_ID, CLIENT_ORDER_ID);

    expect(verdict).toBe('sibling');
  });

  it('tells the placing profile the order is its own before the row commits', async () => {
    const redis = inMemoryRedis();
    const logger = silentLogger();
    await createPlacementOwner({ redis, logger }).register(ACCOUNT, P1, CLIENT_ORDER_ID);
    // Without the marker this arrangement resolves to `sibling`, because P2 holds the matching manual order, so `own` can only come from the marker.
    state.manualOwner = 'p2';

    const verdict = await createClassifyOrder({
      db: fakeDb(),
      redis,
      logger,
      activeProfileIds,
      isSymbolBound,
    })(OPERATOR, ACCOUNT, P1, SYMBOL, BINANCE_ORDER_ID, CLIENT_ORDER_ID);

    expect(verdict).toBe('own');
  });
});
