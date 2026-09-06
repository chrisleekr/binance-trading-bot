import {
  asProfileId,
  type DecimalString,
  ErrorEnvelope,
  RiskConfigSchema,
  RiskDashboardResponse,
  startOfUtcDayMs,
  type StoredRiskConfig,
  unwrapId,
} from '@app/contracts';
import { Decimal } from '@app/money';
import { type ProfileRepo } from '@app/db';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { activeEntryHalts } from 'lib/entry-halt.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import { requireOwnedProfile } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

const ProfileIdParam = z.object({ profileId: z.uuid() });

/**
 * Risk dashboard payload: the stored risk config (safe defaults + `configInvalid` when a stored value fails validation, mirroring discovery) plus the live circuit-breaker status. `halted` is true while ANY of the three worker-set Redis entry-halt flags is set, and `haltKinds` names those active breakers in `EntryHaltKind` order so every surface listing them agrees on the order; `todayRealizedPnl` is the profile's realised P/L since 00:00 UTC; `limitQuote` is the configured daily loss limit (null when that breaker is off); `resetsAtMs` is when the LAST active halt lifts, because that is when buying actually resumes — the daily flag lifts at the next UTC midnight, each guard at its key's remaining TTL.
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
  const [today, halts] = await Promise.all([
    // Same quote the card renders `limitQuote` in, so the two are comparable.
    p.tradeArchive.sumProfitInRange(
      profile.quoteAsset,
      new Date(startOfUtcDayMs(now)),
      new Date(now),
    ),
    activeEntryHalts(di, p.scope, now),
  ]);
  const limitOff = new Decimal(config.dailyLossLimitQuote || '0').lte(0);
  return {
    config,
    configInvalid,
    quoteAsset: profile.quoteAsset,
    status: {
      halted: halts.length > 0,
      haltKinds: halts.map((h) => h.kind),
      todayRealizedPnl: today.totalProfit as DecimalString,
      limitQuote: limitOff ? null : (config.dailyLossLimitQuote as DecimalString),
      // The LAST halt to lift, not the first: the card answers "when does buying resume", and it resumes only once every active breaker has lifted.
      resetsAtMs: halts.length === 0 ? null : Math.max(...halts.map((h) => h.liftsAtMs)),
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
    // A PATCH has to mean patch. `c.req.valid('json')` hands back the zod-PARSED body, which is the schema's FULL shape: every block the caller omitted arrives filled with its default, and both guard blocks default to OFF. Writing that object whole would let a save of just the daily limit silently disarm the loss-streak and drawdown breakers, so the caller's RAW keys are merged over the stored config instead. Reading the body again is free and safe: Hono caches the text it already read for the validator, so this resolves from `bodyCache` rather than re-consuming the stream. The catch mirrors the validator, which skips a body whose Content-Type is not json and validates `{}` in its place — without it a bodiless PATCH would turn from a no-op into a 500.
    const patch = (await c.req.json().catch(() => ({}))) as Partial<StoredRiskConfig>;
    const { p, profile } = await requireOwnedProfile(c, di, profileId);
    // An unparseable stored config reads as all-defaults here, exactly as the risk card renders it, so a bad stored value can never block the save that would repair it.
    const stored = RiskConfigSchema.safeParse(profile.riskConfig ?? {});
    // The merge is one level deep, and that limit is visible to callers: a top-level key REPLACES its whole block, so `{"drawdown":{"maxDrawdownQuote":"5"}}` resets that block's `lookbackHours` and `pauseHours` to their defaults. Deep-merging instead would make a field impossible to clear by omitting it.
    const merged = RiskConfigSchema.parse({ ...(stored.success ? stored.data : {}), ...patch });
    const updated = await p.profile.setRiskConfig(merged);
    if (!updated) throw new HttpError('NOT_FOUND', 'profile');
    c.set('auditEvent', { event: 'set-risk-config', payload: { profileId } });
    return c.json(await buildRisk(di, p, updated), 200);
  });

  return app;
};
