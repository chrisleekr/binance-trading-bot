// The requireNotDemo() deny-list and onboarding-status demoMode field are both
// driven by the LIVE_DEMO deployment flag.
//
// The guard covers credential, notifier, backup/restore, account-creation, account-rename/delete, retention-change, diagnosis-start, fee-reconciliation, archive-backfill, and backtest-advisor routes. Trading remains interactive on testnet: symbol bindings, manual orders and backtest RUNS are deliberately left reachable, because a demo box trades against testnet and that is what a visitor came to see. The backtest surface is not wholly exempt, though — both advisor POSTs spend the operator's stored AI-provider credential rather than testnet balance, so they are locked. That exemption is enumerated route by route in `live-demo-guard-topology.test.ts`, so it excuses the routes that exist today rather than the whole area — a new unguarded route on the trading surface is still a failure. One assertion samples each locked surface at request level.
//
// The guard reads `di.env.LIVE_DEMO` at request time; the fixture mutates that
// field on the shared di object the routers close over.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { profileRepo } from '@app/db';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const setDemo = (fx: ApiFixture, on: boolean): void => {
  (fx.di.env as unknown as { LIVE_DEMO?: boolean }).LIVE_DEMO = on;
};

describeIfInfra('requireNotDemo deny-list under LIVE_DEMO', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
    setDemo(fx, true);
  });

  afterAll(async () => {
    if (fx) {
      setDemo(fx, false);
      await fx.cleanup();
    }
  });

  const headers = (): Record<string, string> => ({
    'x-test-user-id': fx.alice.userId,
    'content-type': 'application/json',
  });
  const acc = (): string => fx.alice.accountId;
  const prof = (): string => fx.alice.profileId;
  const expect403 = async (path: string, method: string, body?: string): Promise<void> => {
    const res = await fx.app.request(path, {
      method,
      headers: headers(),
      ...(body ? { body } : {}),
    });
    expect(res.status).toBe(403);
  };

  const advisor = (runId: string, suffix: string): string =>
    `/api/accounts/${acc()}/profiles/${prof()}/backtests/${runId}/advisor${suffix}`;

  // A well-shaped paste. `upsertManual` runs unconditionally after the suggestions are partitioned, so a row lands whether the schema accepts the suggestion or drops it — which is what makes an empty `listForRun` below mean the handler never ran, rather than meaning it ran and found nothing worth saving.
  const MANUAL_REPLY = JSON.stringify({
    reply: JSON.stringify({
      summary: 'demo visitor paste',
      suggestions: [
        {
          id: 'valid',
          title: 'Valid',
          rationale: 'r',
          changes: [{ path: 'candleInterval', value: '1h' }],
          expectedEffect: 'e',
          overfitRisk: 'low',
        },
      ],
    }),
  });

  // A FINISHED run on the real strategy's default config. Both advisor POSTs bail out early on a missing run (404) or a result-less one (409), so without this a 403 assertion would go green on a fixture accident rather than on the guard. Each caller takes its own run: a shared one lets a slot claimed by an earlier case make a later `no job enqueued` assertion pass vacuously.
  const completedRunId = async (): Promise<string> => {
    const p = await profileRepo(fx.di.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    const params = {
      symbols: ['BTCUSDT'],
      fromMs: 1_000,
      toMs: 2_000,
      strategyInterval: '1h',
      detailInterval: '5m',
      initialQuoteBalance: '1000',
      fees: { makerBps: 10, takerBps: 10 },
      slippageBps: 5,
      strategyConfigOverride: fx.di.strategies.get('trailing-trade')?.defaultConfig as Record<
        string,
        unknown
      >,
    };
    const run = await p.backtestRuns.create({ symbols: ['BTCUSDT'], params });
    await p.backtestRuns.markRunning(run.id);
    await p.backtestRuns.complete(run.id, {
      params,
      metrics: { totalReturnPct: 1 },
      decisionBreakdown: { metrics: [], logs: [] },
    });
    return run.id;
  };

  const errorCodeOf = async (res: Response): Promise<unknown> =>
    ((await res.json()) as { error?: { code?: unknown } }).error?.code;

  it('api-keys GET /api-key is locked', async () => {
    await expect403(`/api/accounts/${acc()}/api-key`, 'GET');
  });
  it('api-keys PUT /api-key is locked', async () => {
    await expect403(`/api/accounts/${acc()}/api-key`, 'PUT', '{}');
  });
  it('backup GET /backup is locked', async () => {
    await expect403('/api/backup', 'GET');
  });
  it('backup GET /backup/config is locked', async () => {
    await expect403('/api/backup/config', 'GET');
  });
  it('backup PUT /backup/config is locked', async () => {
    await expect403('/api/backup/config', 'PUT', '{}');
  });
  it('backup POST /restore is locked', async () => {
    await expect403('/api/restore', 'POST', '{}');
  });
  it('ai-provider GET /account/ai-provider is locked', async () => {
    await expect403('/api/account/ai-provider', 'GET');
  });
  it('ai-provider POST /account/ai-provider/test is locked', async () => {
    await expect403('/api/account/ai-provider/test', 'POST', '{}');
  });
  it('ops-notify GET /account/ops-notify is locked', async () => {
    await expect403('/api/account/ops-notify', 'GET');
  });
  it('accounts POST /accounts (create) is locked', async () => {
    await expect403('/api/accounts', 'POST', '{}');
  });
  it('retention-config PATCH /retention-config is locked', async () => {
    await expect403('/api/retention-config', 'PATCH', '{"actionLogDays":1}');
  });
  it('auth POST /change-password is locked', async () => {
    await expect403('/api/auth/change-password', 'POST', '{}');
  });
  it('auth POST /sign-out is locked', async () => {
    await expect403('/api/auth/sign-out', 'POST');
  });
  // Better Auth's native endpoint bypasses the onboarding-closed gate.
  it('auth POST /sign-up/email is locked', async () => {
    await expect403('/api/auth/sign-up/email', 'POST', '{}');
  });

  // The provider surface reads and writes secrets and can fire the configured
  // webhook. One 403 assertion samples each operation.
  const np = (): string => `/api/accounts/${acc()}/profiles/${prof()}/notify-providers/webhook`;
  it('notify-provider GET :name is locked', async () => {
    await expect403(np(), 'GET');
  });
  it('notify-provider POST :name (save) is locked', async () => {
    await expect403(np(), 'POST', '{}');
  });
  it('notify-provider PATCH :name/enabled is locked', async () => {
    await expect403(`${np()}/enabled`, 'PATCH', '{}');
  });
  it('notify-provider POST :name/test-fire is locked', async () => {
    await expect403(`${np()}/test-fire`, 'POST', '{}');
  });

  // Starting an investigation is the one write on an otherwise read-only
  // surface, and its live re-probe spends the account's Binance request weight.
  // An anonymous visitor could otherwise burn the operator's budget with a
  // button. Reading a finished report stays open — it carries no credential.
  it('diagnosis POST /profiles/:id/diagnosis/runs is locked', async () => {
    await expect403(`/api/accounts/${acc()}/profiles/${prof()}/diagnosis/runs`, 'POST', '{}');
  });
  // Fee reconciliation is the other unweighted-looking button that is not: it enqueues a Binance `myTrades` pull per click with no jobId dedup, so a demo visitor could hold the operator's request budget down by clicking.
  it('profiles POST /profiles/:id/reconcile-fees is locked', async () => {
    await expect403(`/api/accounts/${acc()}/profiles/${prof()}/reconcile-fees`, 'POST', '{}');
  });
  it('accounts PATCH /accounts/:accountId (rename) is locked', async () => {
    await expect403(`/api/accounts/${acc()}`, 'PATCH', '{"name":"renamed"}');
  });
  it('accounts DELETE /accounts/:accountId is locked', async () => {
    await expect403(`/api/accounts/${acc()}`, 'DELETE');
  });
  // Reachable from History, which is not demo-hidden, and "Recover all" fires one per symbol at once.
  it('archive POST /profiles/:id/symbols/:symbol/trade-archive-backfill is locked', async () => {
    await expect403(
      `/api/accounts/${acc()}/profiles/${prof()}/symbols/BTCUSDT/trade-archive-backfill`,
      'POST',
      '{}',
    );
  });
  // The advisor is the one backtest surface that spends money OUTSIDE Binance: starting a variant enqueues a job that bills the operator's stored AI-provider credential, and a demo box injects the operator identity for every anonymous visitor. Testnet trading stays open; this does not.
  it('advisor POST /backtests/:runId/advisor/:variant is locked and enqueues nothing', async () => {
    const runId = await completedRunId();
    // The handler answers 503 when no study worker has published readiness, which is not 403 either. Arm it, so a passing assertion means the guard refused rather than the worker being absent.
    await fx.di.redis.raw().set('advisor:ready', '1');
    const addSpy = vi.spyOn(fx.di.advisorQueue, 'add').mockResolvedValue({} as never);
    try {
      const res = await fx.app.request(advisor(runId, '/safe'), {
        method: 'POST',
        headers: headers(),
      });
      expect(res.status).toBe(403);
      expect(await errorCodeOf(res)).toBe('FORBIDDEN');
      // Status alone would not catch a guard that refuses AFTER the slot claim + enqueue.
      expect(addSpy).not.toHaveBeenCalled();
      // The slot is claimed BEFORE the enqueue, so an untouched queue alone still allows a `running` row written by a guard that refused too late.
      const p = await profileRepo(
        fx.di.db,
        fx.alice.userId,
        fx.alice.accountId,
        fx.alice.profileId,
      );
      expect(await p.backtestAdvisorResults.listForRun(runId)).toEqual([]);
    } finally {
      addSpy.mockRestore();
    }
  });

  // The manual loop needs no credential, so it costs no third-party bill — but it writes an operator-visible suggestion row from an anonymous paste. The operator chose to disable the advisor whole rather than half of it.
  it('advisor POST /backtests/:runId/advisor/manual is locked and persists nothing', async () => {
    const runId = await completedRunId();
    const res = await fx.app.request(advisor(runId, '/manual'), {
      method: 'POST',
      headers: headers(),
      body: MANUAL_REPLY,
    });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('FORBIDDEN');
    const p = await profileRepo(fx.di.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    expect(await p.backtestAdvisorResults.listForRun(runId)).toEqual([]);
  });

  // Both reads stay open: the list rehydrates already-saved rows and the prompt is text the visitor copies elsewhere. Neither spends a credential, and blocking them would make the demo's advisor tab look broken rather than disabled.
  it('advisor GET /backtests/:runId/advisor stays open', async () => {
    const runId = await completedRunId();
    const res = await fx.app.request(advisor(runId, ''), { headers: headers() });
    expect(res.status).toBe(200);
  });
  it('advisor GET /backtests/:runId/advisor/manual/prompt stays open', async () => {
    const runId = await completedRunId();
    const res = await fx.app.request(advisor(runId, '/manual/prompt'), { headers: headers() });
    expect(res.status).toBe(200);
  });

  it('diagnosis GET /profiles/:id/diagnosis/runs stays open', async () => {
    const res = await fx.app.request(`/api/accounts/${acc()}/profiles/${prof()}/diagnosis/runs`, {
      headers: headers(),
    });
    expect(res.status).toBe(200);
  });

  // The deny-list cases above only prove the guard REFUSES. If `requireNotDemo` ever stopped calling next(), or a method-scoped mount swallowed the openapi handler, the operator's own instance would get a dead button and every assertion above would still pass.
  //
  // The status is pinned to each handler's own success code, NOT asserted as "not 403": a middleware that never calls next() falls through to Hono's 404, which is not 403 either, so the weaker form would have gone green on exactly the regression this test exists to catch.
  it('the method-scoped mounts reach their handlers when LIVE_DEMO is off', async () => {
    setDemo(fx, false);
    try {
      const enqueued = await fx.app.request(
        `/api/accounts/${acc()}/profiles/${prof()}/reconcile-fees`,
        { method: 'POST', headers: headers(), body: '{}' },
      );
      expect(enqueued.status).toBe(202);
      const renamed = await fx.app.request(`/api/accounts/${acc()}`, {
        method: 'PATCH',
        headers: headers(),
        body: '{"name":"still-reachable"}',
      });
      expect(renamed.status).toBe(200);
    } finally {
      setDemo(fx, true);
    }
  });

  // Same pin for the advisor mounts. `advisor/manual` is a STATIC path registered before the `:variant` route, so a guard mounted with a wildcard or in the wrong order would shadow one of them and leave the operator's own box with a dead button. Each is pinned to its own success code, not to `not 403`: a middleware that never calls next() falls through to 404, which would satisfy the weaker form.
  it('both advisor POSTs reach their handlers when LIVE_DEMO is off', async () => {
    setDemo(fx, false);
    await fx.di.redis.raw().set('advisor:ready', '1');
    const addSpy = vi.spyOn(fx.di.advisorQueue, 'add').mockResolvedValue({} as never);
    try {
      const runId = await completedRunId();
      const started = await fx.app.request(advisor(runId, '/safe'), {
        method: 'POST',
        headers: headers(),
      });
      expect(started.status).toBe(202);
      expect(addSpy).toHaveBeenCalledTimes(1);
      const manual = await fx.app.request(advisor(runId, '/manual'), {
        method: 'POST',
        headers: headers(),
        body: MANUAL_REPLY,
      });
      expect(manual.status).toBe(200);
    } finally {
      addSpy.mockRestore();
      setDemo(fx, true);
    }
  });
});

describeIfInfra('onboarding-status reports demoMode from LIVE_DEMO', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });

  afterAll(async () => {
    if (fx) {
      setDemo(fx, false);
      await fx.cleanup();
    }
  });

  const demoModeOf = async (): Promise<unknown> => {
    const res = await fx.app.request('/api/auth/onboarding-status');
    return ((await res.json()) as { demoMode?: unknown }).demoMode;
  };

  it('returns demoMode:false when LIVE_DEMO is off', async () => {
    setDemo(fx, false);
    expect(await demoModeOf()).toBe(false);
  });

  it('returns demoMode:true when LIVE_DEMO is on', async () => {
    setDemo(fx, true);
    expect(await demoModeOf()).toBe(true);
  });
});
