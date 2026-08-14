// The requireNotDemo() deny-list and onboarding-status demoMode field are both
// driven by the LIVE_DEMO deployment flag.
//
// The guard covers credential, notifier, backup/restore, account-creation,
// retention-change, and diagnosis-start routes. Trading remains interactive on
// testnet. One assertion samples each locked surface at request level.
//
// The guard reads `di.env.LIVE_DEMO` at request time; the fixture mutates that
// field on the shared di object the routers close over.

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
  it('retention-config PATCH /retention-config is locked', async () => {
    await expect403('/api/retention-config', 'PATCH', '{"actionLogDays":1}');
  });
  it('auth POST /change-password is locked', async () => {
    await expect403('/api/auth/change-password', 'POST', '{}');
  });
  it('auth POST /sign-out is locked', async () => {
    await expect403('/api/auth/sign-out', 'POST');
  });
  // Better Auth's native endpoint bypasses the onboarding-closed gate.
  it('auth POST /sign-up/email is locked', async () => {
    await expect403('/api/auth/sign-up/email', 'POST', '{}');
  });

  // The provider surface reads and writes secrets and can fire the configured
  // webhook. One 403 assertion samples each operation.
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

  // Starting an investigation is the one write on an otherwise read-only
  // surface, and its live re-probe spends the account's Binance request weight.
  // An anonymous visitor could otherwise burn the operator's budget with a
  // button. Reading a finished report stays open — it carries no credential.
  it('diagnosis POST /profiles/:id/diagnosis/runs is locked', async () => {
    await expect403(`/api/accounts/${acc()}/profiles/${prof()}/diagnosis/runs`, 'POST', '{}');
  });
  it('diagnosis GET /profiles/:id/diagnosis/runs stays open', async () => {
    const res = await fx.app.request(`/api/accounts/${acc()}/profiles/${prof()}/diagnosis/runs`, {
      headers: headers(),
    });
    expect(res.status).toBe(200);
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
