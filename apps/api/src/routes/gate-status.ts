// Live-gate status for a profile. Read-only ADVISORY view behind the gate-status
// card: it re-runs the SAME evaluation the API admission gate uses (shared
// `evaluateBacktestGate`) against the profile's current config and reports whether
// the config is still proven by a recent passing backtest. This is surface-only —
// the bot never pauses buys for a failing gate; it just flags the problem here.

import {
  asProfileId,
  DEFAULT_ENABLEMENT_POLICY,
  describeGateOutcome,
  EnablementPolicy,
  ErrorEnvelope,
  evaluateBacktestGate,
  GateStatusResponse,
  RECENT_DONE_SCAN,
  toGateCandidates,
  type GateOutcome,
} from '@app/contracts';
import { repo, type ProfileRepo } from '@app/db';
import { configFingerprint } from '@app/strategy-core';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { requireUser } from 'middleware/require-user.js';
import { requireOwnedProfile } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

const ProfileIdParam = z.object({ profileId: z.uuid() });

const buildGateStatus = async (
  di: DI,
  p: ProfileRepo,
  profile: {
    binanceMode: string;
    strategyName: string;
    strategyVersion: string;
    config: unknown;
    enablementPolicy: unknown;
  },
): Promise<GateStatusResponse> => {
  const parsedPolicy = EnablementPolicy.safeParse(profile.enablementPolicy ?? {});
  const policy = parsedPolicy.success ? parsedPolicy.data : DEFAULT_ENABLEMENT_POLICY;

  if (profile.binanceMode !== 'live') {
    return {
      applicability: 'not-live',
      ok: true,
      failure: null,
      detail: 'The gate guards live capital only; this profile runs on testnet.',
    };
  }
  if (!policy.enabled) {
    return {
      applicability: 'gate-off',
      ok: true,
      failure: null,
      detail: 'The live gate is turned off for this profile.',
    };
  }

  const resolved = di.strategies.describeForProfile(profile.strategyName, profile.strategyVersion);
  if (resolved.status === 'unknown') {
    return {
      applicability: 'gated',
      ok: false,
      failure: 'no-matching-backtest',
      detail: 'The strategy is not registered, so no backtest can prove this config.',
    };
  }

  let outcome: GateOutcome;
  try {
    const fingerprint = configFingerprint(resolved.strategy.configSchema.parse(profile.config));
    const recent = await p.backtestRuns.recentDone(RECENT_DONE_SCAN);
    outcome = evaluateBacktestGate({
      policy,
      currentFingerprint: fingerprint,
      candidates: toGateCandidates(recent),
      nowMs: Date.now(),
    });
  } catch {
    return {
      applicability: 'gated',
      ok: false,
      failure: 'no-matching-backtest',
      detail: 'The current config could not be evaluated against a backtest.',
    };
  }

  return {
    applicability: 'gated',
    ok: outcome.ok,
    failure: outcome.ok ? null : outcome.failure,
    detail: describeGateOutcome(outcome),
  };
};

const getRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/gate-status',
  tags: ['profiles'],
  request: { params: ProfileIdParam },
  responses: {
    200: {
      description: 'live-gate status',
      content: { 'application/json': { schema: GateStatusResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

export const gateStatusRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles/*/gate-status', requireUser());
  app.openapi(getRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { p, profile } = await requireOwnedProfile(c, di, profileId);
    const mode = (await repo.accounts.binanceModeById(di.db, p.scope.accountId)) ?? 'test';
    return c.json(await buildGateStatus(di, p, { ...profile, binanceMode: mode }), 200);
  });
  return app;
};
