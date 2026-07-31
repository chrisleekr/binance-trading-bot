// Criterion 3: boot invariant — a LIVE_DEMO box can only ever hold a testnet
// key. If LIVE_DEMO is on and any account is binance_mode='live', boot must
// refuse to start; with every account on 'test' it must construct fine. The
// invariant is exercised through the boot-time assertion Phase B adds to di.ts.
//
// RED: `assertLiveDemoInvariant` does not exist yet, so the import resolves to
// undefined and the call throws "not a function".

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_INFRA, setupApp, type ApiFixture } from './_helpers.js';
// Intended Phase-B export: assertLiveDemoInvariant(db, { liveDemo }) → Promise<void>,
// rejects when liveDemo is true and any account.binance_mode = 'live'.
import { assertLiveDemoInvariant } from '../src/di.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('LIVE_DEMO boot invariant', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('resolves when LIVE_DEMO is on and every account is binance_mode=test', async () => {
    // The seed provisions both accounts as 'test'.
    await expect(assertLiveDemoInvariant(fx.di.db, { liveDemo: true })).resolves.toBeUndefined();
  });

  it('throws when LIVE_DEMO is on and any account is binance_mode=live', async () => {
    await fx.di.pool.query(`update accounts set binance_mode='live' where id=$1`, [
      fx.alice.accountId,
    ]);
    await expect(assertLiveDemoInvariant(fx.di.db, { liveDemo: true })).rejects.toThrow();
  });

  it('does not throw when LIVE_DEMO is off even with a live-mode account', async () => {
    await fx.di.pool.query(`update accounts set binance_mode='live' where id=$1`, [
      fx.alice.accountId,
    ]);
    await expect(assertLiveDemoInvariant(fx.di.db, { liveDemo: false })).resolves.toBeUndefined();
  });
});
