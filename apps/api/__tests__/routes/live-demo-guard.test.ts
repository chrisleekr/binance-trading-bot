// Criterion 2 + 5b: the requireNotDemo() deny-list and the onboarding-status
// demoMode field, both driven by the LIVE_DEMO deployment flag.
//
// The guard is a blocklist-completeness gate: every credential / destructive /
// notifier-target route must 403 under LIVE_DEMO so a sensitive route added
// later cannot silently become public. One assertion per locked (method, path).
//
// The guard is expected to read `di.env.LIVE_DEMO` at request time; the fixture
// mutates that field on the shared di object the routers close over.
//
// RED: no guard exists yet, so every locked route answers its normal status
// (200 / 422 / 401), not 403; and onboarding-status omits demoMode.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const setDemo = (fx: ApiFixture, on: boolean): void => {
  (fx.di.env as unknown as { LIVE_DEMO?: boolean }).LIVE_DEMO = on;
};

describeIfInfra('requireNotDemo deny-list under LIVE_DEMO', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
    setDemo(fx, true);
  });

  afterAll(async () => {
    if (fx) {
      setDemo(fx, false);
      await fx.cleanup();
    }
  });

  const headers = (): Record<string, string> => ({
    'x-test-user-id': fx.alice.userId,
    'content-type': 'application/json',
  });
  const acc = (): string => fx.alice.accountId;
  const prof = (): string => fx.alice.profileId;
  const expect403 = async (path: string, method: string, body?: string): Promise<void> => {
    const res = await fx.app.request(path, {
      method,
      headers: headers(),
      ...(body ? { body } : {}),
    });
    expect(res.status).toBe(403);
  };

  it('api-keys GET /api-key is locked', async () => {
    await expect403(`/api/accounts/${acc()}/api-key`, 'GET');
  });
  it('api-keys PUT /api-key is locked', async () => {
    await expect403(`/api/accounts/${acc()}/api-key`, 'PUT', '{}');
  });
  it('backup GET /backup is locked', async () => {
    await expect403('/api/backup', 'GET');
  });
  it('backup GET /backup/config is locked', async () => {
    await expect403('/api/backup/config', 'GET');
  });
  it('backup PUT /backup/config is locked', async () => {
    await expect403('/api/backup/config', 'PUT', '{}');
  });
  it('backup POST /restore is locked', async () => {
    await expect403('/api/restore', 'POST', '{}');
  });
  it('ai-provider GET /account/ai-provider is locked', async () => {
    await expect403('/api/account/ai-provider', 'GET');
  });
  it('ai-provider POST /account/ai-provider/test is locked', async () => {
    await expect403('/api/account/ai-provider/test', 'POST', '{}');
  });
  it('ops-notify GET /account/ops-notify is locked', async () => {
    await expect403('/api/account/ops-notify', 'GET');
  });
  it('accounts POST /accounts (create) is locked', async () => {
    await expect403('/api/accounts', 'POST', '{}');
  });
  it('auth POST /change-password is locked', async () => {
    await expect403('/api/auth/change-password', 'POST', '{}');
  });
  it('auth POST /sign-out is locked', async () => {
    await expect403('/api/auth/sign-out', 'POST');
  });
  // F5: Better Auth's native /sign-up/email bypasses the onboarding-closed gate.
  it('auth POST /sign-up/email is locked', async () => {
    await expect403('/api/auth/sign-up/email', 'POST', '{}');
  });

  // F1+F2: the per-provider notifier surface leaks the seeded webhook url/chatId
  // (readable via GET config), lets a visitor overwrite/toggle it, and can fire
  // the operator's real webhook via test-fire. One 403 assertion per route.
  const np = (): string => `/api/accounts/${acc()}/profiles/${prof()}/notify-providers/webhook`;
  it('notify-provider GET :name is locked', async () => {
    await expect403(np(), 'GET');
  });
  it('notify-provider POST :name (save) is locked', async () => {
    await expect403(np(), 'POST', '{}');
  });
  it('notify-provider PATCH :name/enabled is locked', async () => {
    await expect403(`${np()}/enabled`, 'PATCH', '{}');
  });
  it('notify-provider POST :name/test-fire is locked', async () => {
    await expect403(`${np()}/test-fire`, 'POST', '{}');
  });
});

describeIfInfra('onboarding-status reports demoMode from LIVE_DEMO', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });

  afterAll(async () => {
    if (fx) {
      setDemo(fx, false);
      await fx.cleanup();
    }
  });

  const demoModeOf = async (): Promise<unknown> => {
    const res = await fx.app.request('/api/auth/onboarding-status');
    return ((await res.json()) as { demoMode?: unknown }).demoMode;
  };

  it('returns demoMode:false when LIVE_DEMO is off', async () => {
    setDemo(fx, false);
    expect(await demoModeOf()).toBe(false);
  });

  it('returns demoMode:true when LIVE_DEMO is on', async () => {
    setDemo(fx, true);
    expect(await demoModeOf()).toBe(true);
  });
});
