import {
  asProfileId,
  type DecimalString,
  ErrorEnvelope,
  nextUtcMidnightMs,
  RiskConfigSchema,
  RiskDashboardResponse,
  startOfUtcDayMs,
  unwrapId,
} from '@app/contracts';
import { Decimal } from '@app/money';
import { type ProfileRepo } from '@app/db';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { isEntryHalted } from 'lib/entry-halt.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import { requireOwnedProfile, scopeOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

const ProfileIdParam = z.object({ profileId: z.uuid() });

/**
 * Risk dashboard payload: the stored risk config (safe defaults + `configInvalid`
 * when a stored value fails validation, mirroring discovery) plus the live
 * circuit-breaker status. `halted` reads the worker's Redis entry-halt flag;
 * `todayRealizedPnl` is the profile's realised P/L since 00:00 UTC; `limitQuote`
 * is the configured loss limit (null when off); `resetsAtMs` is the next UTC
 * midnight when a halt lifts.
 */
const buildRisk = async (
  di: DI,
  p: ProfileRepo,
  profile: { riskConfig?: unknown; quoteAsset: string },
): Promise<RiskDashboardResponse> => {
  const parsed = RiskConfigSchema.safeParse(profile.riskConfig ?? {});
  const configInvalid = !parsed.success;
  let config: RiskDashboardResponse['config'];
  if (parsed.success) {
    config = parsed.data;
  } else {
    di.logger.warn(
      {
        profileId: unwrapId(p.scope.profileId),
        issuePaths: parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
      },
      'stored risk_config failed validation — risk card shows safe defaults until re-saved',
    );
    config = RiskConfigSchema.parse({});
  }
  const now = Date.now();
  const [today, halted] = await Promise.all([
    p.tradeArchive.sumProfitInRange(new Date(startOfUtcDayMs(now)), new Date(now)),
    isEntryHalted(di, p.scope),
  ]);
  const limitOff = new Decimal(config.dailyLossLimitQuote || '0').lte(0);
  return {
    config,
    configInvalid,
    quoteAsset: profile.quoteAsset,
    status: {
      halted,
      todayRealizedPnl: today.totalProfit as DecimalString,
      limitQuote: limitOff ? null : (config.dailyLossLimitQuote as DecimalString),
      resetsAtMs: halted ? nextUtcMidnightMs(now) : null,
    },
  };
};

const getRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/risk',
  tags: ['risk'],
  request: { params: ProfileIdParam },
  responses: {
    200: {
      description: 'risk config + breaker status',
      content: { 'application/json': { schema: RiskDashboardResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/profiles/{profileId}/risk-config',
  tags: ['risk'],
  request: {
    params: ProfileIdParam,
    body: { content: { 'application/json': { schema: RiskConfigSchema } } },
  },
  responses: {
    200: {
      description: 'updated',
      content: { 'application/json': { schema: RiskDashboardResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

export const riskRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles/*/risk', requireUser());
  app.use('/profiles/*/risk-config', requireUser());

  app.openapi(getRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { p, profile } = await requireOwnedProfile(c, di, profileId);
    return c.json(await buildRisk(di, p, profile), 200);
  });

  // Writing the risk config needs no worker resync: the portfolio-risk cron reads
  // the `risk_config` column directly each tick.
  app.openapi(patchRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const body = c.req.valid('json');
    const p = await scopeOf(c, di, profileId);
    const updated = await p.profile.setRiskConfig(body);
    if (!updated) throw new HttpError('NOT_FOUND', 'profile');
    c.set('auditEvent', { event: 'set-risk-config', payload: { profileId } });
    return c.json(await buildRisk(di, p, updated), 200);
  });

  return app;
};
