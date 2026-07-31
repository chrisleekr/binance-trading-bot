import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpsNotifyConfig } from '@app/contracts';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const headers = (userId: string): Record<string, string> => ({
  'x-test-user-id': userId,
  'content-type': 'application/json',
});

describeIfInfra('ops-notify router', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('defaults to all-on and round-trips a muted toggle', async () => {
    const before = await fx.app.request('/api/account/ops-notify', {
      headers: headers(fx.alice.userId),
    });
    expect(before.status).toBe(200);
    expect(((await before.json()) as OpsNotifyConfig)['job-failed']).toBe(true);

    const res = await fx.app.request('/api/account/ops-notify', {
      method: 'PATCH',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({ 'job-failed': false }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as OpsNotifyConfig)['job-failed']).toBe(false);

    // Persisted: a fresh GET reflects the mute (singleton, shared across users).
    const after = await fx.app.request('/api/account/ops-notify', {
      headers: headers(fx.alice.userId),
    });
    expect(((await after.json()) as OpsNotifyConfig)['job-failed']).toBe(false);
  });
});
