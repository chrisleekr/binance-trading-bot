// Changes to what an intruder could steal (backups, API keys) or to who hears about it (notifiers, notification settings, retention) are security events, not only audit rows. The mapping lives in the audit middleware; these cases prove it reaches real routes, that its keys are the names routes actually emit, and that the one notification category that must never be muted cannot be.

import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SENSITIVE_AUDIT_EVENTS } from '../../src/middleware/audit.js';

import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const routesDir = new URL('../../src/routes/', import.meta.url);

describe('sensitive audit event mapping', () => {
  it('names only audit events some route actually emits, so a renamed event cannot silently drop its alert', () => {
    const sources = readdirSync(routesDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(new URL(f, routesDir), 'utf8'))
      .join('\n');
    // The walk must reach the routes that emit these, or every lookup below would fail for the wrong reason.
    expect(sources).toContain("event: 'backup-download'");
    for (const auditEvent of Object.keys(SENSITIVE_AUDIT_EVENTS)) {
      // Anchored to an emit site (`event: 'x'`, or a quoted name followed by `,`, `:` or `)` as in a ternary branch) so a stray mention of the word in a comment or string cannot satisfy it.
      expect(sources, auditEvent).toMatch(
        new RegExp(`event: '${auditEvent}'|'${auditEvent}'\\s*[,:)]`),
      );
    }
  });
});

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('sensitive changes through real routes', () => {
  let fx: ApiFixture;

  const recorded = async (event: string): Promise<number> =>
    (
      await fx.di.pool.query(
        `select 1 from audit_logs where category = 'security' and event = $1`,
        [event],
      )
    ).rowCount ?? 0;

  const patch = async (path: string, body: unknown): Promise<Response> =>
    fx.app.request(path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user-id': fx.alice.userId },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    fx = await setupApp();
  });
  beforeEach(async () => {
    await fx.di.pool.query(`delete from audit_logs where category = 'security'`);
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('records a notification settings change as a security event', async () => {
    const res = await patch('/api/account/ops-notify', { 'auth-activity': false });
    expect(res.status).toBe(200);
    expect(await recorded('ops-notify-settings-changed')).toBe(1);
  });

  it('refuses to mute security alerts, and records nothing for the refused change', async () => {
    const res = await patch('/api/account/ops-notify', { 'auth-alert': false });
    expect(res.status).toBe(422);
    expect(await recorded('ops-notify-settings-changed')).toBe(0);
    const current = (await (
      await fx.app.request('/api/account/ops-notify', {
        headers: { 'x-test-user-id': fx.alice.userId },
      })
    ).json()) as Record<string, boolean>;
    expect(current['auth-alert']).toBe(true);
  });

  const apiKeyPath = (): string => `/api/accounts/${fx.alice.accountId}/api-key`;
  const putApiKey = async (): Promise<Response> =>
    fx.app.request(apiKeyPath(), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user-id': fx.alice.userId },
      body: JSON.stringify({ key: 'k'.repeat(20), secret: 's'.repeat(20) }),
    });

  it.each([
    {
      auditEvent: 'add-api-key',
      keyExists: false,
      change: putApiKey,
      status: 200,
    },
    {
      auditEvent: 'replace-api-key',
      keyExists: true,
      change: putApiKey,
      status: 200,
    },
    {
      auditEvent: 'delete-api-key',
      keyExists: true,
      change: async (): Promise<Response> =>
        fx.app.request(apiKeyPath(), {
          method: 'DELETE',
          headers: { 'x-test-user-id': fx.alice.userId },
        }),
      status: 204,
    },
  ])(
    'records $auditEvent as api-key-changed',
    async ({ auditEvent, keyExists, change, status }) => {
      await fx.di.pool.query(`delete from api_keys where account_id = $1`, [fx.alice.accountId]);
      if (keyExists) expect((await putApiKey()).status).toBe(200);
      await fx.di.pool.query(`delete from audit_logs where category = 'security'`);
      expect((await change()).status).toBe(status);
      const { rows } = await fx.di.pool.query<{ change: string }>(
        `select payload->'detail'->>'change' as change from audit_logs where category = 'security' and event = 'api-key-changed'`,
      );
      expect(rows).toEqual([{ change: auditEvent }]);
    },
  );

  it('records a retention change as a security event, since shortening retention erases history', async () => {
    const res = await patch('/api/retention-config', { auditLogDays: 30 });
    expect(res.status).toBe(200);
    expect(await recorded('retention-settings-changed')).toBe(1);
  });
});
