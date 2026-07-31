import { randomUUID } from 'node:crypto';
import { asAccountId, asProfileId, type AccountId, type UserId } from '@app/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  profileRepo,
  profileSymbols,
  SiblingQuoteConflictError,
  SymbolOwnershipConflictError,
} from '../../src/repo/index.js';
import * as schema from '../../src/schema/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

// One BASE ASSET is managed by at most one profile per Binance account
// (`profiles.account_id`). The base asset is the shared wallet line, so the
// guard subsumes the per-symbol check (two quote pairs over one base still
// collide). `profileSymbols.upsert` enforces it via `findOwningSiblingByBase`;
// these tests pin both the lookup and the guard. A different account (even one
// owned by the same operator, e.g. a live account) is a separate wallet, so the
// same base is allowed there.
describeIfDb('base-asset exclusivity per Binance account', () => {
  let fx: IsolationFixture;
  // Alice's primary profile (fixture default) hangs off her test account. Add a
  // same-account sibling, plus a second (live) account under Alice holding a
  // profile of its own.
  let sibTest: string;
  let aliceLiveAccount: string;
  let sibLive: string;
  const SYMBOL = 'AAAUSDT';
  const BASE = 'AAA';

  beforeEach(async () => {
    fx = await setupFixture();
    sibTest = randomUUID();
    aliceLiveAccount = randomUUID();
    sibLive = randomUUID();
    // A same-account sibling under Alice's test account.
    await fx.db.insert(schema.profiles).values({
      id: sibTest,
      accountId: fx.alice.accountId as unknown as string,
      name: `sib-${sibTest.slice(0, 8)}`,
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
      state: {},
    });
    // A second account under Alice (live env) and one profile beneath it.
    await fx.db.insert(schema.accounts).values({
      id: aliceLiveAccount,
      ownerId: fx.alice.userId as unknown as string,
      name: 'alice-live',
      binanceMode: 'live',
    });
    await fx.db.insert(schema.profiles).values({
      id: sibLive,
      accountId: aliceLiveAccount,
      name: `sib-${sibLive.slice(0, 8)}`,
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
      state: {},
    });
  });

  afterEach(() => fx.cleanup());

  const bind = async (userId: UserId, accountId: AccountId, profileId: string) => {
    const p = await profileRepo(fx.db, userId, accountId, asProfileId(profileId));
    return p.profileSymbols.upsert(SYMBOL, BASE, { overrideConfig: null });
  };

  it('binds freely when no sibling on the account owns the base asset', async () => {
    await expect(
      bind(fx.alice.userId, fx.alice.accountId, fx.alice.profileId),
    ).resolves.toMatchObject({
      symbol: SYMBOL,
      baseAsset: BASE,
    });
  });

  it('findOwningSiblingByBase reports the owning profile to a same-account sibling', async () => {
    await bind(fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    const owner = await profileSymbols.findOwningSiblingByBase(
      fx.db,
      fx.alice.accountId,
      BASE,
      asProfileId(sibTest),
    );
    expect(owner).toEqual({ profileId: fx.alice.profileId, name: 'demo' });
  });

  it('rejects a second profile on the same account', async () => {
    await bind(fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    await expect(bind(fx.alice.userId, fx.alice.accountId, sibTest)).rejects.toBeInstanceOf(
      SymbolOwnershipConflictError,
    );
  });

  it('the conflict error carries the owning profile id and name', async () => {
    await bind(fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    await bind(fx.alice.userId, fx.alice.accountId, sibTest).then(
      () => {
        throw new Error('expected a conflict');
      },
      (err: SymbolOwnershipConflictError) => {
        expect(err.ownerProfileId).toBe(fx.alice.profileId);
        expect(err.ownerName).toBe('demo');
        // The error's `symbol` field carries the clashing base asset.
        expect(err.symbol).toBe(BASE);
      },
    );
  });

  it('allows the same base asset on a different account owned by the same operator', async () => {
    await bind(fx.alice.userId, fx.alice.accountId, fx.alice.profileId); // test account
    await expect(
      bind(fx.alice.userId, asAccountId(aliceLiveAccount), sibLive),
    ).resolves.toMatchObject({ symbol: SYMBOL });
  });

  it('allows the same base asset for a different user', async () => {
    await bind(fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    await expect(bind(fx.bob.userId, fx.bob.accountId, fx.bob.profileId)).resolves.toMatchObject({
      symbol: SYMBOL,
    });
  });

  it('lets the owning profile re-upsert (edit override) without a self-conflict', async () => {
    await bind(fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    const p = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    await expect(
      p.profileSymbols.upsert(SYMBOL, BASE, { overrideConfig: { buy: {} } }),
    ).resolves.toMatchObject({ symbol: SYMBOL });
  });

  it('rejects a sibling that manages a different symbol over the same base asset', async () => {
    // Alice's primary profile owns BTCUSDT. A same-account sibling then claims
    // BTCFDUSD: a different symbol but the same BTC wallet line.
    const primary = await profileRepo(
      fx.db,
      fx.alice.userId,
      fx.alice.accountId,
      fx.alice.profileId,
    );
    await primary.profileSymbols.upsert('BTCUSDT', 'BTC', { overrideConfig: null });

    const sib = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, asProfileId(sibTest));
    await expect(
      sib.profileSymbols.upsert('BTCFDUSD', 'BTC', { overrideConfig: null }),
    ).rejects.toBeInstanceOf(SymbolOwnershipConflictError);
  });

  // Symmetric exclusivity backstop (#665): a candidate base asset must not equal
  // a sibling profile's QUOTE asset on the same account. A profile quoting BTC
  // draws on the shared BTC balance to fund every buy, so another profile
  // holding BTC as a tradable base would size sells / arm stops against a balance
  // the quoting sibling silently spends. #661 added this rule to the discovery
  // pre-filter only; these pin the DB-layer hard-block that covers the manual-add
  // funnel (and every other upsert seam).
  const quoteSibling = async (profileId: string, quoteAsset: string) =>
    fx.db.update(schema.profiles).set({ quoteAsset }).where(eq(schema.profiles.id, profileId));

  const bindBase = async (profileId: string) => {
    const p = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, asProfileId(profileId));
    return p.profileSymbols.upsert('BTCUSDT', 'BTC', { overrideConfig: null });
  };

  it('C2: rejects a base equal to a same-account sibling’s quote asset', async () => {
    // sibTest quotes BTC; Alice's primary must not bind BTC as a tradable base.
    await quoteSibling(sibTest, 'BTC');
    await expect(bindBase(fx.alice.profileId)).rejects.toBeInstanceOf(SiblingQuoteConflictError);
  });

  it('C3: matches case-insensitively so a lower/mixed-case stored quote still collides', async () => {
    // Stored quote is not upper-case but the candidate base is 'BTC'. The guard
    // uppercases the stored quote, so it must still reject — failing open here
    // would let the collision through. The first bindBase rejects pre-insert, so
    // no BTCUSDT binding leaks between the two casings.
    await quoteSibling(sibTest, 'btc');
    await expect(bindBase(fx.alice.profileId)).rejects.toBeInstanceOf(SiblingQuoteConflictError);
    await quoteSibling(sibTest, 'Btc');
    await expect(bindBase(fx.alice.profileId)).rejects.toBeInstanceOf(SiblingQuoteConflictError);
  });

  it('C4: owns-base wins precedence over the quote collision', async () => {
    // BTC is BOTH owned by one sibling (as a base) AND another sibling's quote.
    // The owns-base check runs first, so the caller sees the base-ownership error,
    // not the quote error. sibTest claims BTC as a base FIRST (before the quoting
    // sibling exists, so its own guard passes); the quoting sibling then lands via
    // a raw insert that bypasses the upsert guard.
    const owner = await profileRepo(
      fx.db,
      fx.alice.userId,
      fx.alice.accountId,
      asProfileId(sibTest),
    );
    await owner.profileSymbols.upsert('BTCFDUSD', 'BTC', { overrideConfig: null });

    const sibQuotes = randomUUID();
    await fx.db.insert(schema.profiles).values({
      id: sibQuotes,
      accountId: fx.alice.accountId as unknown as string,
      name: `sibq-${sibQuotes.slice(0, 8)}`,
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
      state: {},
      quoteAsset: 'BTC',
    });

    await bindBase(fx.alice.profileId).then(
      () => {
        throw new Error('expected a conflict');
      },
      (err: Error) => {
        expect(err).toBeInstanceOf(SymbolOwnershipConflictError);
        expect(err).not.toBeInstanceOf(SiblingQuoteConflictError);
      },
    );
  });

  it('C5: binds freely when no sibling owns or quotes the base', async () => {
    // All siblings keep the default USDT quote and none owns BTC.
    await expect(bindBase(fx.alice.profileId)).resolves.toMatchObject({
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
    });
  });

  it('C6: rejects a base equal to the binding profile’s OWN quote (self-collision)', async () => {
    // Alice's primary quotes BTC; binding BTC as a base to ITSELF settles in BTC
    // while trading BTC as a base — sizing sells / arming stops against the same
    // wallet line it spends to fund buys. The dedicated self-check rejects with an
    // ownership conflict carrying the profile's OWN id.
    await quoteSibling(fx.alice.profileId, 'BTC');
    await bindBase(fx.alice.profileId).then(
      () => {
        throw new Error('expected a conflict');
      },
      (err: Error) => {
        expect(err).toBeInstanceOf(SymbolOwnershipConflictError);
        expect(err).not.toBeInstanceOf(SiblingQuoteConflictError);
        expect((err as SymbolOwnershipConflictError).symbol).toBe('BTC');
        expect((err as SymbolOwnershipConflictError).ownerProfileId).toBe(fx.alice.profileId);
        // The self message must read as a self-collision, NOT falsely name the
        // profile as the "owner" of a base it does not trade (the sibling message).
        expect(err.message).not.toContain('already managed by');
        expect(err.message).toContain('settlement asset');
      },
    );
    // The sibling finder still correctly excludes self (returns null); the NEW
    // dedicated self-check is what rejects here, not the cross-profile finder.
    const self = await profileSymbols.findSiblingQuotingBase(
      fx.db,
      fx.alice.accountId,
      'BTC',
      fx.alice.profileId,
    );
    expect(self).toBeNull();
  });

  it('C6b: self-check matches case-insensitively on a lower/mixed-case stored OWN quote', async () => {
    // Own quote stored lower-case; the candidate base is 'BTC'. The self-check
    // uppercases the stored quote, so it must still reject — failing open would let
    // a profile settle in and trade the same wallet line. Pins the `.toUpperCase()`.
    await quoteSibling(fx.alice.profileId, 'btc');
    await expect(bindBase(fx.alice.profileId)).rejects.toBeInstanceOf(SymbolOwnershipConflictError);
  });

  it('the quote-conflict error carries the sibling profile id and name', async () => {
    await quoteSibling(sibTest, 'BTC');
    await bindBase(fx.alice.profileId).then(
      () => {
        throw new Error('expected a conflict');
      },
      (err: SiblingQuoteConflictError) => {
        expect(err.siblingProfileId).toBe(sibTest);
        expect(err.siblingName).toBe(`sib-${sibTest.slice(0, 8)}`);
        // The error's `symbol` field carries the clashing base asset.
        expect(err.symbol).toBe('BTC');
      },
    );
  });

  // #671: the symmetric collision reached through the OTHER edit boundary —
  // changing a profile's own quote_asset. `profiles.update` is the funnel; the
  // symbol-bind guard above never runs on a quote edit, so a raw `.set(patch)`
  // lets an operator point profile B's quote at an asset a sibling already trades
  // as a base — the exact cross-profile shared-wallet conflict, after both are
  // bound. These pin the repo-layer guard `update` must grow (mirroring upsert).
  const updateQuote = async (profileId: string, quoteAsset: string) => {
    const p = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, asProfileId(profileId));
    return p.profile.update({ quoteAsset });
  };

  it('C7: rejects editing a profile’s quote to a base a sibling manages', async () => {
    // sibTest trades BTC as a base; Alice's primary must not adopt BTC as its quote.
    await bindBase(sibTest);
    await expect(updateQuote(fx.alice.profileId, 'BTC')).rejects.toBeInstanceOf(
      SymbolOwnershipConflictError,
    );
  });

  it('C8: rejects editing a profile’s quote to a base IT already manages (self-collision)', async () => {
    // Alice's primary trades BTC as a base; settling in BTC too draws sells and
    // stops against the same wallet line it trades.
    await bindBase(fx.alice.profileId);
    await expect(updateQuote(fx.alice.profileId, 'BTC')).rejects.toBeInstanceOf(
      SymbolOwnershipConflictError,
    );
  });

  it('C9: allows editing a profile’s quote to a non-conflicting asset', async () => {
    // sibTest owns BTC; ETH is neither owned nor quoted by any sibling.
    await bindBase(sibTest);
    await expect(updateQuote(fx.alice.profileId, 'ETH')).resolves.toMatchObject({
      quoteAsset: 'ETH',
    });
  });
});
