import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DIAGNOSIS_STEPS } from '@app/contracts';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * Integration coverage for the diagnosis router. Two properties matter most:
 * the run row is durable and complete before the 202 is written (so the client
 * that renders the response already has a ladder and its first poll cannot
 * 404), and every endpoint resolves runs through the profile scope (so a run id
 * from another account's profile does not exist here rather than leaking a
 * report).
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const headers = (userId: string): Record<string, string> => ({
  'x-test-user-id': userId,
  'content-type': 'application/json',
});

interface RunBody {
  id: string;
  status: string;
  steps: { id: string; status: string; line: string }[];
  report: unknown;
  error: string | null;
  startedAtMs: number;
  finishedAtMs: number | null;
}

describeIfInfra('profile-diagnosis router', () => {
  let fx: ApiFixture;
  const base = (): string => `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`;

  const start = async (body = '{}'): Promise<Response> =>
    fx.app.request(`${base()}/diagnosis/runs`, {
      method: 'POST',
      headers: headers(fx.alice.userId),
      body,
    });

  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('persists a queued run with the whole ladder before answering 202', async () => {
    const res = await start('{"liveProbe":false}');
    expect(res.status).toBe(202);
    const run = (await res.json()) as RunBody;
    expect(run.status).toBe('queued');
    expect(run.report).toBeNull();
    expect(run.finishedAtMs).toBeNull();
    // Every rung pending, not an empty array: the checklist must render from the
    // very first response rather than appearing only once the worker writes.
    expect(run.steps.map((s) => s.id)).toEqual([...DIAGNOSIS_STEPS]);
    expect(run.steps.every((s) => s.status === 'pending')).toBe(true);

    // Durable, not just returned: a reload before the worker starts finds it.
    const { rows } = await fx.di.pool.query<{ status: string; profile_id: string }>(
      `select status, profile_id from diagnosis_runs where id = $1`,
      [run.id],
    );
    expect(rows[0]?.status).toBe('queued');
    expect(rows[0]?.profile_id).toBe(fx.alice.profileId);
  });

  it('defaults the live probe on when the body omits it', async () => {
    const res = await start('{}');
    expect(res.status).toBe(202);
    const run = (await res.json()) as RunBody;
    const job = await fx.di.diagnosisQueue.getJob(`diagnosis:${run.id}`);
    expect((job?.data as { liveProbe?: boolean } | undefined)?.liveProbe).toBe(true);
  });

  it('marks the run errored when the enqueue fails, so the poll stops waiting', async () => {
    // The row is seeded before the enqueue, so a Redis fault leaves a `queued`
    // row nothing will ever drain. Without the terminal write the client polls
    // it forever, on the one screen the operator opened because something was
    // already wrong.
    const add = vi
      .spyOn(fx.di.diagnosisQueue, 'add')
      .mockRejectedValueOnce(new Error('redis down'));
    try {
      const res = await start('{"liveProbe":false}');
      expect(res.status).toBeGreaterThanOrEqual(500);

      const { rows } = await fx.di.pool.query<{ status: string; error: string }>(
        `select status, error from diagnosis_runs where profile_id = $1
         order by started_at desc limit 1`,
        [fx.alice.profileId],
      );
      expect(rows[0]?.status).toBe('error');
      expect(rows[0]?.error).toBe('The investigation could not be started.');
    } finally {
      add.mockRestore();
    }
  });

  it('serves a run back by id and lists the recent ones newest-first', async () => {
    const created = (await (await start('{"liveProbe":false}')).json()) as RunBody;

    const one = await fx.app.request(`${base()}/diagnosis/runs/${created.id}`, {
      headers: headers(fx.alice.userId),
    });
    expect(one.status).toBe(200);
    expect(((await one.json()) as RunBody).id).toBe(created.id);

    const list = await fx.app.request(`${base()}/diagnosis/runs?limit=5`, {
      headers: headers(fx.alice.userId),
    });
    expect(list.status).toBe(200);
    const rows = (await list.json()) as RunBody[];
    expect(rows[0]?.id).toBe(created.id);
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  it('404s an unknown run id rather than 500-ing the poll', async () => {
    const res = await fx.app.request(
      `${base()}/diagnosis/runs/00000000-0000-4000-8000-000000000000`,
      { headers: headers(fx.alice.userId) },
    );
    expect(res.status).toBe(404);
  });

  it('denies cross-account start, read, and list', async () => {
    const created = (await (await start('{"liveProbe":false}')).json()) as RunBody;

    const startRes = await fx.app.request(`${base()}/diagnosis/runs`, {
      method: 'POST',
      headers: headers(fx.bob.userId),
      body: '{}',
    });
    expect(startRes.status).toBe(404);

    // The run id is real and Bob names Alice's account explicitly; the scope is
    // what refuses, not a guessed id.
    const readRes = await fx.app.request(`${base()}/diagnosis/runs/${created.id}`, {
      headers: headers(fx.bob.userId),
    });
    expect(readRes.status).toBe(404);

    const listRes = await fx.app.request(`${base()}/diagnosis/runs`, {
      headers: headers(fx.bob.userId),
    });
    expect(listRes.status).toBe(404);
  });

  it("does not leak Alice's run through Bob's own account path", async () => {
    const created = (await (await start('{"liveProbe":false}')).json()) as RunBody;
    const res = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/diagnosis/runs/${created.id}`,
      { headers: headers(fx.bob.userId) },
    );
    expect(res.status).toBe(404);
  });

  it('reports an unrecorded funnel as null, never as zero survivors', async () => {
    const res = await fx.app.request(`${base()}/discovery/funnel`, {
      headers: headers(fx.alice.userId),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { funnel: unknown }).toEqual({ funnel: null });
  });

  it('denies a cross-account funnel read', async () => {
    const res = await fx.app.request(`${base()}/discovery/funnel`, {
      headers: headers(fx.bob.userId),
    });
    expect(res.status).toBe(404);
  });
});
