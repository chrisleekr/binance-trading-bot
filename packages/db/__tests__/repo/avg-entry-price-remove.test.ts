// Dropping a cost-basis row has to take its "nothing sellable backs this" refusal with it, and the clear lives inside `remove` because six call sites delete that row — the api, the boot reconciler's two destructive arms, the fill adopter, the grid reset, and the unbind teardown. Once the row is gone nothing re-examines the symbol, so a deleter that forgets leaves a warning the operator can never clear.
//
// Against a real database rather than a spy: the property is that no state row survives, and a spy on `recordCondition` would pass just as happily while the row stayed. The two decoys are the ways a clear can look right and be too wide — the same condition on a sibling coin, and a different condition on the same coin.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POSITION_SEED_REFUSED, NO_SELLABLE_POSITION } from '../../src/repo/condition-states.js';
import { profileRepo } from '../../src/repo/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const SINCE = new Date('2026-08-26T01:02:03.000Z');

describeIfDb('avg-entry-prices remove: clears the seed refusal it is about', () => {
  let fx: IsolationFixture;
  let p: Awaited<ReturnType<typeof profileRepo>>;

  beforeAll(async () => {
    fx = await setupFixture();
    p = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  beforeEach(async () => {
    for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
      await p.avgEntryPrices.upsert(symbol, { avgEntryPrice: '60000', quantity: '0.001' });
      await p.conditionStates.recordCondition({
        condition: POSITION_SEED_REFUSED,
        symbol,
        code: NO_SELLABLE_POSITION,
        now: SINCE,
      });
    }
    await p.conditionStates.recordCondition({
      condition: 'entry-blocked',
      symbol: 'BTCUSDT',
      code: 'knife-guard',
      now: SINCE,
    });
  });

  it('closes the refusal for the symbol whose row was dropped', async () => {
    // Anchored on the open row first: an assertion that the condition is absent afterwards passes just as well when the seed never landed.
    expect(await p.conditionStates.findOne(POSITION_SEED_REFUSED, 'BTCUSDT')).toBeDefined();

    await p.avgEntryPrices.remove('BTCUSDT');

    expect(await p.avgEntryPrices.findBySymbol('BTCUSDT')).toBeNull();
    expect(await p.conditionStates.findOne(POSITION_SEED_REFUSED, 'BTCUSDT')).toBeUndefined();
  });

  it('leaves the same refusal standing on a coin it did not touch', async () => {
    await p.avgEntryPrices.remove('BTCUSDT');

    const sibling = await p.conditionStates.findOne(POSITION_SEED_REFUSED, 'ETHUSDT');
    expect(sibling?.code).toBe(NO_SELLABLE_POSITION);
  });

  it('leaves the other open conditions on that symbol alone', async () => {
    // A clear written as "close everything open on this symbol" would take the entry gate's own reason with it, and the operator would lose the explanation for why the bot is not buying.
    await p.avgEntryPrices.remove('BTCUSDT');

    const other = await p.conditionStates.findOne('entry-blocked', 'BTCUSDT');
    expect(other?.code).toBe('knife-guard');
  });

  it('writes nothing when no refusal was open', async () => {
    await p.conditionStates.recordCondition({
      condition: POSITION_SEED_REFUSED,
      symbol: 'BTCUSDT',
      code: null,
      now: SINCE,
    });
    const before = (await p.actionLogs.listConditionEdges(100)).length;

    await p.avgEntryPrices.remove('BTCUSDT');

    // The ordinary case is the one that must stay cheap: every delete would otherwise append a resolution edge for a condition that was never open, on a table the operator reads.
    expect((await p.actionLogs.listConditionEdges(100)).length).toBe(before);
  });
});
