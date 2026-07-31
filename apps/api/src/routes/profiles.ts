import {
  asProfileId,
  type ConfigDiagnostic,
  ConfigLintRequest,
  ConfigLintResponse,
  EnablementPolicy,
  ErrorEnvelope,
  BenchmarkMode,
  ProfileCreate,
  ProfileDeleteDisposition,
  ProfileList,
  ProfilePatch,
  ProfileResponse,
  ProfileNotifyEvents,
  SwitchStrategyRequest,
  unwrapId,
} from '@app/contracts';
import { createReconfigureEnqueue } from '@app/core/queue';
import { GLOBAL_KEYS, projections, repo, schema, type ProfileRepo } from '@app/db';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { assertLiveEnablementAllowed } from 'enablement-gate.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import {
  accountScopeOf,
  requireOwnedProfile,
  DISPOSE_JOB_OPTS,
  RECONCILE_FEES_JOB_OPTS,
} from 'route-helpers.js';
import {
  assertOrderFeasible,
  configUnverified,
  orderFeasibilityDiagnostics,
  toWireDiagnostic,
  withDiagnostics,
} from 'lib/order-feasibility.js';
import type { AnyStrategy } from '@app/strategy-core';
import { createApiHono, type ApiHono } from 'types.js';

const ProfileIdParam = z.object({ profileId: z.uuid() });

// Read-time tolerance for a monitor.mode left behind by an enum-narrowing (the
// removed 'halt'): coerce to the current default so one stale sub-field can't 422
// the whole profile. Surgical on purpose — a coarse EnablementPolicy.catch would
// wipe the operator's tuned gate thresholds. Writes stay strict via ProfilePatch →
// EnablementPolicy, so genuinely bad input is still rejected.
const readEnablementPolicy = (raw: unknown): z.infer<typeof EnablementPolicy> => {
  const obj = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
  const monitor = obj['monitor'];
  if (monitor && typeof monitor === 'object') {
    const mode = (monitor as Record<string, unknown>)['mode'];
    if (mode !== 'off' && mode !== 'warn') {
      obj['monitor'] = { ...(monitor as Record<string, unknown>), mode: 'warn' };
    }
  } else if (monitor !== undefined) {
    // A null or non-object monitor (a legacy/corrupt shape) fails the strict parse
    // because the field's zod default only fills an *absent* key; drop it so the
    // default policy applies rather than 422-ing the whole profile.
    delete obj['monitor'];
  }
  return EnablementPolicy.parse(obj);
};

const toResponse = (
  row: schema.ProfileRow,
  binanceMode: 'test' | 'live',
): z.infer<typeof ProfileResponse> => ({
  id: row.id,
  accountId: row.accountId,
  name: row.name,
  strategyName: row.strategyName,
  strategyVersion: row.strategyVersion,
  config: row.config,
  enabled: row.enabled,
  // Account-level: the API supplies it from the profile's parent account.
  binanceMode,
  quoteAsset: row.quoteAsset,
  benchmarkMode: BenchmarkMode.catch('btc').parse(row.benchmarkMode),
  baselineBacktestRunId: row.baselineBacktestRunId ?? null,
  // null column → the contract defaults; a stored partial fills the rest.
  enablementPolicy: readEnablementPolicy(row.enablementPolicy),
  // null column → every event on; a stored partial fills the rest.
  notifyEvents: ProfileNotifyEvents.parse(row.notifyEvents ?? {}),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

// Cap on how many failed-field messages are folded into the error
// banner; the full list always stays in `details`.
const MAX_CONFIG_ISSUES_SHOWN = 3;

// `buy.gridLevels.2.maxPurchaseAmount` -> `buy.gridLevels[2].maxPurchaseAmount`
// so a numeric path segment reads as an array index, matching the bracket
// style the schema's own superRefine messages already use.
const formatIssuePath = (path: readonly PropertyKey[]): string =>
  path.reduce<string>((acc, seg) => {
    if (typeof seg === 'number') return `${acc}[${seg}]`;
    return acc === '' ? String(seg) : `${acc}.${String(seg)}`;
  }, '') || '(root)';

const validateConfig = (plugin: AnyStrategy, config: unknown): unknown => {
  const parsed = plugin.configSchema.safeParse(config);
  if (!parsed.success) {
    // Surface which field failed in the message itself, not only in
    // `details` — the config form banner renders `message`, so a bare
    // "invalid strategy config" leaves the operator guessing.
    const { issues } = parsed.error;
    const shown = issues
      .slice(0, MAX_CONFIG_ISSUES_SHOWN)
      .map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`);
    const overflow = issues.length - shown.length;
    const detail = shown.join('; ') + (overflow > 0 ? `; …and ${overflow} more` : '');
    throw new HttpError('VALIDATION_FAILED', `invalid strategy config — ${detail}`, issues);
  }
  return parsed.data;
};

const listRoute = createRoute({
  method: 'get',
  path: '/profiles',
  tags: ['profiles'],
  responses: {
    200: { description: 'profiles', content: { 'application/json': { schema: ProfileList } } },
  },
});

const createRouteDef = createRoute({
  method: 'post',
  path: '/profiles',
  tags: ['profiles'],
  request: { body: { content: { 'application/json': { schema: ProfileCreate } } } },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: ProfileResponse } } },
    422: {
      description: 'VALIDATION_FAILED',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}',
  tags: ['profiles'],
  request: { params: ProfileIdParam },
  responses: {
    200: { description: 'profile', content: { 'application/json': { schema: ProfileResponse } } },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/profiles/{profileId}',
  tags: ['profiles'],
  request: {
    params: ProfileIdParam,
    body: { content: { 'application/json': { schema: ProfilePatch } } },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: ProfileResponse } } },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

/**
 * There is no force-delete any more. A profile with live exposure is DISPOSED of,
 * never abandoned: the operator says what happens to the coins and the orders, and
 * a worker job carries it out against Binance (the api has no Binance client, so
 * it cannot cancel anything itself). The route guards and enqueues; the worker
 * deletes the row once the exchange is provably clear.
 */
const deleteRoute = createRoute({
  method: 'delete',
  path: '/profiles/{profileId}',
  tags: ['profiles'],
  request: {
    params: ProfileIdParam,
    query: z.object({
      disposition: ProfileDeleteDisposition.optional(),
      toProfileId: z.uuid().optional(),
    }),
  },
  responses: {
    202: { description: 'disposal accepted' },
    422: {
      description: 'VALIDATION_FAILED — handoff without a valid target',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    409: {
      description: 'CONFLICT — live exposure and no disposition chosen',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

const startRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/start',
  tags: ['profiles'],
  request: { params: ProfileIdParam },
  responses: {
    204: { description: 'started' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const stopRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/stop',
  tags: ['profiles'],
  request: { params: ProfileIdParam },
  responses: {
    204: { description: 'stopped' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const reconcileFeesRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/reconcile-fees',
  tags: ['profiles'],
  request: { params: ProfileIdParam },
  responses: {
    202: { description: 'reconciliation enqueued' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const switchStrategyRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/switch-strategy',
  tags: ['profiles'],
  request: {
    params: ProfileIdParam,
    body: { content: { 'application/json': { schema: SwitchStrategyRequest } } },
  },
  responses: {
    200: {
      description: 'switched (and auto-paused)',
      content: { 'application/json': { schema: ProfileResponse } },
    },
    422: {
      description: 'VALIDATION_FAILED — unknown strategy or invalid config',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const lintConfigRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/lint-config',
  tags: ['profiles'],
  request: {
    params: ProfileIdParam,
    body: { content: { 'application/json': { schema: ConfigLintRequest } } },
  },
  responses: {
    200: {
      description: 'config diagnostics: settings lint plus per-symbol order feasibility',
      content: { 'application/json': { schema: ConfigLintResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

export const profilesRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles', requireUser());
  app.use('/profiles/*', requireUser());

  app.openapi(listRoute, async (c) => {
    const a = await accountScopeOf(c, di);
    const [rows, acct] = await Promise.all([a.profiles.listForAccount(), a.account.get()]);
    const mode = (acct?.binanceMode ?? 'test') as 'test' | 'live';
    return c.json(
      rows.map((r) => toResponse(r, mode)),
      200,
    );
  });

  app.openapi(createRouteDef, async (c) => {
    const a = await accountScopeOf(c, di);
    const body = c.req.valid('json');
    // Create pins an identity: reject an unknown name AND a version the live
    // plugin does not currently ship. A profile must start on the current
    // version; drift is only tolerated later for already-created profiles.
    const plugin = di.strategies.get(body.strategyName);
    if (!plugin || plugin.version !== body.strategyVersion) {
      throw new HttpError('VALIDATION_FAILED', 'unknown strategy', {
        strategyName: body.strategyName,
        strategyVersion: body.strategyVersion,
      });
    }
    const account = await a.account.get();
    if (!account) throw new HttpError('NOT_FOUND', 'account');
    const config = validateConfig(plugin, body.config);
    const state = plugin.initialState(config);
    // binanceMode is not set here — it is the account's environment, inherited.
    const row = await a.profiles.insert({
      name: body.name,
      strategyName: body.strategyName,
      strategyVersion: body.strategyVersion,
      config,
      state,
      enabled: false,
    });
    c.set('auditEvent', { event: 'add-profile', payload: { profileId: row.id } });
    return c.json(toResponse(row, account.binanceMode as 'test' | 'live'), 201);
  });

  app.openapi(getRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { p, profile } = await requireOwnedProfile(c, di, profileId);
    const mode = (await repo.accounts.binanceModeById(di.db, p.scope.accountId)) ?? 'test';
    return c.json(toResponse(profile, mode), 200);
  });

  // Profile-scoped config diagnostics: the strategy's symbol-agnostic settings
  // lint PLUS the per-symbol order-feasibility check, which needs the profile's
  // bound symbols, live prices, and balance. The form re-runs this on edit and
  // disables save on any `block` finding.
  //
  // Neither early return below can size anything, so both say so instead of
  // returning an empty list. This is the operator's remediation surface, and
  // going blank in the exact state that needs explaining is the same silent skip
  // the mutation routes had. The form's own field validation still surfaces the
  // hard schema errors alongside it.
  app.openapi(lintConfigRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { p, profile } = await requireOwnedProfile(c, di, profileId);
    const { config } = c.req.valid('json');
    const resolved = di.strategies.describeForProfile(
      profile.strategyName,
      profile.strategyVersion,
    );
    if (resolved.status === 'unknown') return c.json({ diagnostics: [configUnverified()] }, 200);
    const strategy = resolved.strategy;
    const parsed = strategy.configSchema.safeParse(config);
    if (!parsed.success) return c.json({ diagnostics: [configUnverified()] }, 200);
    const lint = strategy.lintConfig
      ? strategy.lintConfig(parsed.data).map((d) => toWireDiagnostic(d))
      : [];
    const mode = (await repo.accounts.binanceModeById(di.db, p.scope.accountId)) ?? 'test';
    const feasibility = await orderFeasibilityDiagnostics(di, p, strategy, parsed.data, {
      fundFromAccountValue: true,
      mode,
    });
    return c.json({ diagnostics: [...lint, ...feasibility] }, 200);
  });

  app.openapi(patchRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { p, profile: existing } = await requireOwnedProfile(c, di, profileId);
    const { operatorId, accountId } = p.scope;
    // The Binance environment is the account's, fixed; a profile PATCH can never
    // change it. Read it once for the live-enablement / feasibility checks below.
    const mode = (await repo.accounts.binanceModeById(di.db, accountId)) ?? 'test';
    const body = c.req.valid('json');
    const patch: Parameters<ProfileRepo['profile']['update']>[0] = {};
    // Findings from the config feasibility check that the operator can act on
    // but that did not stop the save. Only a `config` edit runs that check, so a
    // patch touching anything else leaves this empty and the field is omitted.
    let saveDiagnostics: ConfigDiagnostic[] = [];
    if (body.name !== undefined) patch.name = body.name;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    // Uppercase so the stored quote matches the symbol suffix discovery and the
    // order/valuation paths compare against (Binance pairs are upper-case).
    if (body.quoteAsset !== undefined) patch.quoteAsset = body.quoteAsset.toUpperCase();
    if (body.benchmarkMode !== undefined) patch.benchmarkMode = body.benchmarkMode;
    if (body.baselineBacktestRunId !== undefined) {
      if (body.baselineBacktestRunId === null) {
        patch.baselineBacktestRunId = null;
      } else {
        // The run must belong to this profile (the scoped getter returns null
        // otherwise) and be finished — pinning a queued/failed run as a baseline
        // would have no metrics to compare against.
        const run = await p.backtestRuns.get(body.baselineBacktestRunId);
        if (!run || run.status !== 'done') {
          throw new HttpError(
            'VALIDATION_FAILED',
            'baseline backtest run not found for this profile or not finished',
          );
        }
        patch.baselineBacktestRunId = body.baselineBacktestRunId;
      }
    }
    if (body.config !== undefined) {
      // Validate against the LIVE plugin's schema. A profile whose strategy
      // has bumped since creation must still accept config edits (issue #407);
      // only a genuinely-unregistered name fails.
      const resolved = di.strategies.describeForProfile(
        existing.strategyName,
        existing.strategyVersion,
      );
      if (resolved.status === 'unknown') {
        throw new HttpError('VALIDATION_FAILED', 'strategy not registered for profile');
      }
      patch.config = validateConfig(resolved.strategy, body.config);
      // Reject a schema-valid config that cannot place a valid order or fund its
      // grid on any bound symbol at current prices + live account value (a 422),
      // so an unfundable config never reaches the worker. Advisory findings come
      // back instead of throwing and ride out on the response.
      saveDiagnostics = await assertOrderFeasible(di, p, resolved.strategy, patch.config, {
        fundFromAccountValue: true,
        mode,
      });
    }
    if (body.enablementPolicy !== undefined) patch.enablementPolicy = body.enablementPolicy;
    // null resets to the contract defaults (every event on); an object replaces
    // the whole map. The worker reads notify_events directly when an event
    // fires, so no resync is needed.
    if (body.notifyEvents !== undefined) patch.notifyEvents = body.notifyEvents;
    // Structural runnability guard. Backtest quality never blocks going live
    // (the live-gate is advisory), but a profile enabling live with an unknown
    // strategy would go dark at tick time, so reject that up front. Fire whenever
    // this PATCH newly enables a profile whose account is live.
    const willBeEnabled = body.enabled ?? existing.enabled;
    const willBeLive = mode === 'live';
    const touchesRisk = body.enabled === true;
    if (willBeEnabled && willBeLive && touchesRisk) {
      assertLiveEnablementAllowed({
        strategies: di.strategies,
        binanceMode: mode,
        enablementPolicy:
          body.enablementPolicy !== undefined ? body.enablementPolicy : existing.enablementPolicy,
        strategyName: existing.strategyName,
        strategyVersion: existing.strategyVersion,
      });
    }
    const updated = await p.profile.update(patch);
    if (!updated) throw new HttpError('NOT_FOUND', 'profile');
    // Config edits drive worker-side caches that ProfileManager only reads at
    // enable-time; without this hand-off the cron keeps computing the old
    // interval set until the worker reboots. The change becomes visible to the
    // cron on its next tick (≤60s). Disabled profiles are skipped: the next
    // start-profile re-reads the DB row and seeds the cache fresh. The
    // reconfigure handler is idempotent.
    if (body.config !== undefined && updated.enabled) {
      await createReconfigureEnqueue(di.queue)({ userId: operatorId, accountId, profileId });
    }
    // A quote-asset change re-points which markets discovery trades. Clear the
    // per-profile discovery refresh gate so the next cron wake (≤60s) re-runs
    // against the new quote instead of waiting up to refreshPeriodMs; discovery's
    // own resync then re-subscribes the changed symbols. Held positions in the
    // old quote are preserved by the reap held-skip, so nothing is force-sold.
    if (
      body.quoteAsset !== undefined &&
      updated.quoteAsset !== existing.quoteAsset &&
      updated.enabled
    ) {
      await di.redis.raw().del(GLOBAL_KEYS.discoveryLastRun(unwrapId(profileId)));
    }
    return c.json(withDiagnostics(toResponse(updated, mode), saveDiagnostics), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { p } = await requireOwnedProfile(c, di, profileId);
    const { operatorId, accountId } = p.scope;
    const { disposition, toProfileId } = c.req.valid('query');

    // A profile with live exposure may not simply vanish: its resting orders would
    // stay on Binance holding the operator's coins with nothing pointing at them.
    // Make the operator choose. A profile with NO exposure needs no choice, and
    // defaults to the (empty) cancel path.
    if (disposition === undefined) {
      const { openOrderCount, openPositionCount } = await projections.countOpenExposure(p.scope);
      if (openOrderCount > 0 || openPositionCount > 0) {
        throw new HttpError(
          'CONFLICT',
          'This profile still holds coins or has live orders on the exchange. Choose what happens to them: cancel its orders on Binance, or hand the position over to another profile.',
          { openOrderCount, openPositionCount },
        );
      }
    }
    if (disposition === 'handoff' && toProfileId === undefined) {
      throw new HttpError(
        'VALIDATION_FAILED',
        'A handoff needs a profile to hand the position to.',
      );
    }
    if (toProfileId !== undefined) {
      // Prove the target is the operator's own and lives on THIS account before the
      // job runs: same account = same Binance key pair and environment, which is
      // what makes moving a position between them meaningful at all.
      if (toProfileId === unwrapId(profileId)) {
        throw new HttpError('VALIDATION_FAILED', 'A profile cannot hand its position to itself.');
      }
      await requireOwnedProfile(c, di, asProfileId(toProfileId));
    }

    // Guard + enqueue only. The api has no Binance client, so the cancels — and
    // therefore the delete that may only follow them — belong to the worker.
    await di.queue.add(
      'dispose-profile',
      {
        userId: operatorId,
        accountId,
        profileId,
        disposition: disposition ?? 'cancel-orders',
        ...(toProfileId !== undefined ? { toProfileId } : {}),
      },
      // Retries with backoff, and no fixed jobId: the worker throws until Binance is
      // provably clear, and a BullMQ job runs ONCE unless `attempts` says otherwise.
      DISPOSE_JOB_OPTS,
    );
    c.set('auditEvent', {
      event: 'delete-profile',
      payload: { profileId, disposition: disposition ?? 'cancel-orders', toProfileId },
    });
    return new Response(null, { status: 202 });
  });

  app.openapi(startRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { p, profile } = await requireOwnedProfile(c, di, profileId);
    const { operatorId, accountId } = p.scope;
    const mode = (await repo.accounts.binanceModeById(di.db, accountId)) ?? 'test';
    assertLiveEnablementAllowed({
      strategies: di.strategies,
      binanceMode: mode,
      enablementPolicy: profile.enablementPolicy,
      strategyName: profile.strategyName,
      strategyVersion: profile.strategyVersion,
    });
    await p.profile.setEnabled(true);
    await di.queue.add(
      'subscribe-profile',
      { userId: operatorId, accountId, profileId },
      { jobId: `subscribe:${profileId}` },
    );
    c.set('auditEvent', { event: 'start-profile', payload: { profileId } });
    return new Response(null, { status: 204 });
  });

  app.openapi(stopRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { p } = await requireOwnedProfile(c, di, profileId);
    const { operatorId, accountId } = p.scope;
    await p.profile.setEnabled(false);
    await di.queue.add(
      'unsubscribe-profile',
      { userId: operatorId, accountId, profileId },
      { jobId: `unsubscribe:${profileId}` },
    );
    c.set('auditEvent', { event: 'stop-profile', payload: { profileId } });
    return new Response(null, { status: 204 });
  });

  app.openapi(reconcileFeesRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { p } = await requireOwnedProfile(c, di, profileId);
    const { operatorId, accountId } = p.scope;
    // Enqueue a worker job: reconciliation needs the profile's Binance client to
    // pull myTrades, which only the worker resolves. RECONCILE_FEES_JOB_OPTS (no
    // fixed jobId, removeOnComplete) keeps it re-runnable — a partial first pass
    // (client briefly unavailable) must be retryable. A fixed jobId on this
    // completed-job-retaining queue would make only the first reconcile per
    // profile ever run.
    await di.queue.add(
      'reconcile-fees',
      { userId: operatorId, accountId, profileId },
      RECONCILE_FEES_JOB_OPTS,
    );
    c.set('auditEvent', { event: 'reconcile-fees', payload: { profileId } });
    return new Response(null, { status: 202 });
  });

  app.openapi(switchStrategyRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { p } = await requireOwnedProfile(c, di, profileId);
    const body = c.req.valid('json');
    // Switch pins a new identity, same as create: reject unknown name AND a
    // version the live plugin does not currently ship.
    const plugin = di.strategies.get(body.strategyName);
    if (!plugin || plugin.version !== body.strategyVersion) {
      throw new HttpError('VALIDATION_FAILED', 'unknown strategy', {
        strategyName: body.strategyName,
        strategyVersion: body.strategyVersion,
      });
    }
    const config = validateConfig(plugin, body.config);
    const state = plugin.initialState(config);
    const updated = await p.profile.switchStrategy({
      strategyName: body.strategyName,
      strategyVersion: body.strategyVersion,
      config,
      state,
    });
    if (!updated) throw new HttpError('NOT_FOUND', 'profile');
    const mode = (await repo.accounts.binanceModeById(di.db, p.scope.accountId)) ?? 'test';
    c.set('auditEvent', {
      event: 'switch-strategy',
      payload: {
        profileId,
        strategyName: body.strategyName,
        strategyVersion: body.strategyVersion,
      },
    });
    return c.json(toResponse(updated, mode), 200);
  });

  return app;
};
