// The one place log retention and deep capture are configured.
//
// Two properties carry real consequence and so are pinned here. The patch is
// partial, so a save that touches one field must leave the others alone — a
// PATCH that reset a horizon it was never given would delete rows on the next
// sweep, silently and irreversibly. And deep capture is armed by a duration, not
// a deadline: the server owning the clock is the only reason an armed capture is
// guaranteed to lapse, whatever the browser's clock says.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

interface RetentionBody {
  actionLogDays: number;
  actionLogMaxRows: number;
  auditLogDays: number;
  auditStreamMaxlen: number;
  debugCapture: { profileId: string; until: string } | null;
  updatedAt: string;
}

describeIfInfra('/api/retention-config', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  const read = async (): Promise<RetentionBody> => {
    const res = await fx.app.request('/api/retention-config', {
      headers: { 'x-test-user-id': fx.alice.userId },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as RetentionBody;
  };

  const patch = (body: unknown): Promise<Response> =>
    fx.app.request('/api/retention-config', {
      method: 'PATCH',
      headers: { 'x-test-user-id': fx.alice.userId, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('serves the migration’s seeded defaults', async () => {
    const body = await read();
    // One day, not the 7 the table was created with: the horizon shortened once
    // current state moved out of the log stream into `condition_states`, so a
    // long-running condition no longer depends on an old log row surviving.
    expect(body.actionLogDays).toBe(1);
    expect(body.actionLogMaxRows).toBe(200_000);
    expect(body.auditLogDays).toBe(90);
    expect(body.auditStreamMaxlen).toBe(100_000);
    expect(body.debugCapture).toBeNull();
  });

  it('requires a user', async () => {
    expect((await fx.app.request('/api/retention-config')).status).toBe(401);
  });

  it('saves one field without disturbing the others', async () => {
    const before = await read();
    const res = await patch({ actionLogDays: 30 });
    expect(res.status).toBe(200);

    const after = (await res.json()) as RetentionBody;
    expect(after.actionLogDays).toBe(30);
    expect(after.actionLogMaxRows).toBe(before.actionLogMaxRows);
    expect(after.auditLogDays).toBe(before.auditLogDays);
    expect(after.auditStreamMaxlen).toBe(before.auditStreamMaxlen);
    expect(await read()).toMatchObject({ actionLogDays: 30 });
  });

  it('saves the row cap independently of the age horizon', async () => {
    // The two bounds answer different failures — how far back history reaches,
    // and how much one noisy profile may hold — so setting one must not move
    // the other. A cap edit that also reset the horizon would delete history
    // the operator never asked to lose.
    const before = await read();
    const res = await patch({ actionLogMaxRows: 50_000 });
    expect(res.status).toBe(200);

    const after = (await res.json()) as RetentionBody;
    expect(after.actionLogMaxRows).toBe(50_000);
    expect(after.actionLogDays).toBe(before.actionLogDays);
    expect(await read()).toMatchObject({ actionLogMaxRows: 50_000 });
  });

  it.each([
    ['a zero-day action horizon', { actionLogDays: 0 }],
    ['an action horizon past a year', { actionLogDays: 366 }],
    ['a fractional horizon', { actionLogDays: 7.5 }],
    ['a row cap below the floor', { actionLogMaxRows: 999 }],
    ['a row cap above the ceiling', { actionLogMaxRows: 10_000_001 }],
    ['a fractional row cap', { actionLogMaxRows: 5_000.5 }],
    ['a zero-day audit horizon', { auditLogDays: 0 }],
    ['a trim length below the floor', { auditStreamMaxlen: 999 }],
    ['a trim length above the ceiling', { auditStreamMaxlen: 5_000_001 }],
    [
      'a capture window past 24h',
      { debugCapture: { profileId: crypto.randomUUID(), minutes: 1441 } },
    ],
    ['a capture with no profile', { debugCapture: { minutes: 60 } }],
    ['an empty patch', {}],
  ])('rejects %s', async (_name, body) => {
    expect((await patch(body)).status).toBe(422);
  });

  it('leaves the stored value untouched when a patch is rejected', async () => {
    const before = await read();
    expect((await patch({ actionLogDays: 0 })).status).toBe(422);
    expect((await read()).actionLogDays).toBe(before.actionLogDays);
  });

  it('arms deep capture from a duration, deriving the deadline server-side', async () => {
    const sentAt = Date.now();
    const res = await patch({ debugCapture: { profileId: fx.alice.profileId, minutes: 60 } });
    expect(res.status).toBe(200);

    const body = (await res.json()) as RetentionBody;
    expect(body.debugCapture?.profileId).toBe(fx.alice.profileId);
    // The client never sends a deadline, so this timestamp can only have come
    // from the server's clock. A generous window keeps it from being a timing
    // test while still proving the duration was applied rather than echoed.
    const until = Date.parse(body.debugCapture?.until ?? '');
    expect(until).toBeGreaterThan(sentAt + 59 * 60_000);
    expect(until).toBeLessThan(sentAt + 61 * 60_000);
  });

  it('arming capture does not disturb the retention horizons', async () => {
    // Arming is a debugging action taken mid-incident. If it reset a horizon to
    // a default, the operator would lose history exactly when they need it.
    const body = await read();
    expect(body.actionLogDays).toBe(30);
    expect(body.debugCapture).not.toBeNull();
  });

  it('disarms on an explicit null', async () => {
    const res = await patch({ debugCapture: null });
    expect(res.status).toBe(200);
    expect(((await res.json()) as RetentionBody).debugCapture).toBeNull();
    expect((await read()).debugCapture).toBeNull();
  });

  it('reports a lapsed capture as off rather than as an expired window', async () => {
    // Nothing runs at expiry, so the read is what has to treat a past deadline
    // as off. A UI that still showed it armed would be claiming rows are being
    // written at full fidelity when they are not.
    await patch({ debugCapture: { profileId: fx.alice.profileId, minutes: 1 } });
    await fx.di.pool.query(
      `update retention_config set debug_capture_until = now() - interval '1 second'`,
    );
    expect((await read()).debugCapture).toBeNull();
  });

  it('records the change in the audit log so a shortened horizon has an author', async () => {
    await patch({ auditLogDays: 45 });
    const { rows } = await fx.di.pool.query<{ event: string; payload: { auditLogDays: number } }>(
      `select event, payload from audit_logs where event = 'set-retention-config'
       order by created_at desc limit 1`,
    );
    expect(rows[0]?.payload.auditLogDays).toBe(45);
  });
});
