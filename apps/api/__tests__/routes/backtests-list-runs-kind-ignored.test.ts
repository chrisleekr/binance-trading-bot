// The runs list ignores `kind` entirely — there is no column, no query key, and no predicate behind it, so the web's "Manual" type filter never narrowed anything. This pins the no-op at the only place it is observable: the RESPONSE. Asserting that the param reaches the server is what let the bug ship in the first place; a request the server discards is indistinguishable from a request it honours until the two bodies are compared.
//
// It is therefore green on arrival, and stays green as the permanent guard: wire any real `kind` predicate and either the filtered body stops matching the unfiltered one or the declared query schema grows the param.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { profileRepo } from '@app/db';

import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const validParams = {
  symbols: ['BTCUSDT'],
  fromMs: 1_000,
  toMs: 2_000,
  strategyInterval: '1h',
  detailInterval: '5m',
  initialQuoteBalance: '1000',
  fees: { makerBps: 10, takerBps: 10 },
  slippageBps: 5,
};

// Drive a run to `done` through the repo; the worker does not run in tests.
const completeRun = async (fx: ApiFixture, result: unknown): Promise<string> => {
  const p = await profileRepo(fx.di.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
  const run = await p.backtestRuns.create({ symbols: ['BTCUSDT'], params: validParams });
  await p.backtestRuns.markRunning(run.id);
  await p.backtestRuns.complete(run.id, result);
  return run.id;
};

describeIfInfra('backtest list: the kind param is not a filter', () => {
  let fx: ApiFixture;
  let url: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    fx = await setupApp();
    url = `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/backtests`;
    headers = { 'x-test-user-id': fx.alice.userId };
    // A mixed page: two finished runs on opposite sides of the outcome filter and one still queued. A predicate that silently matched everything would be invisible against a uniform page.
    await completeRun(fx, { metrics: { totalReturnPct: 5 } });
    await completeRun(fx, { metrics: { totalReturnPct: -3 } });
    await fx.app.request(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(validParams),
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('returns the unfiltered page verbatim for ?kind=manual', async () => {
    const plain = await fx.app.request(url, { headers });
    expect(plain.status).toBe(200);
    const baseline = (await plain.json()) as unknown;

    const filtered = await fx.app.request(`${url}?kind=manual`, { headers });
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toEqual(baseline);
  });

  it('declares no kind parameter on the runs-list operation', async () => {
    // Body equality alone cannot see a `kind` that is wired but happens to match everything on this page. The declared query schema can, and it fails the moment someone half-adds the param — before any predicate exists to narrow anything.
    const doc = (fx.app as unknown as OpenAPIHono).getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'app', version: '1.0.0' },
    }) as unknown as {
      paths?: Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>;
    };
    const op = doc.paths?.['/api/accounts/{accountId}/profiles/{profileId}/backtests']?.['get'];
    expect(op).toBeDefined();
    const names = (op?.parameters ?? [])
      .filter((param) => param.in === 'query')
      .map((param) => param.name);
    // Anchored on a param that IS declared, so a lookup that found the wrong operation cannot pass as an absence.
    expect(names).toContain('filter');
    expect(names).not.toContain('kind');
  });

  it('composes with the outcome filter without changing it', async () => {
    // The two params would share one WHERE clause if `kind` ever became real, so the outcome filter is the surface a bad conjunction shows up on first.
    const plain = await fx.app.request(`${url}?filter=profit`, { headers });
    const baseline = (await plain.json()) as { items: { runId: string }[] };
    expect(baseline.items.length).toBe(1);

    const filtered = await fx.app.request(`${url}?filter=profit&kind=manual`, { headers });
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toEqual(baseline);
  });
});
