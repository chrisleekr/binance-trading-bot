import { describe, expect, it } from 'vitest';

import { parseSymbolReconcileJob } from '../../src/queues/job-payloads.js';

describe('parseSymbolReconcileJob', () => {
  it('accepts a replace-order failure as a symbol reconcile cause', () => {
    const payload = {
      accountId: 'account-1',
      profileId: 'profile-1',
      symbol: 'BTCUSDT',
      cause: 'replace-order-failed',
    };

    expect(parseSymbolReconcileJob(payload)).toEqual(payload);
  });
});
