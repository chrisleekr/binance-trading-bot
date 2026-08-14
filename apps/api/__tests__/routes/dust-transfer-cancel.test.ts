import { asProfileId, type ProfileId } from '@app/contracts';
import { profileRepo } from '@app/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * Cancel path for a queued dust conversion. Dust rows differ from symbol
 * overrides in three ways that this suite pins:
 *   - they carry `symbol = null`, so `record()` never supersedes a sibling and
 *     a profile can hold several pending rows at once;
 *   - the arm path writes no Redis override key, so there is nothing to evict;
 *   - a dust row is never pickup-stamped, so `processing_at` alone decides
 *     whether the worker is already spending the operator's balance.
 *
 * Seeded with its own profile rather than the fixture's: every assertion here
 * counts the dust rows under one profile, and the fixture profile is the one
 * the shared seed hands to every suite.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('dust-transfer cancel route', () => {
  let fx: ApiFixture;
  const PROFILE_ID: ProfileId = asProfileId('22222222-2222-4222-8222-222222222223');

  beforeAll(async () => {
    fx = await setupApp();
    await fx.di.pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
       values ($1, $2, 'dust-cancel-test', 'trailing-trade', '1.0.0', '{}', '{}')`,
      [PROFILE_ID, fx.alice.accountId],
    );
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  afterEach(async () => {
    await fx.di.pool.query('delete from override_actions');
    // Audit rows outlive the override rows by design, so a "no row was written"
    // assertion would otherwise be answered by whichever earlier test last wrote one.
    await fx.di.pool.query(`delete from audit_logs where event = 'dust-transfer-cancel'`);
  });

  const path = (): string =>
    `/api/accounts/${fx.alice.accountId}/profiles/${PROFILE_ID}/dust-transfer`;
  const headers = (): Record<string, string> => ({ 'x-test-user-id': fx.alice.userId });
  const repo = (): ReturnType<typeof profileRepo> =>
    profileRepo(fx.di.db, fx.alice.userId, fx.alice.accountId, PROFILE_ID);

  const seedPending = async (assets: string[]): Promise<string> => {
    const p = await repo();
    const row = await p.overrideActions.record({
      symbol: null,
      action: 'dust-transfer',
      actionAt: new Date(),
      payload: { assets },
      triggeredBy: 'user',
    });
    return row.id;
  };

  const liveIds = async (): Promise<string[]> => {
    const { rows } = await fx.di.pool.query<{ id: string }>(
      `select id from override_actions
        where profile_id = $1 and action = 'dust-transfer' and consumed_at is null
        order by created_at, id`,
      [PROFILE_ID],
    );
    return rows.map((r) => r.id);
  };

  const errorOf = async (res: Response): Promise<{ code?: string; message?: string }> => {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return body.error ?? {};
  };

  it('deletes a pending unclaimed dust row and answers 204', async () => {
    await seedPending(['TRX']);

    const res = await fx.app.request(path(), { method: 'DELETE', headers: headers() });
    expect(res.status).toBe(204);
    expect(await liveIds()).toEqual([]);
  });

  it('leaves a claimed conversion intact and answers 409 without claiming it was cancelled', async () => {
    // The worker owns this row and may already have sent convertDust: the balance
    // is moving. A 204 here reads as "your coins are safe" while they are being
    // converted, and the operator acts on that answer by looking away.
    const id = await seedPending(['TRX']);
    const p = await repo();
    expect(await p.overrideActions.claimAction(id, new Date())).toBe(true);

    const res = await fx.app.request(path(), { method: 'DELETE', headers: headers() });
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toMatch(/already/i);
    expect(error.message).not.toMatch(/cancell?ed/i);

    expect(await liveIds()).toEqual([id]);
  });

  it('answers 204 when the profile has no queued conversion, without asserting one existed', async () => {
    const res = await fx.app.request(path(), { method: 'DELETE', headers: headers() });
    expect(res.status).toBe(204);
    expect(res.headers.get('content-type')).toBeNull();

    // The asymmetry with the 409 case below, pinned from this side too. Pressing
    // cancel is operator intent worth keeping whether or not it found anything,
    // and `deleted: 0` is the only thing separating it from a cancel that removed
    // rows. Read alone, the 409 test reads as "never log a cancel that changed
    // nothing" — a rule that would delete this row and leave the suite green.
    const audit = await fx.di.pool.query<{ payload: { deleted: number; removedIds: string[] } }>(
      `select payload from audit_logs
        where operator_id = $1 and event = 'dust-transfer-cancel'
        order by created_at desc limit 1`,
      [fx.alice.userId],
    );
    expect(audit.rows[0]?.payload).toMatchObject({ deleted: 0, removedIds: [] });
  });

  it('deletes every unclaimed conversion in one call and still conflicts on a claimed one', async () => {
    // `record()` only supersedes when a symbol is set, so repeated dust arms stack.
    // Cancelling one row at a time would leave the operator pressing cancel until
    // the list happens to be empty.
    const claimedId = await seedPending(['TRX']);
    const p = await repo();
    expect(await p.overrideActions.claimAction(claimedId, new Date())).toBe(true);
    const queued = [await seedPending(['DOGE']), await seedPending(['SHIB'])];

    const res = await fx.app.request(path(), { method: 'DELETE', headers: headers() });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('CONFLICT');

    // Both queued ids are gone and only the claim survives, which is the whole
    // claim of this test: one call clears the set, the claim is not in it.
    expect(await liveIds()).toEqual([claimedId]);

    // The audit middleware skips its write on any 4xx, but two rows are already
    // hard-deleted by the time this 409 is raised. Without an explicit record the
    // cancel leaves no trace at all — the rows are gone and the operator only ever
    // saw an error.
    const audit = await fx.di.pool.query<{
      event: string;
      payload: { deleted: number; removedIds: string[] };
    }>(
      `select event, payload from audit_logs
        where operator_id = $1 and event = 'dust-transfer-cancel'
        order by created_at desc limit 1`,
      [fx.alice.userId],
    );
    expect(audit.rows[0]?.payload.deleted).toBe(2);
    // Named, not counted. The rows are hard-deleted, so this payload is the only
    // place left that can say WHICH conversions a disputed cancel removed.
    expect([...(audit.rows[0]?.payload.removedIds ?? [])].sort()).toEqual([...queued].sort());
  });

  it('records no audit row for a conflicting cancel that removed nothing', async () => {
    // The other side of the same rule: nothing changed, so writing a row would
    // invent a cancellation that never happened.
    const id = await seedPending(['TRX']);
    const p = await repo();
    expect(await p.overrideActions.claimAction(id, new Date())).toBe(true);

    const res = await fx.app.request(path(), { method: 'DELETE', headers: headers() });
    expect(res.status).toBe(409);

    const audit = await fx.di.pool.query(
      `select 1 from audit_logs where operator_id = $1 and event = 'dust-transfer-cancel'`,
      [fx.alice.userId],
    );
    expect(audit.rowCount).toBe(0);
  });

  it('keeps deferring to a claim inside the stale-claim horizon', async () => {
    // Six minutes is well inside the horizon the stale-claim reaper uses, and a
    // dispatch can genuinely run that long. The API must not call a claim dead
    // before the reaper has had its chance.
    const id = await seedPending(['TRX']);
    await fx.di.pool.query(
      `update override_actions set processing_at = now() - interval '6 minutes' where id = $1`,
      [id],
    );

    const res = await fx.app.request(path(), { method: 'DELETE', headers: headers() });
    expect(res.status).toBe(409);
    expect(await liveIds()).toEqual([id]);
  });

  it('cancels a claim stranded past the horizon instead of confirming a conversion that still runs', async () => {
    // Eleven minutes is past the shared stale-claim horizon, so the dust cron's
    // reaper resets this row to pending and converts it on the very same pass.
    // Answering 204 while leaving it in place tells the operator their coins are
    // safe and then spends them, which is the failure this route exists to end.
    const id = await seedPending(['TRX']);
    const p = await repo();
    expect(await p.overrideActions.claimAction(id, new Date())).toBe(true);
    await fx.di.pool.query(
      `update override_actions set processing_at = now() - interval '11 minutes' where id = $1`,
      [id],
    );

    const res = await fx.app.request(path(), { method: 'DELETE', headers: headers() });
    expect(res.status).toBe(204);
    expect(await liveIds()).toEqual([]);
  });

  it('declares 409 on the cancel route so the published contract stays honest', () => {
    // A route that can answer 409 while its OpenAPI map says 204 makes every
    // generated client treat the conflict as an unexpected failure, which is how
    // "the bot is already converting" becomes a generic error toast.
    const app = fx.app as unknown as {
      getOpenAPI31Document: (cfg: unknown) => {
        paths?: Record<string, { delete?: { responses?: Record<string, unknown> } }>;
      };
    };
    const doc = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'test', version: '0' },
    });
    const entry = Object.entries(doc.paths ?? {}).find(([p]) => p.endsWith('/dust-transfer'));
    expect(entry).toBeDefined();
    const responses = entry?.[1].delete?.responses ?? {};
    expect(Object.keys(responses)).toContain('409');
    // The repo's one error shape, not a bespoke body for this route. Pinned by
    // comparing against the 404 on the SAME route, which is `ErrorEnvelope` by
    // construction: a placeholder matcher would pass for any schema at all.
    const schemaOf = (code: string): unknown =>
      (responses[code] as { content?: Record<string, { schema?: unknown }> } | undefined)
        ?.content?.['application/json']?.schema;
    expect(schemaOf('409')).toBeDefined();
    expect(schemaOf('409')).toEqual(schemaOf('404'));
  });
});
