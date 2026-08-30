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
  asDecimalString,
  asProfileId,
  type DecimalString,
  ErrorEnvelope,
  RiskConfigSchema,
  startOfUtcDayMs,
} from '@app/contracts';
import { Decimal } from '@app/money';
import {
  accountRepoFromScope,
  projections,
  repo,
  withAccountTx,
  withStatementTimeout,
} from '@app/db';
import { createRoute } from '@hono/zod-openapi';

import type { DI } from 'di.js';
import { isEntryHalted } from 'lib/entry-halt.js';
import { requireUser } from 'middleware/require-user.js';
import { accountScopeOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

// Bare ioredis key the worker writes its heartbeat under; identical literal to
// the /status route so both read the same bytes.
const WORKER_STATUS_KEY = 'worker:status';

/**
 * Per-statement execution budget for the bar's reads.
 *
 * The reads now share one pooled connection, so a single stalled statement holds that connection for as long as it runs and every other route queues behind it. Five seconds matches the archive page: this bar is on screen continuously and polls, so a read still running after that has already lost its slot.
 */
const HEALTH_READ_BUDGET_MS = 5_000;

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
    // The reads run under a per-statement budget, so a stalled one is answered rather than left holding a pooled connection. Declared because it is a real outcome of this route, not an infrastructure accident the client can ignore.
    503: { description: 'UNAVAILABLE', content: { 'application/json': { schema: ErrorEnvelope } } },
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

    // Redis first: a different pool with a different failure mode, so it costs nothing to read before the transaction and keeps it off the one pooled Postgres connection below.
    const workerRaw = await raw.get(WORKER_STATUS_KEY);
    // One transaction on one pooled connection, reads issued in sequence. The realised totals used to be summed per profile, and node-postgres takes one pooled connection per concurrent query, so the checkout burst grew with the profile count: an operator with a handful of profiles emptied the api's pool of ten on one poll of a bar that polls.
    const { profiles, storedMode, realized } = await withStatementTimeout(
      di.db,
      HEALTH_READ_BUDGET_MS,
      async (tx) => {
        // Rebound to the transaction handle so the reads run on that connection rather than checking out fresh ones. `withAccountTx` swaps only the handle and carries the brand forward, so ownership stays proven exactly once — a spread would carry the same brand while letting `accountId` be rewritten in the same literal.
        const scope = withAccountTx(a.scope, tx);
        const atx = accountRepoFromScope(scope);
        const profiles = await atx.profiles.listForAccount();
        const storedMode = await repo.accounts.binanceModeById(tx, a.scope.accountId);
        // One grouped read for every profile of the account, replacing the per-profile sum.
        const realized = await projections.rollupRealizedByProfileForAccount(scope, since, until);
        return { profiles, storedMode, realized };
      },
    );
    // binance_mode lives on the account now (one environment per account), so
    // every profile under this account shares it. Read it once.
    const binanceMode = storedMode ?? 'test';

    // Fail-soft, but narrower than it used to be, and it is worth being exact about what it still covers. Everything from Postgres is now resolved above in one transaction, so a database fault fails the WHOLE request as a 503 rather than dropping a profile — and there is no per-profile ownership re-check left to raise `ProfileNotOwnedError`. What remains per profile is the halt flag, a Redis existence check on a connection this transaction never touches. `allSettled` is here for that one read: a flag that could not be read is NOT evidence of "no halt", so the profile is logged and omitted from the bar entirely, which is less wrong than rendering it green while its breaker may in fact be armed.
    const settled = await Promise.allSettled(
      profiles.map(async (profile) => {
        const profileId = asProfileId(profile.id);
        const dailyHalted = await isEntryHalted(di, {
          accountId: a.scope.accountId,
          profileId,
        });
        const today = realized.get(profileId);
        // The grouped read left-joins from `profiles` in the same transaction that listed them, so every profile here has a row. One missing means the two reads disagree about the account's membership, and reporting a zero would invent a figure — fail this profile into the skip path instead.
        if (!today) throw new Error('realised rollup omitted a profile of this account');
        return {
          profile,
          realized: today.totalProfit,
          // The quote the sum was actually taken in, echoed from the aggregate rather than re-read off the profile. The rollup below buckets by this key, so deriving it a second time would let the label and the figure drift apart.
          quoteAsset: today.quoteAsset,
          dailyHalted,
        };
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
      const { profile, realized: realizedStr, quoteAsset, dailyHalted } = result.value;
      if (dailyHalted)
        halts.push({ profileId: profile.id, name: profile.name, kind: 'daily-loss' });

      const realized = new Decimal(realizedStr || '0');
      const key = `${quoteAsset}|${binanceMode}`;
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
          limitQuote: asDecimalString(limit),
        });
      }
    }

    const todayRealized = [...todayByKey.entries()].map(([key, sum]) => {
      const [quoteAsset, mode] = key.split('|');
      return {
        quoteAsset: quoteAsset as string,
        binanceMode: mode as 'test' | 'live',
        realizedQuote: asDecimalString(sum),
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
