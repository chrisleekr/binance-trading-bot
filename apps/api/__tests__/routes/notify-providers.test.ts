import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * Asserts the api now ships the same three notifier providers the worker
 * does. v1.0 always registered an empty list, so the SPA could not render a
 * notifier chooser. After the seam was unified onto `@app/notify`, the
 * response must list slack, telegram, webhook in registration order with the
 * full {@link NotifyProviderDescriptor} shape.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('GET /profiles/:profileId/notify-providers', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('returns slack, telegram, webhook in order with descriptor shape', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers`,
      {
        method: 'GET',
        headers: { 'x-test-user-id': fx.alice.userId },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      version: string;
      displayName: string;
      secretFields: string[];
    }[];

    expect(body.map((p) => p.name)).toEqual(['slack', 'telegram', 'webhook']);

    const slack = body.find((p) => p.name === 'slack');
    expect(slack).toMatchObject({
      version: '1.0.0',
      displayName: 'Slack (Incoming Webhook)',
      secretFields: ['webhookUrl'],
    });

    const telegram = body.find((p) => p.name === 'telegram');
    expect(telegram).toMatchObject({
      version: '1.0.0',
      displayName: 'Telegram (Bot API)',
      secretFields: ['botToken'],
    });

    const webhook = body.find((p) => p.name === 'webhook');
    expect(webhook).toMatchObject({
      version: '1.0.0',
      displayName: 'Generic Webhook',
      secretFields: ['authHeader'],
    });

    for (const entry of body) {
      expect(entry).not.toHaveProperty('send');
    }
  });
});

describeIfInfra('POST /profiles/:profileId/notify-providers/:name', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('persists a valid Slack config and returns the descriptor with enabled=true', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack`,
      {
        method: 'POST',
        headers: {
          'x-test-user-id': fx.alice.userId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          config: { webhookUrl: 'https://hooks.slack.test/abc' },
          enabled: true,
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; enabled: boolean };
    expect(body.name).toBe('slack');
    expect(body.enabled).toBe(true);

    const { schema } = await import('@app/db');
    const rows = await fx.di.db.select().from(schema.profileNotifiers).execute();
    const ours = rows.find((r) => r.profileId === fx.alice.profileId && r.provider === 'slack');
    expect(ours).toBeDefined();
    // Webhook URL is a registered secret → must land in `secrets`, not `config`.
    expect(ours?.config).toEqual({});
    expect(ours?.secrets).toEqual({ webhookUrl: 'https://hooks.slack.test/abc' });
  });

  it('rejects an invalid config with 422', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack`,
      {
        method: 'POST',
        headers: {
          'x-test-user-id': fx.alice.userId,
          'content-type': 'application/json',
        },
        // Must be invalid *after* the write-once secret merge. An empty `config` is
        // backfilled from the webhookUrl the preceding test stored, and so validates;
        // the assertion only ever passed while the harness registry was empty. A
        // present-but-malformed value survives the merge and fails `z.url()`.
        body: JSON.stringify({ config: { webhookUrl: 'not-a-url' }, enabled: true }),
      },
    );
    expect(res.status).toBe(422);
  });

  it('rejects an unknown provider with 422', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/discord`,
      {
        method: 'POST',
        headers: {
          'x-test-user-id': fx.alice.userId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ config: { webhookUrl: 'x' }, enabled: true }),
      },
    );
    expect(res.status).toBe(422);
  });

  it('cross-account: Bob cannot write to Alice profile (404)', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack`,
      {
        method: 'POST',
        headers: {
          'x-test-user-id': fx.bob.userId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          config: { webhookUrl: 'https://hooks.slack.test/zzz' },
          enabled: true,
        }),
      },
    );
    expect(res.status).toBe(404);
  });

  it('upserts in place on re-save (one row per (profile, provider))', async () => {
    await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack`,
      {
        method: 'POST',
        headers: {
          'x-test-user-id': fx.alice.userId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          config: { webhookUrl: 'https://hooks.slack.test/v1' },
          enabled: true,
        }),
      },
    );
    await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack`,
      {
        method: 'POST',
        headers: {
          'x-test-user-id': fx.alice.userId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          config: { webhookUrl: 'https://hooks.slack.test/v2' },
          enabled: false,
        }),
      },
    );

    const { schema } = await import('@app/db');
    const rows = await fx.di.db.select().from(schema.profileNotifiers).execute();
    const ours = rows.filter((r) => r.profileId === fx.alice.profileId && r.provider === 'slack');
    expect(ours).toHaveLength(1);
    expect(ours[0]?.enabled).toBe(false);
    expect(ours[0]?.secrets).toEqual({ webhookUrl: 'https://hooks.slack.test/v2' });
  });
});

describeIfInfra('POST /profiles/:profileId/notify-providers/:name re-save secret merge', () => {
  let fx: ApiFixture;
  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('blank secret on re-save preserves the previously stored secret', async () => {
    // Seed a real secret.
    const seed = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack`,
      {
        method: 'POST',
        headers: {
          'x-test-user-id': fx.alice.userId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          config: { webhookUrl: 'https://hooks.slack.test/seeded' },
          enabled: true,
        }),
      },
    );
    expect(seed.status).toBe(200);

    // Re-save with blank webhookUrl — would 422 without the merge.
    const resave = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack`,
      {
        method: 'POST',
        headers: {
          'x-test-user-id': fx.alice.userId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ config: { webhookUrl: '' }, enabled: false }),
      },
    );
    expect(resave.status).toBe(200);

    const { schema } = await import('@app/db');
    const rows = await fx.di.db.select().from(schema.profileNotifiers).execute();
    const ours = rows.find((r) => r.profileId === fx.alice.profileId && r.provider === 'slack');
    expect(ours).toBeDefined();
    // Stored secret survived the blank-input re-save.
    expect(ours?.secrets).toEqual({ webhookUrl: 'https://hooks.slack.test/seeded' });
    // Enabled flag flipped per the latest request.
    expect(ours?.enabled).toBe(false);
  });
});

describeIfInfra('POST /profiles/:profileId/notify-providers/:name/test-fire', () => {
  let fx: ApiFixture;
  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('returns 404 when no notifier row exists for that provider', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack/test-fire`,
      {
        method: 'POST',
        headers: { 'x-test-user-id': fx.alice.userId },
      },
    );
    expect(res.status).toBe(404);
  });

  it('cross-account: Bob → Alice profile gets 404 even if Alice has a row saved', async () => {
    await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack`,
      {
        method: 'POST',
        headers: { 'x-test-user-id': fx.alice.userId, 'content-type': 'application/json' },
        body: JSON.stringify({
          config: { webhookUrl: 'https://hooks.slack.test/x' },
          enabled: true,
        }),
      },
    );
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack/test-fire`,
      {
        method: 'POST',
        headers: { 'x-test-user-id': fx.bob.userId },
      },
    );
    expect(res.status).toBe(404);
  });

  it('surfaces a send-time error as ok=false (HTTP 200) and audits it', async () => {
    // Use a guaranteed-unroutable URL so the real Slack provider's HTTP
    // fetch fails immediately. The test does not depend on any specific
    // error string — the contract is just `ok: false` + truthy `error`.
    await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack`,
      {
        method: 'POST',
        headers: { 'x-test-user-id': fx.alice.userId, 'content-type': 'application/json' },
        body: JSON.stringify({
          config: { webhookUrl: 'http://127.0.0.1:1/never-listens' },
          enabled: true,
        }),
      },
    );
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack/test-fire`,
      {
        method: 'POST',
        headers: { 'x-test-user-id': fx.alice.userId },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error: string | null };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect((body.error as string).length).toBeGreaterThan(0);
  });
});

describeIfInfra('GET /profiles/:profileId/notify-providers/:name', () => {
  let fx: ApiFixture;
  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('returns 200 with the descriptor + enabled/config=null when no notifier row exists', async () => {
    // Known provider + no saved row is a benign empty state, not a 404. The
    // SPA reads "has saved row" from `config != null`, so the unconfigured
    // page load no longer spams the browser console with 404s.
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack`,
      {
        method: 'GET',
        headers: { 'x-test-user-id': fx.alice.userId },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      enabled: boolean | null;
      config: Record<string, unknown> | null;
    };
    expect(body.name).toBe('slack');
    expect(body.enabled).toBeNull();
    expect(body.config).toBeNull();
  });

  it('returns 404 when the provider name is unknown', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/discord`,
      { method: 'GET', headers: { 'x-test-user-id': fx.alice.userId } },
    );
    expect(res.status).toBe(404);
  });

  it('round-trips a saved Slack config with secrets stripped from the response', async () => {
    const fixtureUrl = 'https://hooks.slack.example/round-trip';
    const save = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack`,
      {
        method: 'POST',
        headers: { 'x-test-user-id': fx.alice.userId, 'content-type': 'application/json' },
        body: JSON.stringify({ config: { webhookUrl: fixtureUrl }, enabled: false }),
      },
    );
    expect(save.status).toBe(200);

    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack`,
      {
        method: 'GET',
        headers: { 'x-test-user-id': fx.alice.userId },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      version: string;
      displayName: string;
      configSchema: unknown;
      secretFields: string[];
      enabled: boolean;
      config: Record<string, unknown>;
    };
    expect(body.name).toBe('slack');
    expect(body.enabled).toBe(false);
    expect(body.secretFields).toEqual(['webhookUrl']);
    expect(body.config).toEqual({});
    expect(JSON.stringify(body)).not.toContain('round-trip');
  });

  it('cross-account: Bob → Alice profile gets 404 even when Alice has a row saved', async () => {
    const fixtureUrl = 'https://hooks.slack.example/cross-acct';
    await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack`,
      {
        method: 'POST',
        headers: { 'x-test-user-id': fx.alice.userId, 'content-type': 'application/json' },
        body: JSON.stringify({ config: { webhookUrl: fixtureUrl }, enabled: true }),
      },
    );
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack`,
      {
        method: 'GET',
        headers: { 'x-test-user-id': fx.bob.userId },
      },
    );
    expect(res.status).toBe(404);
  });
});

describeIfInfra('PATCH /profiles/:profileId/notify-providers/:name/enabled', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  const patchEnabled = (profileId: string, name: string, userId: string, enabled: boolean) =>
    fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${profileId}/notify-providers/${name}/enabled`,
      {
        method: 'PATCH',
        headers: { 'x-test-user-id': userId, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      },
    );

  it('toggles a saved notifier off without re-validating its config', async () => {
    // Save a valid Slack config first so a row exists.
    await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack`,
      {
        method: 'POST',
        headers: { 'x-test-user-id': fx.alice.userId, 'content-type': 'application/json' },
        body: JSON.stringify({
          config: { webhookUrl: 'https://hooks.slack.test/x' },
          enabled: true,
        }),
      },
    );
    const res = await patchEnabled(fx.alice.profileId, 'slack', fx.alice.userId, false);
    expect(res.status).toBe(200);
    expect((await res.json()) as { enabled: boolean }).toEqual({ enabled: false });

    // The GET reflects the disabled flag; the config is untouched.
    const got = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/notify-providers/slack`,
      {
        method: 'GET',
        headers: { 'x-test-user-id': fx.alice.userId },
      },
    );
    expect(((await got.json()) as { enabled: boolean }).enabled).toBe(false);
  });

  it('404s when no config row exists yet (the switch is inert until first save)', async () => {
    const res = await patchEnabled(fx.alice.profileId, 'telegram', fx.alice.userId, false);
    expect(res.status).toBe(404);
  });

  it('cross-account: Bob cannot toggle Alice’s notifier (404)', async () => {
    const res = await patchEnabled(fx.alice.profileId, 'slack', fx.bob.userId, false);
    expect(res.status).toBe(404);
  });
});
