import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { profileRepo } from '@app/db';
import { BACKTEST_ENGINE_REVISION, configFingerprint } from '@app/strategy-core';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

// Account-scoped routes are mounted under `/accounts/:accountId`. Every helper
// receives a profileId; resolve its owning account (alice's profile lives under
// alice's account, bob's under bob's) so the URL names the right account.
const acctFor = (fx: ApiFixture, profileId: string): string =>
  profileId === fx.bob.profileId ? fx.bob.accountId : fx.alice.accountId;

const validParams = {
  symbols: ['BTCUSDT'],
  fromMs: 300_000,
  toMs: 600_000,
  strategyInterval: '1h',
  decisionInterval: '5m',
  detailInterval: '5m',
  initialQuoteBalance: '1000',
  fees: { makerBps: 10, takerBps: 10 },
  slippageBps: 5,
};

const post = (fx: ApiFixture, profileId: string, userId: string, body: unknown) =>
  fx.app.request(`/api/accounts/${acctFor(fx, profileId)}/profiles/${profileId}/backtests`, {
    method: 'POST',
    headers: { 'x-test-user-id': userId, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const action = (fx: ApiFixture, profileId: string, userId: string, runId: string, verb: string) =>
  fx.app.request(
    `/api/accounts/${acctFor(fx, profileId)}/profiles/${profileId}/backtests/${runId}/${verb}`,
    {
      method: 'POST',
      headers: { 'x-test-user-id': userId },
    },
  );

const del = (fx: ApiFixture, profileId: string, userId: string, runId: string) =>
  fx.app.request(
    `/api/accounts/${acctFor(fx, profileId)}/profiles/${profileId}/backtests/${runId}`,
    {
      method: 'DELETE',
      headers: { 'x-test-user-id': userId },
    },
  );

const getPrompt = (
  fx: ApiFixture,
  profileId: string,
  userId: string,
  runId: string,
  mode?: string,
) =>
  fx.app.request(
    `/api/accounts/${acctFor(fx, profileId)}/profiles/${profileId}/backtests/${runId}/advisor/manual/prompt${mode ? `?mode=${mode}` : ''}`,
    { method: 'GET', headers: { 'x-test-user-id': userId } },
  );

const postParse = (
  fx: ApiFixture,
  profileId: string,
  userId: string,
  runId: string,
  reply: string,
) =>
  fx.app.request(
    `/api/accounts/${acctFor(fx, profileId)}/profiles/${profileId}/backtests/${runId}/advisor/manual`,
    {
      method: 'POST',
      headers: { 'x-test-user-id': userId, 'content-type': 'application/json' },
      body: JSON.stringify({ reply }),
    },
  );

const getAdvisor = (fx: ApiFixture, profileId: string, userId: string, runId: string) =>
  fx.app.request(
    `/api/accounts/${acctFor(fx, profileId)}/profiles/${profileId}/backtests/${runId}/advisor`,
    {
      method: 'GET',
      headers: { 'x-test-user-id': userId },
    },
  );

const startAdvisor = (
  fx: ApiFixture,
  profileId: string,
  userId: string,
  runId: string,
  variant: string,
) =>
  fx.app.request(
    `/api/accounts/${acctFor(fx, profileId)}/profiles/${profileId}/backtests/${runId}/advisor/${variant}`,
    {
      method: 'POST',
      headers: { 'x-test-user-id': userId },
    },
  );

const patchBaseline = (
  fx: ApiFixture,
  profileId: string,
  userId: string,
  baselineBacktestRunId: string | null,
) =>
  fx.app.request(`/api/accounts/${acctFor(fx, profileId)}/profiles/${profileId}`, {
    method: 'PATCH',
    headers: { 'x-test-user-id': userId, 'content-type': 'application/json' },
    body: JSON.stringify({ baselineBacktestRunId }),
  });

// Drive a run to `done` directly via the repo (the worker does not run in
// tests), so the baseline-pin and improve-config paths have a real finished run.
const completeRun = async (fx: ApiFixture, params: unknown, result: unknown): Promise<string> => {
  const p = await profileRepo(fx.di.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
  const run = await p.backtestRuns.create({ symbols: ['BTCUSDT'], params });
  await p.backtestRuns.markRunning(run.id);
  await p.backtestRuns.complete(run.id, result);
  return run.id;
};

// A submission freezes the profile's config, and the fixture's stored config does not parse.
const setupBacktestApp = async (): Promise<ApiFixture> => {
  const fx = await setupApp();
  const plugin = fx.di.strategies.get('trailing-trade');
  if (!plugin) throw new Error('trailing-trade not registered');
  const config = plugin.defaultConfig as Record<string, unknown>;
  const p = await profileRepo(fx.di.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
  await p.profile.switchStrategy({
    strategyName: 'trailing-trade',
    strategyVersion: '2.0.0',
    config,
    state: plugin.initialState(config),
  });
  return fx;
};

describeIfInfra('backtests routes', () => {
  let fx: ApiFixture;
  beforeAll(async () => {
    fx = await setupBacktestApp();
  });
  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('POST enqueues a run and returns 202 + runId, then GET reads it back', async () => {
    const res = await post(fx, fx.alice.profileId, fx.alice.userId, validParams);
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);

    const got = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/backtests/${runId}`,
      {
        headers: { 'x-test-user-id': fx.alice.userId },
      },
    );
    expect(got.status).toBe(200);
    const detail = (await got.json()) as {
      status: string;
      progress: number;
      result: unknown;
      params: { fromMs: number; toMs: number };
    };
    expect(detail.status).toBe('queued');
    expect(detail.progress).toBe(0);
    expect(detail.result).toBeNull();
    // The launch params travel on the detail even before a result exists, so the
    // UI can seed Configure from a queued/running run.
    expect(detail.params.fromMs).toBe(validParams.fromMs);
    expect(detail.params.toMs).toBe(validParams.toMs);
  });

  it('GET list returns the profile runs in a paginated envelope', async () => {
    await post(fx, fx.alice.profileId, fx.alice.userId, validParams);
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/backtests`,
      {
        headers: { 'x-test-user-id': fx.alice.userId },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { fromMs: number; toMs: number }[];
      nextCursor: string | null;
      total: number;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect('nextCursor' in body).toBe(true);
    // The envelope carries an exact match count (over the same filter, ignoring
    // the page cursor) so the UI can render a page count.
    expect(typeof body.total).toBe('number');
    expect(body.total).toBeGreaterThanOrEqual(body.items.length);
    // Each item exposes the launch window for the runs table.
    expect(typeof body.items[0]?.fromMs).toBe('number');
    expect(typeof body.items[0]?.toMs).toBe('number');
  });

  it('GET list paginates by cursor with no overlap', async () => {
    // A fresh profile so the page math is independent of other tests' rows.
    const fresh = await setupBacktestApp();
    try {
      for (let i = 0; i < 3; i++) {
        const ok = await post(fresh, fresh.alice.profileId, fresh.alice.userId, validParams);
        expect(ok.status).toBe(202);
      }
      const url = `/api/accounts/${fresh.alice.accountId}/profiles/${fresh.alice.profileId}/backtests`;
      const headers = { 'x-test-user-id': fresh.alice.userId };

      const p1 = await fresh.app.request(`${url}?limit=2`, { headers });
      expect(p1.status).toBe(200);
      const page1 = (await p1.json()) as {
        items: { runId: string }[];
        nextCursor: string | null;
      };
      expect(page1.items.length).toBe(2);
      expect(page1.nextCursor).not.toBeNull();

      const p2 = await fresh.app.request(
        `${url}?limit=2&cursor=${encodeURIComponent(page1.nextCursor as string)}`,
        { headers },
      );
      expect(p2.status).toBe(200);
      const page2 = (await p2.json()) as {
        items: { runId: string }[];
        nextCursor: string | null;
      };
      // Last page: one row left, shorter than the limit → nextCursor null.
      expect(page2.items.length).toBe(1);
      expect(page2.nextCursor).toBeNull();

      const page1Ids = new Set(page1.items.map((r) => r.runId));
      expect(page2.items.every((r) => !page1Ids.has(r.runId))).toBe(true);
    } finally {
      await fresh.cleanup();
    }
  });

  it('still accepts the legacy bare-ISO cursor, whose missing id keeps a same-timestamp group whole', async () => {
    // The wire contract documents this shape as accepted, and the new schema-level gate sits in front of it, so it needs a test of its own: `z.iso.datetime()` is STRICTER than the `Number.isNaN(new Date(...))` guard it replaced — it rejects a `+00:00` offset a Date parses happily — and nothing else would notice the branch closing.
    const fresh = await setupBacktestApp();
    try {
      for (let i = 0; i < 3; i++) {
        const ok = await post(fresh, fresh.alice.profileId, fresh.alice.userId, validParams);
        expect(ok.status).toBe(202);
      }
      const url = `/api/accounts/${fresh.alice.accountId}/profiles/${fresh.alice.profileId}/backtests`;
      const headers = { 'x-test-user-id': fresh.alice.userId };

      const p1 = await fresh.app.request(`${url}?limit=2`, { headers });
      const page1 = (await p1.json()) as { nextCursor: string | null };
      // The timestamp half of a cursor the route itself emitted, sent WITHOUT its row id.
      const bare = (page1.nextCursor as string).split('__')[0] as string;

      const p2 = await fresh.app.request(`${url}?limit=2&cursor=${encodeURIComponent(bare)}`, {
        headers,
      });
      expect(p2.status).toBe(200);
      // A page, not an error envelope: the bare cursor has to page, not merely validate.
      const page2 = (await p2.json()) as { items: { runId: string }[] };
      expect(page2.items.length).toBeGreaterThan(0);
    } finally {
      await fresh.cleanup();
    }
  });

  it('GET list filters by outcome (profit / loss / error)', async () => {
    // Fresh profile so only the runs seeded here exist.
    const fresh = await setupBacktestApp();
    try {
      const url = `/api/accounts/${fresh.alice.accountId}/profiles/${fresh.alice.profileId}/backtests`;
      const headers = { 'x-test-user-id': fresh.alice.userId };
      // A profitable done run, a losing done run, and a queued (in-flight) run.
      const winId = await completeRun(fresh, validParams, { metrics: { totalReturnPct: 5 } });
      const lossId = await completeRun(fresh, validParams, { metrics: { totalReturnPct: -3 } });
      await post(fresh, fresh.alice.profileId, fresh.alice.userId, validParams);

      const profit = await fresh.app.request(`${url}?filter=profit`, { headers });
      expect(profit.status).toBe(200);
      const profitBody = (await profit.json()) as { items: { runId: string }[] };
      expect(profitBody.items.map((r) => r.runId)).toEqual([winId]);

      const loss = await fresh.app.request(`${url}?filter=loss`, { headers });
      const lossBody = (await loss.json()) as { items: { runId: string }[] };
      expect(lossBody.items.map((r) => r.runId)).toEqual([lossId]);

      // No errored run was seeded, so the error filter is empty.
      const errored = await fresh.app.request(`${url}?filter=error`, { headers });
      const erroredBody = (await errored.json()) as { items: unknown[]; nextCursor: string | null };
      expect(erroredBody.items.length).toBe(0);
      expect(erroredBody.nextCursor).toBeNull();
    } finally {
      await fresh.cleanup();
    }
  });

  it('paginates a filtered list by cursor with no overlap', async () => {
    // Three profitable done runs; filter=profit must compose with the cursor.
    const fresh = await setupBacktestApp();
    try {
      const url = `/api/accounts/${fresh.alice.accountId}/profiles/${fresh.alice.profileId}/backtests`;
      const headers = { 'x-test-user-id': fresh.alice.userId };
      for (let i = 0; i < 3; i++) {
        await completeRun(fresh, validParams, { metrics: { totalReturnPct: i + 1 } });
      }

      const p1 = await fresh.app.request(`${url}?filter=profit&limit=2`, { headers });
      const page1 = (await p1.json()) as { items: { runId: string }[]; nextCursor: string | null };
      expect(page1.items.length).toBe(2);
      expect(page1.nextCursor).not.toBeNull();

      const p2 = await fresh.app.request(
        `${url}?filter=profit&limit=2&cursor=${encodeURIComponent(page1.nextCursor as string)}`,
        { headers },
      );
      const page2 = (await p2.json()) as { items: { runId: string }[]; nextCursor: string | null };
      expect(page2.items.length).toBe(1);
      expect(page2.nextCursor).toBeNull();

      const page1Ids = new Set(page1.items.map((r) => r.runId));
      expect(page2.items.every((r) => !page1Ids.has(r.runId))).toBe(true);
    } finally {
      await fresh.cleanup();
    }
  });

  it('rejects an unknown filter with 422', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/backtests?filter=bogus`,
      {
        headers: { 'x-test-user-id': fx.alice.userId },
      },
    );
    expect(res.status).toBe(422);
  });

  it('rejects limit=0 with 422', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/backtests?limit=0`,
      {
        headers: { 'x-test-user-id': fx.alice.userId },
      },
    );
    expect(res.status).toBe(422);
  });

  it('rejects a malformed cursor with 422 (never a 500)', async () => {
    // Both cursor halves are guarded before the DB: an unparseable timestamp
    // and a non-uuid id would otherwise reach Postgres and 500.
    for (const bad of ['not-a-date', '2026-01-01T00:00:00.000Z__not-a-uuid']) {
      const res = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/backtests?cursor=${encodeURIComponent(bad)}`,
        { headers: { 'x-test-user-id': fx.alice.userId } },
      );
      expect(res.status).toBe(422);
    }
  });

  it('rejects the two cursors a JS Date accepts and Postgres cannot bind', async () => {
    // `Number.isNaN(new Date(...))` is not the same question as "will Postgres take this as a timestamptz". A JS Date has a year zero (it reads as 1 BC) and parses a fractional second of any length, so both of these survive the guard, reach `$n::timestamptz`, and come back as a cast error — neither a statement timeout nor a checkout timeout, so it falls through the classifier to an unhandled 500 on a route whose only declared failure is 422.
    const id = '00000000-0000-4000-8000-0000000000c2';
    for (const bad of [
      `0000-01-01T00:00:00.000000Z__${id}`,
      `2026-01-01T00:00:00.${'1'.repeat(200)}Z__${id}`,
    ]) {
      const res = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/backtests?cursor=${encodeURIComponent(bad)}`,
        { headers: { 'x-test-user-id': fx.alice.userId } },
      );
      expect(res.status).toBe(422);
    }
  });

  it('rejects invalid params with 422 VALIDATION_FAILED', async () => {
    const res = await post(fx, fx.alice.profileId, fx.alice.userId, {
      ...validParams,
      fromMs: 5_000,
      toMs: 1_000, // from >= to
    });
    expect(res.status).toBe(422);
  });

  it('C1 create with parentRunId of an owned run persists parent_run_id on the new run', async () => {
    const fresh = await setupBacktestApp();
    try {
      const parentId = await completeRun(fresh, validParams, { metrics: { totalReturnPct: 1 } });
      const res = await post(fresh, fresh.alice.profileId, fresh.alice.userId, {
        ...validParams,
        parentRunId: parentId,
      });
      expect(res.status).toBe(202);
      const { runId } = (await res.json()) as { runId: string };

      const got = await fresh.app.request(
        `/api/accounts/${fresh.alice.accountId}/profiles/${fresh.alice.profileId}/backtests/${runId}`,
        { headers: { 'x-test-user-id': fresh.alice.userId } },
      );
      const detail = (await got.json()) as { parentRunId: string | null };
      expect(detail.parentRunId).toBe(parentId);
    } finally {
      await fresh.cleanup();
    }
  });

  it('C8 create with a non-owned parentRunId persists null (no FK error, no cross-account link)', async () => {
    const fresh = await setupBacktestApp();
    try {
      // A run owned by bob, not alice, plus a random non-existent uuid: neither is
      // an owned run, so the new run must carry a null parent rather than 500 on a
      // foreign-key violation or link across the account boundary.
      const bob = await profileRepo(
        fresh.di.db,
        fresh.bob.userId,
        fresh.bob.accountId,
        fresh.bob.profileId,
      );
      const bobRun = await bob.backtestRuns.create({ symbols: ['BTCUSDT'], params: validParams });
      const RANDOM = 'b9999999-9999-4999-8999-999999999999';

      for (const parentRunId of [bobRun.id, RANDOM]) {
        const res = await post(fresh, fresh.alice.profileId, fresh.alice.userId, {
          ...validParams,
          parentRunId,
        });
        expect(res.status).toBe(202);
        const { runId } = (await res.json()) as { runId: string };
        const got = await fresh.app.request(
          `/api/accounts/${fresh.alice.accountId}/profiles/${fresh.alice.profileId}/backtests/${runId}`,
          { headers: { 'x-test-user-id': fresh.alice.userId } },
        );
        const detail = (await got.json()) as { parentRunId: string | null };
        expect(detail.parentRunId).toBeNull();
      }
    } finally {
      await fresh.cleanup();
    }
  });

  it('C3 GET run detail exposes parentRunId (null for a run with no parent)', async () => {
    const fresh = await setupBacktestApp();
    try {
      const created = await post(fresh, fresh.alice.profileId, fresh.alice.userId, validParams);
      const { runId } = (await created.json()) as { runId: string };
      const got = await fresh.app.request(
        `/api/accounts/${fresh.alice.accountId}/profiles/${fresh.alice.profileId}/backtests/${runId}`,
        { headers: { 'x-test-user-id': fresh.alice.userId } },
      );
      const detail = (await got.json()) as { parentRunId: string | null };
      expect(detail.parentRunId).toBeNull();
    } finally {
      await fresh.cleanup();
    }
  });

  it("cross-account GET of another profile's run returns 404", async () => {
    // Fresh app so this run is isolated from the rows earlier tests leave on the
    // shared fixture.
    const fresh = await setupBacktestApp();
    try {
      const created = await post(fresh, fresh.alice.profileId, fresh.alice.userId, validParams);
      const { runId } = (await created.json()) as { runId: string };
      // Bob asks under his own profile for Alice's runId → not found.
      const res = await fresh.app.request(
        `/api/accounts/${fresh.bob.accountId}/profiles/${fresh.bob.profileId}/backtests/${runId}`,
        { headers: { 'x-test-user-id': fresh.bob.userId } },
      );
      expect(res.status).toBe(404);
    } finally {
      await fresh.cleanup();
    }
  });

  it('cross-account POST to another profile returns 404', async () => {
    const res = await post(fx, fx.alice.profileId, fx.bob.userId, validParams);
    expect(res.status).toBe(404);
  });

  it('POST abort marks a queued run cancelled and returns its detail', async () => {
    const fresh = await setupBacktestApp();
    try {
      const created = await post(fresh, fresh.alice.profileId, fresh.alice.userId, validParams);
      const { runId } = (await created.json()) as { runId: string };

      const aborted = await action(
        fresh,
        fresh.alice.profileId,
        fresh.alice.userId,
        runId,
        'abort',
      );
      expect(aborted.status).toBe(200);
      const detail = (await aborted.json()) as { runId: string; status: string };
      expect(detail.runId).toBe(runId);
      expect(detail.status).toBe('cancelled');

      // The cancellation is durable: a follow-up GET still reads cancelled.
      const got = await fresh.app.request(
        `/api/accounts/${fresh.alice.accountId}/profiles/${fresh.alice.profileId}/backtests/${runId}`,
        { headers: { 'x-test-user-id': fresh.alice.userId } },
      );
      expect(((await got.json()) as { status: string }).status).toBe('cancelled');
    } finally {
      await fresh.cleanup();
    }
  });

  it('POST abort of an unknown run returns 404', async () => {
    // Valid uuid shape (so it clears param validation) that does not exist.
    const res = await action(
      fx,
      fx.alice.profileId,
      fx.alice.userId,
      'b9999999-9999-4999-8999-999999999999',
      'abort',
    );
    expect(res.status).toBe(404);
  });

  it('POST retry of an in-flight (queued) run returns 409', async () => {
    const fresh = await setupBacktestApp();
    try {
      const created = await post(fresh, fresh.alice.profileId, fresh.alice.userId, validParams);
      const { runId } = (await created.json()) as { runId: string };
      const res = await action(fresh, fresh.alice.profileId, fresh.alice.userId, runId, 'retry');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CONFLICT');
    } finally {
      await fresh.cleanup();
    }
  });

  it('POST retry of an aborted run creates a fresh queued run with a new id', async () => {
    const fresh = await setupBacktestApp();
    try {
      const created = await post(fresh, fresh.alice.profileId, fresh.alice.userId, validParams);
      const { runId } = (await created.json()) as { runId: string };
      await action(fresh, fresh.alice.profileId, fresh.alice.userId, runId, 'abort');

      const res = await action(fresh, fresh.alice.profileId, fresh.alice.userId, runId, 'retry');
      expect(res.status).toBe(202);
      const { runId: retriedId } = (await res.json()) as { runId: string };
      expect(retriedId).toMatch(/^[0-9a-f-]{36}$/);
      expect(retriedId).not.toBe(runId);

      const got = await fresh.app.request(
        `/api/accounts/${fresh.alice.accountId}/profiles/${fresh.alice.profileId}/backtests/${retriedId}`,
        { headers: { 'x-test-user-id': fresh.alice.userId } },
      );
      expect(((await got.json()) as { status: string }).status).toBe('queued');
    } finally {
      await fresh.cleanup();
    }
  });

  it('cross-account abort of another profile run returns 404', async () => {
    const fresh = await setupBacktestApp();
    try {
      const created = await post(fresh, fresh.alice.profileId, fresh.alice.userId, validParams);
      const { runId } = (await created.json()) as { runId: string };
      const res = await action(fresh, fresh.bob.profileId, fresh.bob.userId, runId, 'abort');
      expect(res.status).toBe(404);
    } finally {
      await fresh.cleanup();
    }
  });

  it('DELETE removes a terminal (cancelled) run; a follow-up GET 404s', async () => {
    const fresh = await setupBacktestApp();
    try {
      const created = await post(fresh, fresh.alice.profileId, fresh.alice.userId, validParams);
      const { runId } = (await created.json()) as { runId: string };
      await action(fresh, fresh.alice.profileId, fresh.alice.userId, runId, 'abort'); // → cancelled
      const res = await del(fresh, fresh.alice.profileId, fresh.alice.userId, runId);
      expect(res.status).toBe(204);
      const got = await fresh.app.request(
        `/api/accounts/${fresh.alice.accountId}/profiles/${fresh.alice.profileId}/backtests/${runId}`,
        { headers: { 'x-test-user-id': fresh.alice.userId } },
      );
      expect(got.status).toBe(404);
    } finally {
      await fresh.cleanup();
    }
  });

  it('DELETE of an in-flight (queued) run returns 409 — abort it first', async () => {
    const fresh = await setupBacktestApp();
    try {
      const created = await post(fresh, fresh.alice.profileId, fresh.alice.userId, validParams);
      const { runId } = (await created.json()) as { runId: string };
      const res = await del(fresh, fresh.alice.profileId, fresh.alice.userId, runId);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CONFLICT');
    } finally {
      await fresh.cleanup();
    }
  });

  it('DELETE of an unknown run returns 404', async () => {
    const res = await del(
      fx,
      fx.alice.profileId,
      fx.alice.userId,
      'b9999999-9999-4999-8999-999999999999',
    );
    expect(res.status).toBe(404);
  });

  it('cross-account DELETE of another profile run returns 404', async () => {
    const fresh = await setupBacktestApp();
    try {
      const created = await post(fresh, fresh.alice.profileId, fresh.alice.userId, validParams);
      const { runId } = (await created.json()) as { runId: string };
      await action(fresh, fresh.alice.profileId, fresh.alice.userId, runId, 'abort');
      const res = await del(fresh, fresh.bob.profileId, fresh.bob.userId, runId);
      expect(res.status).toBe(404);
    } finally {
      await fresh.cleanup();
    }
  });

  it('DELETE of the pinned baseline returns 409 until it is un-pinned', async () => {
    const fresh = await setupBacktestApp();
    try {
      const runId = await completeRun(fresh, validParams, { metrics: { totalReturnPct: 1 } });
      const pinned = await patchBaseline(fresh, fresh.alice.profileId, fresh.alice.userId, runId);
      expect(pinned.status).toBe(200);

      const blocked = await del(fresh, fresh.alice.profileId, fresh.alice.userId, runId);
      expect(blocked.status).toBe(409);

      await patchBaseline(fresh, fresh.alice.profileId, fresh.alice.userId, null);
      const ok = await del(fresh, fresh.alice.profileId, fresh.alice.userId, runId);
      expect(ok.status).toBe(204);
    } finally {
      await fresh.cleanup();
    }
  });

  // Drive a finished run on the real strategy's default config, so the manual
  // prompt/parse routes resolve a schema + a valid base config to patch.
  const completeRunWithRegistry = async (fresh: ApiFixture): Promise<string> => {
    const plugin = fresh.di.strategies.get('trailing-trade');
    const defaultConfig = plugin?.defaultConfig as Record<string, unknown>;
    const params = { ...validParams, strategyConfigOverride: defaultConfig };
    return completeRun(fresh, params, {
      params,
      metrics: { totalReturnPct: 1 },
      decisionBreakdown: { metrics: [], logs: [] },
    });
  };

  it('improve-config/prompt returns the manual prompt without needing an API key', async () => {
    const fresh = await setupBacktestApp();
    try {
      // Assist disabled — the manual prompt must still build (no 503).
      fresh.di.resolveLlm = async () => ({
        available: false,
        improveConfig: async () => ({ summary: '', suggestions: [] }),
      });
      const runId = await completeRunWithRegistry(fresh);
      const res = await getPrompt(fresh, fresh.alice.profileId, fresh.alice.userId, runId);
      expect(res.status).toBe(200);
      const { prompt } = (await res.json()) as { prompt: string };
      expect(prompt).toContain('Strategy trailing-trade@');
      // Carries the run context and the JSON-output instruction the manual loop needs.
      expect(prompt).toContain('totalReturnPct');
      expect(prompt).toContain('Respond with ONLY a JSON object');
      expect(prompt).toContain('"suggestions"');
      // The stored-units guidance reaches the manual prompt, so a model in
      // claude.ai is warned that a percent field is a fraction (0.5, not 50).
      expect(prompt).toContain('stored units');
    } finally {
      await fresh.cleanup();
    }
  });

  it('improve-config/prompt uses the safe prompt by default', async () => {
    const fresh = await setupBacktestApp();
    try {
      const runId = await completeRunWithRegistry(fresh);
      const res = await getPrompt(fresh, fresh.alice.profileId, fresh.alice.userId, runId);
      const { prompt } = (await res.json()) as { prompt: string };
      expect(prompt).toContain('no change beats holding cash');
      expect(prompt).not.toContain('EXPLORE mode');
    } finally {
      await fresh.cleanup();
    }
  });

  // Each EXPLORE variant steers the shared bold base with its own focus phrase, so
  // a mis-wired VARIANT_FOCUS key (wrong lens) fails here rather than shipping green.
  it.each([
    ['ride-trend', 'letting winners run'],
    ['trade-more', 'closed-trade count'],
    ['aggressive', 'larger position sizing'],
    ['defensive', 'cutting drawdown'],
  ])('improve-config/prompt steers the %s EXPLORE variant with its focus', async (mode, phrase) => {
    const fresh = await setupBacktestApp();
    try {
      const runId = await completeRunWithRegistry(fresh);
      const res = await getPrompt(fresh, fresh.alice.profileId, fresh.alice.userId, runId, mode);
      const { prompt } = (await res.json()) as { prompt: string };
      expect(prompt).toContain('EXPLORE mode');
      expect(prompt).toContain('HYPOTHESIS');
      expect(prompt).toContain(phrase);
      expect(prompt).not.toContain('no change beats holding cash');
    } finally {
      await fresh.cleanup();
    }
  });

  it('improve-config/prompt returns 404 for an unknown run', async () => {
    const res = await getPrompt(
      fx,
      fx.alice.profileId,
      fx.alice.userId,
      'b9999999-9999-4999-8999-999999999999',
    );
    expect(res.status).toBe(404);
  });

  it('improve-config/prompt returns 409 on a run with no result yet', async () => {
    const fresh = await setupBacktestApp();
    try {
      const created = await post(fresh, fresh.alice.profileId, fresh.alice.userId, validParams);
      const { runId } = (await created.json()) as { runId: string };
      const res = await getPrompt(fresh, fresh.alice.profileId, fresh.alice.userId, runId);
      expect(res.status).toBe(409);
    } finally {
      await fresh.cleanup();
    }
  });

  it('improve-config prompt carries no prior runs for a run from an unknown build', async () => {
    const fresh = await setupBacktestApp();
    try {
      const plugin = fresh.di.strategies.get('trailing-trade');
      const params = { ...validParams, strategyConfigOverride: plugin?.defaultConfig };
      const p = await profileRepo(
        fresh.di.db,
        fresh.alice.userId,
        fresh.alice.accountId,
        fresh.alice.profileId,
      );
      const run = await p.backtestRuns.create({ symbols: ['BTCUSDT'], params });
      await p.backtestRuns.markRunning(run.id);
      await p.backtestRuns.complete(
        run.id,
        {
          params,
          metrics: { totalReturnPct: 1 },
          decisionBreakdown: { metrics: [], logs: [] },
          simulation: { buildId: 'unknown', contextFingerprint: 'context-a' },
        },
        null,
        'current-run-signature',
      );
      // Same context string as the run: only the unknown build can keep this row out.
      await p.resultLedger.upsert({
        strategyId: 'trailing-trade',
        symbols: ['BTCUSDT'],
        window: {
          fromMs: validParams.fromMs,
          toMs: validParams.toMs,
          interval: '1h',
          contextFingerprint: 'context-a',
        },
        backtestSignature: 'other-sig',
        configFingerprint: 'fp-other',
        params: { marker: 'UNKNOWN_BUILD_MARKER' },
        outcome: { totalReturnPct: 42.5 },
      });

      const res = await getPrompt(fresh, fresh.alice.profileId, fresh.alice.userId, run.id);
      expect(res.status).toBe(200);
      const { prompt } = (await res.json()) as { prompt: string };
      expect(prompt).not.toContain('UNKNOWN_BUILD_MARKER');
    } finally {
      await fresh.cleanup();
    }
  });

  it('improve-config prompt carries prior same-market runs, excludes the current run by signature, and strips non-headline metrics', async () => {
    const fresh = await setupBacktestApp();
    try {
      const plugin = fresh.di.strategies.get('trailing-trade');
      const defaultConfig = plugin?.defaultConfig as Record<string, unknown>;
      const params = { ...validParams, strategyConfigOverride: defaultConfig };
      const p = await profileRepo(
        fresh.di.db,
        fresh.alice.userId,
        fresh.alice.accountId,
        fresh.alice.profileId,
      );
      // Complete the run with a KNOWN stored signature so we can seed a ledger row
      // that collides with it and prove the current run is excluded.
      const run = await p.backtestRuns.create({ symbols: ['BTCUSDT'], params });
      await p.backtestRuns.markRunning(run.id);
      const CURRENT_SIG = 'current-run-signature';
      await p.backtestRuns.complete(
        run.id,
        {
          params,
          metrics: { totalReturnPct: 1 },
          decisionBreakdown: { metrics: [], logs: [] },
          simulation: { contextFingerprint: 'context-a' },
        },
        null,
        CURRENT_SIG,
      );
      // Same market as validParams (symbols + window + interval). The worker writes
      // these in prod; completeRun bypasses it, so seed directly.
      const market = {
        strategyId: 'trailing-trade',
        symbols: ['BTCUSDT'],
        window: {
          fromMs: validParams.fromMs,
          toMs: validParams.toMs,
          interval: '1h',
          contextFingerprint: 'context-a',
        },
      } as const;
      await p.resultLedger.upsert({
        ...market,
        backtestSignature: 'other-sig',
        configFingerprint: 'fp-other',
        params: { marker: 'PRIOR_CONFIG_MARKER' },
        outcome: { totalReturnPct: 42.5, sharpe: 1.1, someHeavyKey: 'STRIP_ME' },
      });
      await p.resultLedger.upsert({
        ...market,
        backtestSignature: CURRENT_SIG,
        configFingerprint: 'fp-current',
        params: { marker: 'CURRENT_RUN_MARKER' },
        outcome: { totalReturnPct: 1 },
      });
      await p.resultLedger.upsert({
        ...market,
        window: { ...market.window, contextFingerprint: 'context-b' },
        backtestSignature: 'other-context-sig',
        configFingerprint: 'fp-context',
        params: { marker: 'OTHER_CONTEXT_MARKER' },
        outcome: { totalReturnPct: 3 },
      });

      const res = await getPrompt(fresh, fresh.alice.profileId, fresh.alice.userId, run.id);
      expect(res.status).toBe(200);
      const { prompt } = (await res.json()) as { prompt: string };
      expect(prompt).toContain('priorRuns:');
      // Prior run present; the current run is excluded by its stored signature.
      expect(prompt).toContain('PRIOR_CONFIG_MARKER');
      expect(prompt).not.toContain('CURRENT_RUN_MARKER');
      expect(prompt).not.toContain('OTHER_CONTEXT_MARKER');
      // Headline metric kept; a non-headline metric is stripped by compactMetrics.
      expect(prompt).toContain('42.5');
      expect(prompt).not.toContain('STRIP_ME');
    } finally {
      await fresh.cleanup();
    }
  });

  it('improve-config prompt downsamples the equity/drawdown curves and includes the exit-reason mix', async () => {
    const fresh = await setupBacktestApp();
    try {
      const plugin = fresh.di.strategies.get('trailing-trade');
      const defaultConfig = plugin?.defaultConfig as Record<string, unknown>;
      const params = { ...validParams, strategyConfigOverride: defaultConfig };
      // Curves far longer than the 80-point cap, and a known exit mix.
      const equityCurve = Array.from({ length: 300 }, (_, i) => ({
        tsMs: 1_000 + i,
        equity: '100',
      }));
      const drawdownSeries = Array.from({ length: 300 }, (_, i) => ({ tsMs: 1_000 + i, ddPct: 0 }));
      const trades = [
        {
          symbol: 'BTCUSDT',
          side: 'SELL',
          reason: 'technicals-force-sell',
          price: '1',
          qty: '1',
          feeQuote: '0',
          tsMs: 1,
        },
        {
          symbol: 'BTCUSDT',
          side: 'SELL',
          reason: 'technicals-force-sell',
          price: '1',
          qty: '1',
          feeQuote: '0',
          tsMs: 2,
        },
        {
          symbol: 'BTCUSDT',
          side: 'SELL',
          reason: 'grid-sell',
          price: '1',
          qty: '1',
          feeQuote: '0',
          tsMs: 3,
        },
        {
          symbol: 'BTCUSDT',
          side: 'BUY',
          reason: 'grid-buy',
          price: '1',
          qty: '1',
          feeQuote: '0',
          tsMs: 0,
        },
      ];
      const p = await profileRepo(
        fresh.di.db,
        fresh.alice.userId,
        fresh.alice.accountId,
        fresh.alice.profileId,
      );
      const run = await p.backtestRuns.create({ symbols: ['BTCUSDT'], params });
      await p.backtestRuns.markRunning(run.id);
      await p.backtestRuns.complete(run.id, {
        params,
        metrics: { totalReturnPct: 1 },
        decisionBreakdown: { metrics: [], logs: [] },
        equityCurve,
        drawdownSeries,
        trades,
      });

      const res = await getPrompt(fresh, fresh.alice.profileId, fresh.alice.userId, run.id);
      expect(res.status).toBe(200);
      const { prompt } = (await res.json()) as { prompt: string };
      // 300-point curves → 80 each. TOON declares the row count in the array
      // header, so the downsample is proven by the header, not a per-row count.
      expect(prompt).toContain('equityCurve[80]{tsMs,equity}:');
      expect(prompt).toContain('drawdownSeries[80]{tsMs,ddPct}:');
      // Exit-reason mix counts every sell (not the round-trip sample).
      expect(prompt).toContain('exitReasonCounts:');
      expect(prompt).toContain('"technicals-force-sell": 2');
      expect(prompt).toContain('"grid-sell": 1');
    } finally {
      await fresh.cleanup();
    }
  });

  it('improve-config prompt carries the live-gate checklist and data-coverage warnings', async () => {
    const fresh = await setupBacktestApp();
    try {
      const plugin = fresh.di.strategies.get('trailing-trade');
      const defaultConfig = plugin?.defaultConfig as Record<string, unknown>;
      const params = { ...validParams, strategyConfigOverride: defaultConfig };
      // A thin, patchy run: too few trades, no profit factor, negative alpha, and a
      // coverage gap, so every gate check fails. The advisor must SEE that bar.
      const metrics = {
        startingBalance: '1000',
        finalBalance: '1000',
        absoluteProfit: '0',
        totalReturnPct: 0,
        cagrPct: 0,
        marketChangePct: 0,
        dcaChangePct: 0,
        alphaVsHoldPct: -47.07,
        alphaVsDcaPct: 0,
        sharpe: null,
        sortino: null,
        calmar: 0,
        sqn: null,
        maxDrawdownPct: 0,
        absoluteDrawdown: '0',
        drawdownStartMs: null,
        drawdownEndMs: null,
        totalTrades: 12,
        winRate: 0,
        wins: 0,
        losses: 0,
        profitFactor: null,
        expectancy: '0',
        bestTradePct: null,
        worstTradePct: null,
        avgTradePnl: '0',
        avgTradeDurationMs: null,
      };
      const p = await profileRepo(
        fresh.di.db,
        fresh.alice.userId,
        fresh.alice.accountId,
        fresh.alice.profileId,
      );
      const run = await p.backtestRuns.create({ symbols: ['BTCUSDT'], params });
      await p.backtestRuns.markRunning(run.id);
      await p.backtestRuns.complete(run.id, {
        params,
        metrics,
        equityCurve: [],
        drawdownSeries: [],
        trades: [],
        perSymbol: [],
        decisionBreakdown: { metrics: [], logs: [] },
        dataWarnings: ['BTCUSDT: candle coverage 82% of requested window'],
        modelNotes: ['MODEL_NOTE_MARKER: exits not replayed minute by minute'],
      });

      const res = await getPrompt(fresh, fresh.alice.profileId, fresh.alice.userId, run.id);
      expect(res.status).toBe(200);
      const { prompt } = (await res.json()) as { prompt: string };
      // The gate checklist reaches the advisor as a TOON table, each bar's
      // pass/fail per row, so it targets the failing checks instead of the
      // metrics the gate ignores.
      expect(prompt).toContain('gateChecks[');
      expect(prompt).toContain('data coverage,false,gaps,no gaps');
      expect(prompt).toContain('closed trades,false,"12",>= 100');
      // The data-coverage warning is surfaced, not silently dropped.
      expect(prompt).toContain('dataWarnings[');
      expect(prompt).toContain('candle coverage 82%');
      // Modeling caveats travel separately so the advisor discounts them without treating them as bad data.
      expect(prompt).toContain('modelNotes[');
      expect(prompt).toContain('MODEL_NOTE_MARKER');
      // The honest baseline verdict is HOLD (lost to fee-free buy-and-hold).
      expect(prompt).toContain('recommend: hold');
      // Fill-model assumptions travel so the advisor can discount optimistic fills.
      expect(prompt).toContain('fillRealism:');
      expect(prompt).toContain('favorableIntrabar:');
      // A 1h strategy (validParams) has finer intervals available, so the advisor
      // MAY suggest a finer detail interval here. The finest-interval case is
      // covered by the sibling test below.
      expect(prompt).toContain('finerDetailAvailable: true');
      // The config schema stays JSON (TOON encodes an irregular schema larger),
      // so a quoted JSON-object key must still be present — this pins the
      // "selective" encoding: context is TOON, schema is not.
      expect(prompt).toContain('"type":');
    } finally {
      await fresh.cleanup();
    }
  });

  it('improve-config prompt marks the finest strategy interval as having no finer detail available', async () => {
    const fresh = await setupBacktestApp();
    try {
      const plugin = fresh.di.strategies.get('trailing-trade');
      const defaultConfig = plugin?.defaultConfig as Record<string, unknown>;
      // 1m is the finest supported interval, so no finer detail interval exists and
      // favorable intra-candle fills are inherent (detail == strategy). The advisor
      // must be told not to recommend a finer detail interval in this case.
      const params = {
        ...validParams,
        strategyInterval: '1m',
        detailInterval: '1m',
        strategyConfigOverride: defaultConfig,
      };
      const p = await profileRepo(
        fresh.di.db,
        fresh.alice.userId,
        fresh.alice.accountId,
        fresh.alice.profileId,
      );
      const run = await p.backtestRuns.create({ symbols: ['BTCUSDT'], params });
      await p.backtestRuns.markRunning(run.id);
      await p.backtestRuns.complete(run.id, {
        params,
        metrics: { totalReturnPct: 1 },
        decisionBreakdown: { metrics: [], logs: [] },
      });
      const res = await getPrompt(fresh, fresh.alice.profileId, fresh.alice.userId, run.id);
      expect(res.status).toBe(200);
      const { prompt } = (await res.json()) as { prompt: string };
      expect(prompt).toContain('finerDetailAvailable: false');
      expect(prompt).toContain('favorableIntrabar: true');
    } finally {
      await fresh.cleanup();
    }
  });

  it('improve-config prompt degrades to empty gate checklist and null verdict when the stored result does not fully parse', async () => {
    const fresh = await setupBacktestApp();
    try {
      // completeRunWithRegistry stores partial metrics ({ totalReturnPct: 1 }), so
      // toGateCandidates cannot parse the full result: gateMetrics is null. The
      // defensive branch must yield an empty checklist and a null verdict, never a
      // crash on a missing metric field.
      const runId = await completeRunWithRegistry(fresh);
      const res = await getPrompt(fresh, fresh.alice.profileId, fresh.alice.userId, runId);
      expect(res.status).toBe(200);
      const { prompt } = (await res.json()) as { prompt: string };
      expect(prompt).toContain('gateChecks: []');
      expect(prompt).toContain('tradeOrHold: null');
    } finally {
      await fresh.cleanup();
    }
  });

  it('improve-config/parse validates the reply and surfaces schema-invalid suggestions under `dropped`', async () => {
    const fresh = await setupBacktestApp();
    try {
      const runId = await completeRunWithRegistry(fresh);
      const reply = JSON.stringify({
        summary: 'manual read',
        suggestions: [
          {
            id: 'valid',
            title: 'Valid',
            rationale: 'r',
            changes: [{ path: 'candleInterval', value: '1h' }],
            expectedEffect: 'e',
            overfitRisk: 'low',
          },
          {
            id: 'invalid',
            title: 'Invalid',
            rationale: 'r',
            changes: [{ path: 'candleInterval', value: 'not-an-interval' }],
            expectedEffect: 'e',
            overfitRisk: 'high',
          },
        ],
      });
      const res = await postParse(fresh, fresh.alice.profileId, fresh.alice.userId, runId, reply);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        summary: string;
        suggestions: { id: string }[];
        dropped: { id: string; reason: string }[];
      };
      expect(body.summary).toBe('manual read');
      expect(body.suggestions.map((s) => s.id)).toEqual(['valid']);
      expect(body.dropped.map((d) => d.id)).toEqual(['invalid']);
      expect(body.dropped[0]?.reason).toContain('candleInterval');
    } finally {
      await fresh.cleanup();
    }
  });

  it('improve-config/parse returns 404 for an unknown run', async () => {
    const res = await postParse(
      fx,
      fx.alice.profileId,
      fx.alice.userId,
      'b9999999-9999-4999-8999-999999999999',
      '{}',
    );
    expect(res.status).toBe(404);
  });

  it('improve-config/parse returns 409 on a run with no result yet', async () => {
    const fresh = await setupBacktestApp();
    try {
      const created = await post(fresh, fresh.alice.profileId, fresh.alice.userId, validParams);
      const { runId } = (await created.json()) as { runId: string };
      const res = await postParse(fresh, fresh.alice.profileId, fresh.alice.userId, runId, '{}');
      expect(res.status).toBe(409);
    } finally {
      await fresh.cleanup();
    }
  });

  it('improve-config/parse extracts JSON from a markdown-fenced reply', async () => {
    const fresh = await setupBacktestApp();
    try {
      const runId = await completeRunWithRegistry(fresh);
      const json = JSON.stringify({
        summary: 'fenced',
        suggestions: [
          {
            id: 'v',
            title: 'V',
            rationale: 'r',
            changes: [{ path: 'candleInterval', value: '1h' }],
            expectedEffect: 'e',
            overfitRisk: 'low',
          },
        ],
      });
      const reply = `Here are my ideas:\n\n\`\`\`json\n${json}\n\`\`\`\n\nHope that helps!`;
      const res = await postParse(fresh, fresh.alice.profileId, fresh.alice.userId, runId, reply);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { summary: string };
      expect(body.summary).toBe('fenced');
    } finally {
      await fresh.cleanup();
    }
  });

  it('improve-config/parse returns 422 on a reply with no JSON object', async () => {
    const fresh = await setupBacktestApp();
    try {
      const runId = await completeRunWithRegistry(fresh);
      const res = await postParse(
        fresh,
        fresh.alice.profileId,
        fresh.alice.userId,
        runId,
        'sorry, I have no suggestions for you',
      );
      expect(res.status).toBe(422);
    } finally {
      await fresh.cleanup();
    }
  });

  it('improve-config/parse returns 422 on a JSON reply of the wrong shape', async () => {
    const fresh = await setupBacktestApp();
    try {
      const runId = await completeRunWithRegistry(fresh);
      const res = await postParse(
        fresh,
        fresh.alice.profileId,
        fresh.alice.userId,
        runId,
        JSON.stringify({ not: 'the right shape' }),
      );
      expect(res.status).toBe(422);
    } finally {
      await fresh.cleanup();
    }
  });

  // Regression: a run whose override is a PARTIAL diff (the advisor/guided
  // shape, e.g. only the tuned keys) must be merged onto the profile config
  // before re-validation. Using the raw partial override as the base fails the
  // full strategy schema and silently drops every suggestion.
  it('improve-config/parse merges a partial override onto the profile config', async () => {
    const fresh = await setupBacktestApp();
    try {
      const plugin = fresh.di.strategies.get('trailing-trade');
      if (!plugin) throw new Error('trailing-trade not registered');
      const fullConfig = plugin.defaultConfig as Record<string, unknown>;
      // The fixture profile's config is `{}`; give it a full, valid config so the
      // partial override has something to merge onto (as in production).
      const p = await profileRepo(
        fresh.di.db,
        fresh.alice.userId,
        fresh.alice.accountId,
        fresh.alice.profileId,
      );
      await p.profile.switchStrategy({
        strategyName: 'trailing-trade',
        strategyVersion: '2.0.0',
        config: fullConfig,
        state: plugin.initialState(fullConfig),
      });
      // A partial override — only the keys a guided/advisor run tunes.
      const params = {
        ...validParams,
        strategyConfigOverride: { sell: { triggerPercentage: '1.03' } },
      };
      const runId = await completeRun(fresh, params, {
        params,
        metrics: { totalReturnPct: 1 },
        decisionBreakdown: { metrics: [], logs: [] },
      });

      const reply = JSON.stringify({
        summary: 's',
        suggestions: [
          {
            id: 'v',
            title: 'Valid',
            rationale: 'r',
            changes: [{ path: 'candleInterval', value: '1h' }],
            expectedEffect: 'e',
            overfitRisk: 'low',
          },
        ],
      });
      const res = await postParse(fresh, fresh.alice.profileId, fresh.alice.userId, runId, reply);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { suggestions: { id: string }[] };
      // Pre-fix the base was the bare partial override → schema parse fails →
      // suggestion dropped → []. With the merge the patch lands on a full config.
      expect(body.suggestions.map((s) => s.id)).toEqual(['v']);
    } finally {
      await fresh.cleanup();
    }
  });

  // Stored params that predate the params schema (missing required fields) fail
  // BacktestParamsSchema on read, so buildImproveInput falls back to the raw blob
  // — a still-usable override must recover rather than 500 or drop everything.
  it('improve-config/parse recovers when stored params no longer parse (raw fallback)', async () => {
    const fresh = await setupBacktestApp();
    try {
      const plugin = fresh.di.strategies.get('trailing-trade');
      if (!plugin) throw new Error('trailing-trade not registered');
      const fullConfig = plugin.defaultConfig as Record<string, unknown>;
      const p = await profileRepo(
        fresh.di.db,
        fresh.alice.userId,
        fresh.alice.accountId,
        fresh.alice.profileId,
      );
      await p.profile.switchStrategy({
        strategyName: 'trailing-trade',
        strategyVersion: '2.0.0',
        config: fullConfig,
        state: plugin.initialState(fullConfig),
      });
      // A legacy params blob: missing the required fields → safeParse fails.
      const legacyParams = { strategyConfigOverride: { sell: { triggerPercentage: '1.03' } } };
      const runId = await completeRun(fresh, legacyParams, {
        params: legacyParams,
        metrics: { totalReturnPct: 1 },
        decisionBreakdown: { metrics: [], logs: [] },
      });
      const reply = JSON.stringify({
        summary: 's',
        suggestions: [
          {
            id: 'v',
            title: 'Valid',
            rationale: 'r',
            changes: [{ path: 'candleInterval', value: '1h' }],
            expectedEffect: 'e',
            overfitRisk: 'low',
          },
        ],
      });
      const res = await postParse(fresh, fresh.alice.profileId, fresh.alice.userId, runId, reply);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { suggestions: { id: string }[] };
      expect(body.suggestions.map((s) => s.id)).toEqual(['v']);
    } finally {
      await fresh.cleanup();
    }
  });

  // The reconstructed base (merged profile config + override) must still satisfy
  // the strategy schema. A profile whose config has drifted off-schema since the
  // run can no longer be reconstructed, so the advisor fails closed with 409
  // rather than silently dropping every suggestion.
  it('improve-config/prompt returns 409 when the profile config no longer matches the schema', async () => {
    const fresh = await setupBacktestApp();
    try {
      const p = await profileRepo(
        fresh.di.db,
        fresh.alice.userId,
        fresh.alice.accountId,
        fresh.alice.profileId,
      );
      // Drift the profile config off-schema (an interval the schema rejects).
      await p.profile.switchStrategy({
        strategyName: 'trailing-trade',
        strategyVersion: '2.0.0',
        config: { candleInterval: 'not-an-interval' },
        state: {},
      });
      const params = { ...validParams, strategyConfigOverride: null };
      const runId = await completeRun(fresh, params, {
        params,
        metrics: { totalReturnPct: 1 },
        decisionBreakdown: { metrics: [], logs: [] },
      });
      const res = await getPrompt(fresh, fresh.alice.profileId, fresh.alice.userId, runId);
      expect(res.status).toBe(409);
    } finally {
      await fresh.cleanup();
    }
  });

  it('advisor list rehydrates saved variant rows without calling the model', async () => {
    const fresh = await setupBacktestApp();
    try {
      const runId = await completeRunWithRegistry(fresh);
      // The list route is a pure DB read; prove it never reaches the model by
      // making a call throw, then asserting the saved row still comes back.
      const baseLlm = await fresh.di.resolveLlm();
      fresh.di.resolveLlm = async () => ({
        ...baseLlm,
        improveConfig: async () => {
          throw new Error('list route must not call the model');
        },
      });
      const p = await profileRepo(
        fresh.di.db,
        fresh.alice.userId,
        fresh.alice.accountId,
        fresh.alice.profileId,
      );
      await p.backtestAdvisorResults.transitionToRunning({ runId, variant: 'safe' });
      await p.backtestAdvisorResults.completeVariant({
        runId,
        variant: 'safe',
        status: 'done',
        summary: 'saved safe',
        suggestions: [],
        dropped: [],
        errorReason: null,
      });
      const res = await getAdvisor(fresh, fresh.alice.profileId, fresh.alice.userId, runId);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: { variant: string; status: string; summary: string | null }[];
      };
      expect(body.results).toHaveLength(1);
      expect(body.results[0]?.variant).toBe('safe');
      expect(body.results[0]?.status).toBe('done');
      expect(body.results[0]?.summary).toBe('saved safe');
    } finally {
      await fresh.cleanup();
    }
  });

  it('advisor start claims the slot, enqueues one job, and returns the running row', async () => {
    const fresh = await setupBacktestApp();
    try {
      const runId = await completeRunWithRegistry(fresh);
      await fresh.di.redis.raw().set('advisor:ready', '1');
      const addSpy = vi.spyOn(fresh.di.advisorQueue, 'add').mockResolvedValue({} as never);
      const res = await startAdvisor(
        fresh,
        fresh.alice.profileId,
        fresh.alice.userId,
        runId,
        'safe',
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as { variant: string; status: string };
      expect(body.variant).toBe('safe');
      expect(body.status).toBe('running');
      expect(addSpy).toHaveBeenCalledTimes(1);
      expect(addSpy).toHaveBeenCalledWith('advisor', {
        runId,
        userId: fresh.alice.userId,
        accountId: fresh.alice.accountId,
        profileId: fresh.alice.profileId,
        variant: 'safe',
      });
      addSpy.mockRestore();
    } finally {
      await fresh.cleanup();
    }
  });

  it('advisor start returns 503 when the study worker is offline (advisor:ready unset)', async () => {
    const fresh = await setupBacktestApp();
    try {
      const runId = await completeRunWithRegistry(fresh);
      await fresh.di.redis.raw().del('advisor:ready');
      const addSpy = vi.spyOn(fresh.di.advisorQueue, 'add').mockResolvedValue({} as never);
      const res = await startAdvisor(
        fresh,
        fresh.alice.profileId,
        fresh.alice.userId,
        runId,
        'safe',
      );
      expect(res.status).toBe(503);
      expect(addSpy).not.toHaveBeenCalled();
      addSpy.mockRestore();
    } finally {
      await fresh.cleanup();
    }
  });

  it('advisor start does not enqueue a second job while a variant is already running', async () => {
    const fresh = await setupBacktestApp();
    try {
      const runId = await completeRunWithRegistry(fresh);
      await fresh.di.redis.raw().set('advisor:ready', '1');
      const addSpy = vi.spyOn(fresh.di.advisorQueue, 'add').mockResolvedValue({} as never);
      const first = await startAdvisor(
        fresh,
        fresh.alice.profileId,
        fresh.alice.userId,
        runId,
        'safe',
      );
      expect(first.status).toBe(202);
      // Row is now `running`; the conditional upsert refuses to re-claim it, so no
      // duplicate job is enqueued — the poll picks up the in-flight one.
      const second = await startAdvisor(
        fresh,
        fresh.alice.profileId,
        fresh.alice.userId,
        runId,
        'safe',
      );
      expect(second.status).toBe(202);
      const body = (await second.json()) as { status: string };
      expect(body.status).toBe('running');
      expect(addSpy).toHaveBeenCalledTimes(1);
      addSpy.mockRestore();
    } finally {
      await fresh.cleanup();
    }
  });

  it('advisor start rejects an unknown variant', async () => {
    const fresh = await setupBacktestApp();
    try {
      const runId = await completeRunWithRegistry(fresh);
      await fresh.di.redis.raw().set('advisor:ready', '1');
      // `manual` is claimed by the static manual route, so the enum guard is what
      // rejects a value outside the five generation variants. Path-param enum
      // validation fails before any state change (project convention maps
      // input-validation to 422, not a bare 400).
      const res = await startAdvisor(
        fresh,
        fresh.alice.profileId,
        fresh.alice.userId,
        runId,
        'bogus',
      );
      expect(res.status).toBe(422);
    } finally {
      await fresh.cleanup();
    }
  });

  it('advisor start returns 409 when the run has no result to advise on yet', async () => {
    const fresh = await setupBacktestApp();
    try {
      // A queued/running run has no result: advising is meaningless, so the route
      // fails fast BEFORE touching the queue. (Re-covers the guard the deleted
      // improve-config 409 test used to exercise.)
      const p = await profileRepo(
        fresh.di.db,
        fresh.alice.userId,
        fresh.alice.accountId,
        fresh.alice.profileId,
      );
      const run = await p.backtestRuns.create({ symbols: ['BTCUSDT'], params: validParams });
      await p.backtestRuns.markRunning(run.id);
      await fresh.di.redis.raw().set('advisor:ready', '1');
      const res = await startAdvisor(
        fresh,
        fresh.alice.profileId,
        fresh.alice.userId,
        run.id,
        'safe',
      );
      expect(res.status).toBe(409);
    } finally {
      await fresh.cleanup();
    }
  });

  it('advisor start frees the slot (row error) and returns 500 when the enqueue fails', async () => {
    const fresh = await setupBacktestApp();
    try {
      const runId = await completeRunWithRegistry(fresh);
      await fresh.di.redis.raw().set('advisor:ready', '1');
      // The row is transitioned to `running` before the enqueue; a failing add
      // would strand it there, so the route completes it `error` to free the slot.
      const addSpy = vi
        .spyOn(fresh.di.advisorQueue, 'add')
        .mockRejectedValue(new Error('redis down'));
      const res = await startAdvisor(
        fresh,
        fresh.alice.profileId,
        fresh.alice.userId,
        runId,
        'safe',
      );
      expect(res.status).toBe(500);
      const p = await profileRepo(
        fresh.di.db,
        fresh.alice.userId,
        fresh.alice.accountId,
        fresh.alice.profileId,
      );
      const row = await p.backtestAdvisorResults.getVariant(runId, 'safe');
      expect(row?.status).toBe('error');
      addSpy.mockRestore();
    } finally {
      await fresh.cleanup();
    }
  });

  it('advisor manual persists the manual slot, leaves a server safe row untouched, enqueues nothing', async () => {
    const fresh = await setupBacktestApp();
    try {
      const runId = await completeRunWithRegistry(fresh);
      const p = await profileRepo(
        fresh.di.db,
        fresh.alice.userId,
        fresh.alice.accountId,
        fresh.alice.profileId,
      );
      // A pre-existing server-generated `safe` row that must survive the manual write.
      await p.backtestAdvisorResults.transitionToRunning({ runId, variant: 'safe' });
      await p.backtestAdvisorResults.completeVariant({
        runId,
        variant: 'safe',
        status: 'done',
        summary: 'server safe',
        suggestions: [],
        dropped: [],
        errorReason: null,
      });
      const addSpy = vi.spyOn(fresh.di.advisorQueue, 'add').mockResolvedValue({} as never);
      const reply = JSON.stringify({
        summary: 'manual read',
        suggestions: [
          {
            id: 'v',
            title: 'V',
            rationale: 'r',
            changes: [{ path: 'candleInterval', value: '1h' }],
            expectedEffect: 'e',
            overfitRisk: 'low',
          },
        ],
      });
      const res = await postParse(fresh, fresh.alice.profileId, fresh.alice.userId, runId, reply);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        variant: string;
        status: string;
        summary: string | null;
      };
      expect(body.variant).toBe('manual');
      expect(body.status).toBe('done');
      expect(body.summary).toBe('manual read');
      expect(addSpy).not.toHaveBeenCalled();
      const rows = await p.backtestAdvisorResults.listForRun(runId);
      const summaryByVariant = Object.fromEntries(rows.map((r) => [r.variant, r.summary]));
      expect(summaryByVariant['safe']).toBe('server safe');
      expect(summaryByVariant['manual']).toBe('manual read');
      addSpy.mockRestore();
    } finally {
      await fresh.cleanup();
    }
  });

  describe('submission', () => {
    const backtestsUrl = (f: ApiFixture): string =>
      `/api/accounts/${f.alice.accountId}/profiles/${f.alice.profileId}/backtests`;
    const aliceRepo = (f: ApiFixture) =>
      profileRepo(f.di.db, f.alice.userId, f.alice.accountId, f.alice.profileId);
    const postQuery = (f: ApiFixture, query: string) =>
      f.app.request(`${backtestsUrl(f)}${query}`, {
        method: 'POST',
        headers: { 'x-test-user-id': f.alice.userId, 'content-type': 'application/json' },
        body: JSON.stringify(validParams),
      });
    const storedSnapshot = async (f: ApiFixture, runId: string) => {
      const run = await (await aliceRepo(f)).backtestRuns.get(runId);
      return (run?.params as { snapshot?: { effectiveConfig: Record<string, unknown> } }).snapshot;
    };
    const editTrigger = async (f: ApiFixture, triggerPercentage: string): Promise<void> => {
      const p = await aliceRepo(f);
      const row = await p.profile.findById();
      const config = row?.config as { sell: object };
      await p.profile.update({
        config: { ...config, sell: { ...config.sell, triggerPercentage } },
      });
    };

    it('identical submissions create distinct runs; force harmless', async () => {
      const f = await setupBacktestApp();
      try {
        const ids: string[] = [];
        for (const query of ['', '', '?force=false', '?force=true', '?force']) {
          const res = await postQuery(f, query);
          expect(res.status).toBe(202);
          const body = (await res.json()) as { runId: string };
          expect(Object.keys(body)).toEqual(['runId']);
          ids.push(body.runId);
        }
        expect(new Set(ids).size).toBe(5);
        expect((await postQuery(f, '?force=yes')).status).toBe(422);
      } finally {
        await f.cleanup();
      }
    });

    it.each([
      ['no decision interval', { decisionInterval: undefined }],
      ['a detail interval coarser than the decision', { detailInterval: '15m' }],
      ['a detail interval that does not divide the decision', { detailInterval: '3m' }],
      ['a start off the detail grid', { fromMs: 300_001 }],
      ['an end off the detail grid', { toMs: 600_001 }],
      [
        'a run past the replay budget',
        { detailInterval: '1m', decisionInterval: '1m', fromMs: 0, toMs: 600_000 * 60_000 },
      ],
    ])('rejects %s rather than shifting it', async (_name, change) => {
      const res = await post(fx, fx.alice.profileId, fx.alice.userId, {
        ...validParams,
        ...change,
      });
      expect(res.status).toBe(422);
    });

    it('rejects detail coarser than the effective candle interval', async () => {
      const f = await setupBacktestApp();
      try {
        const res = await post(f, f.alice.profileId, f.alice.userId, {
          ...validParams,
          strategyConfigOverride: { candleInterval: '1m' },
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { message: string } };
        expect(body.error.message).toMatch(/must not be coarser than the config's candle interval/);
        expect(await (await aliceRepo(f)).backtestRuns.list({ limit: 10 })).toEqual([]);
      } finally {
        await f.cleanup();
      }
    });

    it('rejects a config the strategy cannot parse before storing anything', async () => {
      const f = await setupApp();
      try {
        const res = await post(f, f.alice.profileId, f.alice.userId, validParams);
        expect(res.status).toBe(422);
        expect(await (await aliceRepo(f)).backtestRuns.list({ limit: 10 })).toEqual([]);
      } finally {
        await f.cleanup();
      }
    });

    it('executes the config accepted at submission, and a retry keeps it', async () => {
      const f = await setupBacktestApp();
      try {
        await editTrigger(f, '1.03');
        const created = await post(f, f.alice.profileId, f.alice.userId, validParams);
        const { runId } = (await created.json()) as { runId: string };
        const frozen = await storedSnapshot(f, runId);
        expect(frozen?.effectiveConfig['sell']).toMatchObject({ triggerPercentage: '1.03' });

        await editTrigger(f, '1.09');
        expect(await storedSnapshot(f, runId)).toEqual(frozen);

        await action(f, f.alice.profileId, f.alice.userId, runId, 'abort');
        const retried = await action(f, f.alice.profileId, f.alice.userId, runId, 'retry');
        const { runId: retriedId } = (await retried.json()) as { runId: string };
        expect(await storedSnapshot(f, retriedId)).toEqual(frozen);
      } finally {
        await f.cleanup();
      }
    });

    it('refuses to retry a run frozen on another build and queues nothing', async () => {
      const f = await setupBacktestApp();
      try {
        const created = await post(f, f.alice.profileId, f.alice.userId, validParams);
        const { runId } = (await created.json()) as { runId: string };
        await action(f, f.alice.profileId, f.alice.userId, runId, 'abort');
        const p = await aliceRepo(f);
        const original = await p.backtestRuns.get(runId);
        const params = original?.params as { snapshot: Record<string, unknown> };
        const stale = await p.backtestRuns.create({
          symbols: original!.symbols,
          params: { ...params, snapshot: { ...params.snapshot, buildId: 'oldsha' } },
        });
        await p.backtestRuns.markCancelled(stale.id);
        const before = (await p.backtestRuns.list({ limit: 10 })).length;

        const res = await action(f, f.alice.profileId, f.alice.userId, stale.id, 'retry');
        expect(res.status).toBe(409);
        expect((await p.backtestRuns.list({ limit: 10 })).length).toBe(before);
      } finally {
        await f.cleanup();
      }
    });

    it('ignores a snapshot sent by the client and keeps the stored one off the wire', async () => {
      const f = await setupBacktestApp();
      try {
        const forged = {
          strategyName: 'forged',
          strategyVersion: '9',
          engineRevision: 0,
          buildId: 'forged',
          effectiveConfig: { forged: true },
        };
        const created = await post(f, f.alice.profileId, f.alice.userId, {
          ...validParams,
          snapshot: forged,
        });
        const { runId } = (await created.json()) as { runId: string };
        const stored = await storedSnapshot(f, runId);
        expect(stored).toMatchObject({ strategyName: 'trailing-trade' });
        expect(stored?.effectiveConfig).not.toHaveProperty('forged');

        const got = await f.app.request(`${backtestsUrl(f)}/${runId}`, {
          headers: { 'x-test-user-id': f.alice.userId },
        });
        expect(((await got.json()) as { params: object }).params).not.toHaveProperty('snapshot');
      } finally {
        await f.cleanup();
      }
    });

    it('reports whether a finished run still matches the profile config', async () => {
      const f = await setupBacktestApp();
      try {
        const p = await aliceRepo(f);
        const plugin = f.di.strategies.get('trailing-trade');
        const row = await p.profile.findById();
        if (!plugin || !row) throw new Error('fixture profile or its strategy is missing');
        const fingerprint = configFingerprint(plugin.configSchema.parse(row.config));
        const run = await p.backtestRuns.create({ symbols: ['BTCUSDT'], params: validParams });
        await p.backtestRuns.markRunning(run.id);
        await p.backtestRuns.complete(
          run.id,
          {
            equityCurve: [],
            drawdownSeries: [],
            simulation: {
              strategyName: 'trailing-trade',
              engineRevision: BACKTEST_ENGINE_REVISION,
            },
          },
          fingerprint,
        );
        const matches = async (id: string = run.id): Promise<boolean> => {
          const got = await f.app.request(`${backtestsUrl(f)}/${id}`, {
            headers: { 'x-test-user-id': f.alice.userId },
          });
          return ((await got.json()) as { matchesProfile: boolean }).matchesProfile;
        };
        expect(await matches()).toBe(true);
        // A matching fingerprint is not enough: the engine and strategy that produced the result must also be the current ones.
        const completeWith = async (simulation: Record<string, unknown> | undefined) => {
          const other = await p.backtestRuns.create({ symbols: ['BTCUSDT'], params: validParams });
          await p.backtestRuns.markRunning(other.id);
          await p.backtestRuns.complete(
            other.id,
            { equityCurve: [], drawdownSeries: [], simulation },
            fingerprint,
          );
          return other.id;
        };
        const current = {
          strategyName: 'trailing-trade',
          engineRevision: BACKTEST_ENGINE_REVISION,
        };
        expect(await matches(await completeWith(undefined))).toBe(false);
        expect(
          await matches(
            await completeWith({ ...current, engineRevision: BACKTEST_ENGINE_REVISION - 1 }),
          ),
        ).toBe(false);
        expect(await matches(await completeWith({ ...current, strategyName: 'momentum' }))).toBe(
          false,
        );
        await editTrigger(f, '1.09');
        expect(await matches()).toBe(false);
      } finally {
        await f.cleanup();
      }
    });
  });
});
