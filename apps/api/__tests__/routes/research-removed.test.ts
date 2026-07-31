// The funding-carry and cash-and-carry research surfaces are gone: AU retail is
// barred from crypto perps, so a carry that can only be built with a short perp
// leg is unreachable here. The routes must be unmounted, not merely unlinked
// from the UI — a live endpoint invites an operator to act on a strategy they
// cannot execute.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('removed research routes', () => {
  let fx: ApiFixture;
  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('GET /api/research/funding-carry and /api/research/carry-backtest return 404', async () => {
    const headers = { 'x-test-user-id': fx.alice.userId };
    for (const path of [
      '/api/research/funding-carry?symbol=BTCUSDT',
      '/api/research/carry-backtest?symbol=BTCUSDT',
    ]) {
      const res = await fx.app.request(path, { headers });
      expect(res.status).toBe(404);
    }
  });
});
