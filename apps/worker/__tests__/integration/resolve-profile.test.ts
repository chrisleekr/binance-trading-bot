// End-to-end DI smoke for `buildProfileBindings`. Applies migrations against the
// integration Postgres, seeds one operator with two accounts (one keyed, one not)
// and asserts the bindings factory threads the typed repo layer correctly: the
// owner gets a fully wired `ProfileExecutorBindings`, a foreign operator gets
// null, and an account with no api-key gets null.
//
// Credentials, environment, and order reconciliation all live on the ACCOUNT: one
// key pair and one `binance_mode` per account, shared by every profile under it,
// and a Binance order id that is unique per account.
//
// Gated on `DATABASE_TEST_URL` so unit-only CI legs and laptops without Postgres
// resolve the suite as `describe.skip` rather than fail — the established repo
// convention (matches `packages/db/__tests__/isolation` and
// `apps/api/__tests__/auth-integration.test.ts`).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { accountRepo, createDb, migrate } from '@app/db';

import { buildProfileBindings } from '../../src/profile-bindings/index.js';

const TEST_DB_URL = process.env['DATABASE_TEST_URL'];
const describeIfInfra = TEST_DB_URL ? describe : describe.skip;

const OWNER_USER = asUserId('00000000-0000-0000-0000-00000000a001');
const STRANGER_USER = asUserId('00000000-0000-0000-0000-00000000b001');
// The keyed testnet account and its profile.
const KEYED_ACCOUNT = asAccountId('00000000-0000-0000-0000-00000000c001');
const OWNER_PROFILE = asProfileId('00000000-0000-0000-0000-00000000a101');
// A second account with no api-key row, to prove the bindings refuse it.
const NOKEY_ACCOUNT = asAccountId('00000000-0000-0000-0000-00000000c002');
const NOKEY_PROFILE = asProfileId('00000000-0000-0000-0000-00000000a102');

describeIfInfra('buildProfileBindings — end-to-end DI smoke', () => {
  let pool: Pool | undefined;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    if (!TEST_DB_URL) throw new Error('unreachable: gated by describeIfInfra');
    await migrate({ connectionString: TEST_DB_URL, log: () => undefined });

    pool = new Pool({ connectionString: TEST_DB_URL });
    db = createDb(pool);

    // Truncate the slice this suite owns so re-runs are deterministic even when
    // the shared integration database carries state from a previous run.
    await pool.query(
      `truncate table orders, api_keys, profile_notifiers, profiles, accounts, users restart identity cascade`,
    );

    await pool.query(`insert into users (id, email) values ($1, $2), ($3, $4)`, [
      OWNER_USER,
      'owner-137@local',
      STRANGER_USER,
      'stranger-137@local',
    ]);
    // `binance_mode` and the key pair are ACCOUNT-level (one environment per
    // account, shared by its profiles).
    await pool.query(
      `insert into accounts (id, owner_id, name, binance_mode)
       values ($1, $2, 'keyed-137', 'test'),
              ($3, $2, 'nokey-137', 'live')`,
      [KEYED_ACCOUNT, OWNER_USER, NOKEY_ACCOUNT],
    );
    await pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
       values ($1, $2, 'with-key-137', 'trailing-trade', '1.0.0', '{}'::jsonb, '{}'::jsonb),
              ($3, $4, 'no-key-137',   'trailing-trade', '1.0.0', '{}'::jsonb, '{}'::jsonb)`,
      [OWNER_PROFILE, KEYED_ACCOUNT, NOKEY_PROFILE, NOKEY_ACCOUNT],
    );
    await pool.query(
      `insert into api_keys (account_id, key, secret, last4) values ($1, 'pk', 'sk', '1234')`,
      [KEYED_ACCOUNT],
    );
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('returns a fully-wired bindings record for a profile whose account has an api-key', async () => {
    const bindings = await buildProfileBindings({ db }, OWNER_USER, KEYED_ACCOUNT, OWNER_PROFILE);
    if (!bindings) throw new Error('expected non-null bindings for the owner');
    expect(bindings.mode).toBe('test');
    expect(typeof bindings.binance.placeOrder).toBe('function');
  });

  it('returns null when the account is not owned by the operator', async () => {
    const bindings = await buildProfileBindings(
      { db },
      STRANGER_USER,
      KEYED_ACCOUNT,
      OWNER_PROFILE,
    );
    expect(bindings).toBeNull();
  });

  it("returns null when the profile's account has no api-key configured yet", async () => {
    const bindings = await buildProfileBindings({ db }, OWNER_USER, NOKEY_ACCOUNT, NOKEY_PROFILE);
    expect(bindings).toBeNull();
  });

  it('round-trips persistOrder → resolveOrderSlot → closeOrder through the typed repo layer', async () => {
    // A Binance id high enough that a number/bigint mismatch would surface, and
    // out of range of any other seed in the suite.
    const binanceId = 9_999_000_137;
    const bindings = await buildProfileBindings({ db }, OWNER_USER, KEYED_ACCOUNT, OWNER_PROFILE);
    if (!bindings) throw new Error('expected non-null bindings');

    await bindings.persistence.persistOrder(
      {
        userId: OWNER_USER,
        profileId: OWNER_PROFILE,
        symbol: 'BTCUSDT',
        side: 'BUY',
        intent: 'grid-buy',
        binanceOrderId: BigInt(binanceId),
        clientOrderId: 'cid-round-trip-137',
        status: 'NEW',
        raw: { source: 'integration-test' },
      },
      { closePrevious: true },
    );

    // The slot carries the intent and the release inputs, not just the symbol: a
    // failed cancel needs the intent to name the exact live slot it left holding
    // an order, and `side`/`remainingQty`/`price` to size the wallet release for
    // the next decision in the batch. `remainingQty`/`price` are null when the
    // row's `raw` does not carry them (a release of unknown size).
    expect(await bindings.persistence.resolveOrderSlot(binanceId)).toEqual({
      symbol: 'BTCUSDT',
      intent: 'grid-buy',
      side: 'BUY',
      remainingQty: null,
      price: null,
    });

    await bindings.persistence.closeOrder(binanceId, 'FILLED');

    // Verify via the typed repo that the row really closed. Seeking by Binance id
    // is ACCOUNT-scoped — the id is unique per account, not per profile.
    const a = await accountRepo(db, OWNER_USER, KEYED_ACCOUNT);
    const row = await a.orders.findByBinanceOrderId(BigInt(binanceId));
    expect(row?.status).toBe('FILLED');
    expect(row?.closedAt).toBeInstanceOf(Date);
    // The row is stamped with the account that can reconcile it on the exchange.
    expect(row?.accountId).toBe(KEYED_ACCOUNT);

    // A second close on the same id is a zero-match: it must not throw (the
    // silent-close guard warns via the worker logger in production).
    await bindings.persistence.closeOrder(binanceId, 'FILLED');
  });
});
