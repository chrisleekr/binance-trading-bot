// GET /account/health — the always-visible "is my money OK right now" surface.
//
// Account-level (every profile the operator owns), so it reads c.var.userId and
// fans over the user's profiles rather than taking a ProfileScope. For each it
// reads today's realized P/L (UTC trading day, matching the daily-loss breaker),
// the configured loss limit, and the daily-loss halt flag. The money is summed here with
// Decimal (the web has no decimal.js) into a display-ready payload: worker
// liveness, the active halts, today's net realized per (quote, mode), and any
// live profile that has reached the warning band of its loss limit.

import {
  AccountHealthResponse,
  AccountHealthWorker,
  asProfileId,
  type DecimalString,
  ErrorEnvelope,
  RiskConfigSchema,
  startOfUtcDayMs,
} from '@app/contracts';
import { Decimal } from '@app/money';
import { repo } from '@app/db';
import { createRoute } from '@hono/zod-openapi';

import type { DI } from 'di.js';
import { isEntryHalted } from 'lib/entry-halt.js';
import { requireUser } from 'middleware/require-user.js';
import { accountScopeOf, scopeOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

// Bare ioredis key the worker writes its heartbeat under; identical literal to
// the /status route so both read the same bytes.
const WORKER_STATUS_KEY = 'worker:status';

// Warn once today's loss has eaten this fraction of the daily-loss limit. The
// breaker trips at 1.0 (loss <= -limit); this surfaces the approach earlier.
const WARN_FRACTION = 0.8;

const WORKER_DOWN: AccountHealthResponse['worker'] = { status: 'down', sha: null, bootedAt: null };

/**
 * Liveness from the heartbeat: present and well-formed → live, else down. The
 * payload is validated through the contract sub-schema (it requires an ISO
 * `bootedAt`), so a malformed heartbeat degrades to `down` rather than 500ing
 * the whole health surface — the same fail-soft the /status route uses.
 */
const parseWorker = (value: string | null): AccountHealthResponse['worker'] => {
  if (value === null) return WORKER_DOWN;
  try {
    const o = JSON.parse(value) as { sha?: unknown; bootedAt?: unknown };
    const parsed = AccountHealthWorker.safeParse({
      status: 'live',
      sha: o.sha,
      bootedAt: o.bootedAt,
    });
    if (parsed.success) return parsed.data;
  } catch {
    // fall through to down
  }
  return WORKER_DOWN;
};

const route = createRoute({
  method: 'get',
  path: '/account/health',
  tags: ['account'],
  responses: {
    200: {
      description: 'worker liveness, active halts, today-realized, and approaching-limit warnings',
      content: { 'application/json': { schema: AccountHealthResponse } },
    },
    500: { description: 'INTERNAL', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

export const accountHealthRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/account/health', requireUser());

  app.openapi(route, async (c) => {
    const a = await accountScopeOf(c, di);
    const raw = di.redis.raw();
    const now = Date.now();
    const since = new Date(startOfUtcDayMs(now));
    const until = new Date(now);

    const [workerRaw, profiles, storedMode] = await Promise.all([
      raw.get(WORKER_STATUS_KEY),
      a.profiles.listForAccount(),
      repo.accounts.binanceModeById(di.db, a.scope.accountId),
    ]);
    // binance_mode lives on the account now (one environment per account), so
    // every profile under this account shares it. Read it once.
    const binanceMode = storedMode ?? 'test';

    // Resolve each profile's facts in parallel, but fail soft: a profile deleted
    // mid-flight (ProfileNotOwnedError) or a transient db/redis error must not
    // blank the whole bar — the operator would lose the worker-liveness signal
    // too. The failed profile is logged and skipped; the rest still render.
    const settled = await Promise.allSettled(
      profiles.map(async (profile) => {
        const p = await scopeOf(c, di, asProfileId(profile.id));
        const [today, dailyHalted] = await Promise.all([
          p.tradeArchive.sumProfitInRange(since, until),
          isEntryHalted(di, p.scope),
        ]);
        return { profile, realized: today.totalProfit, dailyHalted };
      }),
    );

    const halts: AccountHealthResponse['halts'] = [];
    const approachingLimit: AccountHealthResponse['approachingLimit'] = [];
    // Σ realized per (quoteAsset, mode), keyed `quote|mode`.
    const todayByKey = new Map<string, Decimal>();

    for (const result of settled) {
      if (result.status === 'rejected') {
        // The profile is OMITTED from the response, not reported un-halted: a
        // halt-flag read that failed is not evidence of "no halt". The bar
        // therefore renders as if this profile were not there at all, which is
        // less wrong than a green profile whose breaker may in fact be armed.
        di.logger.warn(
          { err: result.reason instanceof Error ? result.reason.message : String(result.reason) },
          'account-health: skipped a profile that failed to resolve',
        );
        continue;
      }
      const { profile, realized: realizedStr, dailyHalted } = result.value;
      if (dailyHalted)
        halts.push({ profileId: profile.id, name: profile.name, kind: 'daily-loss' });

      const realized = new Decimal(realizedStr || '0');
      const key = `${profile.quoteAsset}|${binanceMode}`;
      todayByKey.set(key, (todayByKey.get(key) ?? new Decimal(0)).plus(realized));

      // A stored risk_config that fails validation reads as "no limit" (the
      // breaker fails open the same way), never a 500.
      const parsedRisk = RiskConfigSchema.safeParse(profile.riskConfig ?? {});
      const limit = new Decimal(
        (parsedRisk.success ? parsedRisk.data.dailyLossLimitQuote : '0') || '0',
      );
      // Live, limit armed, not yet tripped, loss has reached the warn band.
      if (
        binanceMode === 'live' &&
        limit.gt(0) &&
        !dailyHalted &&
        realized.lte(limit.times(-WARN_FRACTION))
      ) {
        approachingLimit.push({
          profileId: profile.id,
          name: profile.name,
          lossQuote: realizedStr as DecimalString,
          limitQuote: limit.toString() as DecimalString,
        });
      }
    }

    const todayRealized = [...todayByKey.entries()].map(([key, sum]) => {
      const [quoteAsset, mode] = key.split('|');
      return {
        quoteAsset: quoteAsset as string,
        binanceMode: mode as 'test' | 'live',
        realizedQuote: sum.toString() as DecimalString,
      };
    });

    const body: AccountHealthResponse = {
      asOf: until.toISOString(),
      worker: parseWorker(workerRaw),
      halts,
      todayRealized,
      approachingLimit,
    };
    return c.json(AccountHealthResponse.parse(body), 200);
  });

  return app;
};
