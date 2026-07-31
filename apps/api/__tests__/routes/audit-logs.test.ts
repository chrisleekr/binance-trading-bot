import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * Verifies the per-profile audit reader filters by `payload->>profileId`,
 * pages via cursor, and returns null `nextCursor` when the page is short.
 *
 * Skipped when the test infra (DATABASE_TEST_URL) isn't present so the
 * vitest run still passes locally without a docker postgres on hand.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('GET /profiles/:profileId/audit-logs', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('returns rows scoped to the profile, paginated newest-first', async () => {
    const seed = async (event: string, payload: Record<string, unknown>): Promise<void> => {
      await fx.di.pool.query(
        `insert into audit_logs (operator_id, actor, event, payload, created_at)
         values ($1, 'web', $2, $3::jsonb, now() - ($4 || ' seconds')::interval)`,
        [fx.alice.userId, event, JSON.stringify(payload), '0'],
      );
    };
    // Same user, different profileId — must NOT appear.
    await seed('add-symbol', { profileId: 'other-profile', symbol: 'XRPUSDT' });
    // Three rows for alice's profile.
    for (let i = 0; i < 3; i++) {
      await seed('add-symbol', { profileId: fx.alice.profileId, symbol: `S${i}` });
    }

    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/audit-logs?limit=2`,
      {
        headers: { 'x-test-user-id': fx.alice.userId },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { event: string; payload: Record<string, unknown> }[];
      nextCursor: string | null;
    };
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).not.toBeNull();
    for (const item of body.items) {
      expect(item.payload).toMatchObject({ profileId: fx.alice.profileId });
    }
  });

  it('accepts the composite cursor it emits on the next-page request', async () => {
    for (let i = 0; i < 3; i++) {
      await fx.di.pool.query(
        `insert into audit_logs (operator_id, actor, event, payload, created_at)
         values ($1, 'web', 'add-symbol', $2::jsonb, now())`,
        [fx.alice.userId, JSON.stringify({ profileId: fx.alice.profileId, symbol: `C${i}` })],
      );
    }
    const page1 = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/audit-logs?limit=2`,
      {
        headers: { 'x-test-user-id': fx.alice.userId },
      },
    );
    const { nextCursor } = (await page1.json()) as { nextCursor: string | null };
    expect(nextCursor).not.toBeNull();
    // The `<createdAt-iso>__<id>` cursor must survive query-schema validation.
    const page2 = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/audit-logs?limit=2&cursor=${encodeURIComponent(
        nextCursor as string,
      )}`,
      { headers: { 'x-test-user-id': fx.alice.userId } },
    );
    expect(page2.status).toBe(200);
  });

  it('returns 404 when the profile is not owned by the caller', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/audit-logs`,
      {
        headers: { 'x-test-user-id': fx.alice.userId },
      },
    );
    expect(res.status).toBe(404);
  });

  it('returns nextCursor=null when the page is short', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/audit-logs?limit=200`,
      {
        headers: { 'x-test-user-id': fx.alice.userId },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    expect(body.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor with 422 (never a 500)', async () => {
    // Both cursor halves are guarded before the DB: an unparseable timestamp
    // and a non-uuid id would otherwise reach Postgres and 500.
    for (const bad of ['not-a-date', '2026-01-01T00:00:00.000Z__not-a-uuid']) {
      const res = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/audit-logs?cursor=${encodeURIComponent(bad)}`,
        { headers: { 'x-test-user-id': fx.alice.userId } },
      );
      expect(res.status).toBe(422);
    }
  });
});
