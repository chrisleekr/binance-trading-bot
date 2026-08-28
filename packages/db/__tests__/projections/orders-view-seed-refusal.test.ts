// The symbol-state projection has to carry the refused cost-basis seed beside the ledger row it contradicts. Both come from this one read: `avg_entry_prices` says the operator recorded a position, `condition_states` says the worker declined to hand it to the strategy, and a client that receives only the first renders a holding with a signed P/L that nothing backs.
//
// Read by `(condition, symbol)`, which is the whole content of the assertion: the profile's other open conditions and the same condition on a sibling coin are the two ways a projection can look correct on the happy path and be wrong in production.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ProfileScope } from '../../src/repo/_scoped.js';
import { profileRepo } from '../../src/repo/index.js';
import { getSymbolState } from '../../src/repo/projections/orders-view.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';
import { makeRedisStub } from './_redis-stub.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const SINCE = new Date('2026-08-26T01:02:03.000Z');

describeIfDb('orders-view: refused position seed', () => {
  let fx: IsolationFixture;
  let scope: ProfileScope;

  beforeAll(async () => {
    fx = await setupFixture();
    const ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    scope = ap.scope;
    // The row the api accepted and the worker then refused to act on.
    await ap.avgEntryPrices.upsert('BTCUSDT', { avgEntryPrice: '60000', quantity: '0.001' });
    await ap.conditionStates.recordCondition({
      condition: 'position-seed-refused',
      symbol: 'BTCUSDT',
      code: 'no-sellable-position',
      now: SINCE,
    });
    // Two decoys: a DIFFERENT condition, open on a coin with no refusal at all, and the same condition on another coin.
    await ap.conditionStates.recordCondition({
      condition: 'entry-blocked',
      symbol: 'ADAUSDT',
      code: 'awaiting-trigger-price',
      now: SINCE,
    });
    await ap.conditionStates.recordCondition({
      condition: 'position-seed-refused',
      symbol: 'ETHUSDT',
      code: 'no-sellable-position',
      now: SINCE,
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('surfaces the open refusal with the code and the instant it opened', async () => {
    const { redis } = makeRedisStub();
    const state = await getSymbolState(scope, redis, 'BTCUSDT');
    expect(state.positionSeedRefusal).toEqual({
      code: 'no-sellable-position',
      since: SINCE.toISOString(),
    });
    // The ledger row travels beside it, untouched. The refusal is what makes that row readable, not a reason to withhold it.
    expect(Number(state.avgEntryPrice?.quantity)).toBe(0.001);
  });

  it('reads the refusal for the symbol asked for, not a sibling coin', async () => {
    const { redis } = makeRedisStub();
    const eth = await getSymbolState(scope, redis, 'ETHUSDT');
    expect(eth.positionSeedRefusal?.code).toBe('no-sellable-position');
    const flat = await getSymbolState(scope, redis, 'SOLUSDT');
    expect(flat.positionSeedRefusal).toBeNull();
  });

  it('does not mistake another open condition for a seed refusal', async () => {
    // ADAUSDT carries an open `entry-blocked` and nothing else. A projection reading "any open condition for this symbol" would surface that here and tell the operator a healthy position is not held.
    const { redis } = makeRedisStub();
    const state = await getSymbolState(scope, redis, 'ADAUSDT');
    expect(state.positionSeedRefusal).toBeNull();
  });
});
