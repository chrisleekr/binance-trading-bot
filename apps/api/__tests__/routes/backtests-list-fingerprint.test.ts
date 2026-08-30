// The runs list has to carry each run's config fingerprint, and this is the only place that can prove it: the web's column test feeds itself a stubbed body, so it would render a fingerprint the route never sends. Pinning the field at the client end of the wire and trusting the server end to `tsc` is the shape that let the dead `kind` filter ship — the type checked, the behaviour did not exist.
//
// The fingerprint hashes the effective merged strategy config ONLY, which is what makes it worth surfacing: `backtest_signature` also folds in the market window, so it cannot tell "same window, changed settings" from "same settings, changed window". It is stamped at completion, so a run still in flight has none — and that absence has to reach the client as a present null, not as a missing key, or the table cannot tell "no fingerprint" from "this server does not send fingerprints".

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo } from '@app/db';

import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

// A 16-hex digest, the width `configFingerprint` actually produces. A truncating projection would still satisfy a shorter literal.
const FINGERPRINT = 'ab12cd34ef567890';

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

interface ListItem {
  runId: string;
  status: string;
  configFingerprint?: string | null;
}

describeIfInfra('backtest list: config fingerprint', () => {
  let fx: ApiFixture;
  let url: string;
  let headers: Record<string, string>;
  let doneRunId: string;

  beforeAll(async () => {
    fx = await setupApp();
    url = `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/backtests`;
    headers = { 'x-test-user-id': fx.alice.userId };

    // A finished run whose fingerprint was stamped by `complete`, exactly as the worker stamps it. The worker does not run in tests, so the repo is driven directly.
    const p = await profileRepo(fx.di.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    const done = await p.backtestRuns.create({ symbols: ['BTCUSDT'], params: validParams });
    doneRunId = done.id;
    await p.backtestRuns.markRunning(done.id);
    await p.backtestRuns.complete(done.id, { metrics: { totalReturnPct: 5 } }, FINGERPRINT);

    // A run still queued: the column is null until completion.
    await fx.app.request(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(validParams),
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  const listItems = async (): Promise<ListItem[]> => {
    const res = await fx.app.request(url, { headers });
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: ListItem[] }).items;
  };

  it('returns the stamped fingerprint verbatim on a completed run', async () => {
    const items = await listItems();
    const row = items.find((r) => r.runId === doneRunId);
    // Anchored to the seeded row, so an empty page cannot satisfy this by having nothing to disagree with.
    expect(row).toBeDefined();
    expect(row?.configFingerprint).toBe(FINGERPRINT);
  });

  it('returns a present null on a run still in flight', async () => {
    const items = await listItems();
    const inFlight = items.find((r) => r.status === 'queued');
    expect(inFlight).toBeDefined();
    // `in`, not `=== null`: a projection that omits the key entirely reads as undefined, and `undefined == null` is exactly the confusion that would let a dropped field pass for "this run has no fingerprint".
    expect(Object.hasOwn(inFlight as object, 'configFingerprint')).toBe(true);
    expect(inFlight?.configFingerprint).toBeNull();
  });

  it('carries the key on every row of the page, whatever its status', async () => {
    const items = await listItems();
    expect(items.length).toBeGreaterThanOrEqual(2);
    // One row keeping the field while another silently drops it is how a projection built per-status diverges; the table reads the missing one as unfingerprinted forever.
    expect(items.filter((r) => !Object.hasOwn(r, 'configFingerprint'))).toEqual([]);
  });
});
