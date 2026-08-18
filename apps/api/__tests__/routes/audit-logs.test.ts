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

  it('still accepts the legacy bare-ISO cursor, whose missing id keeps a same-timestamp group whole', async () => {
    // The wire contract documents this shape as accepted, and the new schema-level gate sits in front of it, so it needs a test of its own: `z.iso.datetime()` is STRICTER than the `Number.isNaN(new Date(...))` guard it replaced — it rejects a `+00:00` offset a Date parses happily — and nothing else would notice the branch closing.
    // One statement, one explicit stamp. Three separate inserts are three transactions and `now()` is transaction time, so they would land microseconds apart and there would be no same-timestamp group to keep whole. Dated ahead so these are the newest rows whatever else the suite has written.
    const seeded = await fx.di.pool.query<{ id: string }>(
      `insert into audit_logs (operator_id, actor, event, payload, created_at)
       select $1, 'web', 'add-symbol', jsonb_build_object('profileId', $2::text, 'symbol', s), $3::timestamptz
         from unnest(array['B0', 'B1', 'B2']) as s
       returning id`,
      [fx.alice.userId, fx.alice.profileId, '2029-05-05T05:05:05.000Z'],
    );
    const seededIds = seeded.rows.map((r) => r.id);
    expect(seededIds).toHaveLength(3);

    const page1 = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/audit-logs?limit=2`,
      { headers: { 'x-test-user-id': fx.alice.userId } },
    );
    const { nextCursor } = (await page1.json()) as { nextCursor: string | null };
    // The timestamp half of a cursor the route itself emitted, sent WITHOUT its row id.
    const bare = (nextCursor as string).split('__')[0] as string;
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/audit-logs?limit=5&cursor=${encodeURIComponent(bare)}`,
      { headers: { 'x-test-user-id': fx.alice.userId } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[] };
    // The whole group, not merely "a page". A missing id pairs with the maximum uuid, so the predicate reads as "everything before this instant, PLUS all of the group at it" — the row page 1 did not reach is re-shown rather than skipped. Asserting a non-empty page instead would pass on the suite's other rows while the third seeded row silently vanished.
    const returned = new Set(body.items.map((r) => r.id));
    for (const id of seededIds) expect(returned).toContain(id);
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

  it('rejects the two cursors a JS Date accepts and Postgres cannot bind', async () => {
    // `Number.isNaN(new Date(...))` is not the same question as "will Postgres take this as a timestamptz". A JS Date has a year zero (it reads as 1 BC) and parses a fractional second of any length, so both of these survive the guard, reach `$n::timestamptz`, and come back as a cast error — neither a statement timeout nor a checkout timeout, so it falls through the classifier to an unhandled 500 on a route whose only declared failure is 422.
    const id = '00000000-0000-4000-8000-0000000000c1';
    for (const bad of [
      `0000-01-01T00:00:00.000000Z__${id}`,
      `2026-01-01T00:00:00.${'1'.repeat(200)}Z__${id}`,
    ]) {
      const res = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/audit-logs?cursor=${encodeURIComponent(bad)}`,
        { headers: { 'x-test-user-id': fx.alice.userId } },
      );
      expect(res.status).toBe(422);
    }
  });
});
