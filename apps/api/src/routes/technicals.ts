// GET /profiles/:profileId/technicals/recommendations.
//
// The worker's `technicals-compute` cron writes the latest recommendation per
// (symbol, interval) to the global `technicals:<symbol>:<interval>` Redis
// key. This route reads that key for each of the profile's configured
// symbols and returns a flat list. Symbols whose key is missing or
// unparseable surface as `signal: null` rather than as 5xx — the cron may
// not have caught up yet, and the panel renders "no signal yet" in that
// state.

import {
  asProfileId,
  ErrorEnvelope,
  TechnicalsBundleConfigSchema,
  TechnicalsResponse,
  TechnicalsSignalSchema,
  type TechnicalsBundleConfig,
} from '@app/contracts';
import { GLOBAL_KEYS } from '@app/db';
import { createRoute, z } from '@hono/zod-openapi';
import type { Logger } from 'pino';
import type { DI } from 'di.js';
import { requireUser } from 'middleware/require-user.js';
import { requireOwnedProfile } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

const ProfileIdParam = z.object({ profileId: z.uuid() });

/**
 * Fallback Technicals config when the profile's stored config does not
 * carry a `technicals` block (or fails to parse). Yields the schema defaults
 * `useOnlyWithinMin: 2`, `ifExpires: 'do-not-buy'`, and a single `intervals[0]`
 * watching `1m` with the safe buy-allow set (STRONG_BUY + BUY) and no
 * force-sell triggers — the same fall-through the worker's tick-context
 * uses, so the web pill and the worker gate always agree.
 */
const defaultTechnicalsConfig = (): TechnicalsBundleConfig =>
  TechnicalsBundleConfigSchema.parse({});

/**
 * Per-strategy shape this route depends on for the Technicals block.
 * Strategy-agnostic so a future strategy that does not expose this block
 * still gets the schema defaults, and the route does not need to import a
 * specific plugin's config type. `forceBuyOverride.checkTechnicals` is
 * the TT master switch for the Technicals gate; absent shapes default to
 * `true` (gate active).
 */
const ConfigWithTechnicalsSchema = z
  .object({
    technicals: TechnicalsBundleConfigSchema,
    forceBuyOverride: z.object({ checkTechnicals: z.boolean().default(true) }).optional(),
  })
  .passthrough();

/**
 * Extracts the full Technicals config (freshness gate + configured
 * intervals) from a profile's stored config. Exported so the contract is
 * testable without an HTTP scaffold.
 */
export const resolveTechnicalsConfig = (profileConfig: unknown): TechnicalsBundleConfig => {
  const parsed = ConfigWithTechnicalsSchema.safeParse(profileConfig);
  return parsed.success ? parsed.data.technicals : defaultTechnicalsConfig();
};

// Standalone parse just for the master switch, so we don't fail closed when
// the rest of the config is malformed or missing. The whole-config parser
// `ConfigWithTechnicalsSchema` requires `technicals` to be present (because
// that path also drives `resolveTechnicalsConfig`); the master-switch read
// must succeed for any shape that carries `forceBuyOverride.checkTechnicals`,
// including a config that only sets the override and inherits the rest.
const ForceBuyOverrideShape = z
  .object({ forceBuyOverride: z.object({ checkTechnicals: z.boolean() }).optional() })
  .passthrough();

/**
 * Resolves the Technicals master switch (`forceBuyOverride.checkTechnicals`)
 * from a stored profile config. Default `true` matches both the schema
 * default and the TT strategy's safety stance — an operator who has not
 * explicitly disabled the gate keeps it active.
 */
export const resolveTechnicalsGateActive = (profileConfig: unknown): boolean => {
  const parsed = ForceBuyOverrideShape.safeParse(profileConfig);
  if (!parsed.success) return true;
  return parsed.data.forceBuyOverride?.checkTechnicals ?? true;
};

const route = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/technicals/recommendations',
  tags: ['technicals'],
  request: { params: ProfileIdParam },
  responses: {
    200: {
      description: 'technicals recommendations',
      content: { 'application/json': { schema: TechnicalsResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

/**
 * Reads a single Redis key and validates the JSON against
 * {@link TechnicalsSignalSchema}. Missing-key is the expected pre-cron
 * state and surfaces silently. Malformed JSON or schema mismatch indicate
 * a bug in the writer or contract drift — those still surface as `null`
 * (so the panel renders "no signal yet" instead of an error) but emit a
 * `warn` log so the regression is observable.
 */
const readSignal = async (
  redis: { get: (key: string) => Promise<string | null> },
  logger: Logger,
  symbol: string,
  interval: string,
): Promise<z.infer<typeof TechnicalsSignalSchema> | null> => {
  let raw: string | null;
  try {
    raw = await redis.get(GLOBAL_KEYS.technicals(symbol, interval));
  } catch (err) {
    // A Redis transport hiccup must not poison the whole response — every
    // other symbol's read should still surface. Caller already treats null
    // as "no signal yet" in the UI; the warn log makes the transient
    // visible in observability.
    logger.warn({ symbol, interval, err }, 'technicals cache: redis read failed');
    return null;
  }
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    logger.warn({ symbol, interval, err }, 'technicals cache: malformed JSON');
    return null;
  }
  const parsed = TechnicalsSignalSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn(
      { symbol, interval, issues: parsed.error.issues },
      'technicals cache: schema mismatch',
    );
    return null;
  }
  return parsed.data;
};

/**
 * Router for `GET /profiles/:profileId/technicals/recommendations`. The
 * route is intentionally read-only and side-effect free; the worker owns
 * the Redis cache writes via the `technicals-compute` cron, so the API is
 * purely a fan-out reader for the operator UI.
 */
export const technicalsRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles/*', requireUser());

  app.openapi(route, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { p, profile } = await requireOwnedProfile(c, di, profileId);

    // The worker keys cached signals by `(symbol, interval)`, so the
    // route must read every interval the operator configured. The list
    // order is preserved so the panel renders tabs in the same order
    // the operator entered them.
    const technicals = resolveTechnicalsConfig(profile.config);
    const gateActive = resolveTechnicalsGateActive(profile.config);
    const r = di.redis.raw();
    const symbols = await p.profileSymbols.listForProfile();
    const items = await Promise.all(
      symbols.map(async (s) => ({
        symbol: s.symbol,
        signals: await Promise.all(
          technicals.intervals.map(async (cfg) => ({
            interval: cfg.interval,
            signal: await readSignal(r, di.logger, s.symbol, cfg.interval),
          })),
        ),
      })),
    );
    return c.json({ items, fetchedAt: new Date().toISOString(), technicals, gateActive }, 200);
  });

  return app;
};
