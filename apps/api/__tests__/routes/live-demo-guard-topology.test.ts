import { describe, expect, it, vi } from 'vitest';
import type { DI } from '../../src/di.js';
import { authRouter } from '../../src/routes/auth.js';
import { mountApiRouters } from '../../src/routes/mount.js';
import { createApiHono, type ApiHono } from '../../src/types.js';

const demoGuardHandlers = vi.hoisted(() => new WeakSet<object>());

vi.mock('../../src/middleware/require-not-demo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/require-not-demo.js')>();
  return {
    ...actual,
    requireNotDemo: (...args: Parameters<typeof actual.requireNotDemo>) => {
      const handler = actual.requireNotDemo(...args);
      demoGuardHandlers.add(handler);
      return handler;
    },
  };
});

interface MountedRoute {
  readonly method: string;
  readonly path: string;
  readonly handler: unknown;
}

const DEMO_GUARD_CONTRACT = [
  'ALL /api/account/ai-provider',
  'ALL /api/account/ai-provider/test',
  'ALL /api/account/ops-notify',
  'ALL /api/accounts/:accountId/api-key',
  'ALL /api/accounts/:accountId/profiles/:profileId/notify-providers/*',
  'ALL /api/auth/change-password',
  'ALL /api/auth/sign-in/*',
  'ALL /api/auth/sign-out',
  'ALL /api/auth/sign-up/*',
  'ALL /api/backup',
  'ALL /api/backup/config',
  'ALL /api/restore',
  'PATCH /api/retention-config',
  'PATCH /api/accounts/:accountId',
  'DELETE /api/accounts/:accountId',
  'POST /api/accounts',
  'POST /api/accounts/:accountId/profiles/:profileId/backtests/:runId/advisor/:variant',
  'POST /api/accounts/:accountId/profiles/:profileId/backtests/:runId/advisor/manual',
  'POST /api/accounts/:accountId/profiles/:profileId/diagnosis/runs',
  'POST /api/accounts/:accountId/profiles/:profileId/reconcile-fees',
  'POST /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/trade-archive-backfill',
] as const;

const PUBLIC_ROUTES_WITH_SENSITIVE_NAMES = new Set([
  'GET /api/accounts/:accountId/profiles/:profileId/notify-providers',
  'POST /api/auth/sign-up',
]);

// The trading surface — symbol bindings, manual orders, backtests — is deliberately left reachable on a demo box, because a demo runs on testnet and trading is the thing the operator came to see. That decision is real policy, but it made this detector half-blind: none of these paths carries a name the regex below calls sensitive, so every one of them was invisible rather than exempt, and a genuinely dangerous new route in the same area would have been invisible too.
//
// Enumerating them is what turns "invisible" into "exempt". A route added here later is not on this list, so it is flagged; a route removed from the product leaves a stale entry, which the exactness test below rejects.
const INTENTIONALLY_UNGUARDED_TRADING_ROUTES = new Set<string>([
  'DELETE /api/accounts/:accountId/profiles/:profileId/backtests/:runId',
  'DELETE /api/accounts/:accountId/profiles/:profileId/symbols/:symbol',
  'DELETE /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/avg-entry-price',
  'DELETE /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/disable',
  'DELETE /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/override',
  'PATCH /api/accounts/:accountId/profiles/:profileId/symbols/:symbol',
  'POST /api/accounts/:accountId/profiles/:profileId/backtests',
  'POST /api/accounts/:accountId/profiles/:profileId/backtests/:runId/abort',
  'POST /api/accounts/:accountId/profiles/:profileId/backtests/:runId/retry',
  'POST /api/accounts/:accountId/profiles/:profileId/manual-order-all',
  'POST /api/accounts/:accountId/profiles/:profileId/symbols',
  'POST /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/archive-grid-trade',
  'POST /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/cancel-order',
  'POST /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/disable',
  'POST /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/force-eject',
  'POST /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/manual-order',
  'POST /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/pin',
  'POST /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/reset-config',
  'POST /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/reset-grid-trade',
  'POST /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/trigger-buy',
  'POST /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/trigger-sell',
  'POST /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/unpin',
  'POST /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/unreconstructable-dismiss',
  'PUT /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/avg-entry-price',
]);

const mountedApp = (): ApiHono => {
  const app = createApiHono();
  const di = {} as DI;
  app.route('/api/auth', authRouter(di));
  mountApiRouters(app, di);
  return app;
};

const signature = (route: MountedRoute): string => `${route.method} ${route.path}`;
const isDemoGuard = (handler: unknown): boolean =>
  typeof handler === 'function' && demoGuardHandlers.has(handler);

const guardMatches = (guard: MountedRoute, route: MountedRoute): boolean => {
  if (guard.method !== 'ALL' && guard.method !== route.method) return false;
  if (guard.path.endsWith('*')) return route.path.startsWith(guard.path.slice(0, -1));
  return guard.path === route.path;
};

/**
 * Symbol bindings, manual orders and backtests — the paths whose writes move real balance on the account the sandbox is.
 *
 * `ALL` is excluded rather than filtered later: every endpoint on this surface is declared through `openapi()` with a concrete method, so an `ALL` entry here is always a `use()` mount (`requireUser`, a wildcard prefix guard) and never a route a request terminates at.
 */
const isTradingSurface = (route: MountedRoute): boolean =>
  route.method !== 'ALL' &&
  (route.path.includes('/symbols') ||
    route.path.includes('/backtests') ||
    route.path.includes('/manual-order'));

/** Hono records each `use()` middleware as ALL; a later entry carrying the same signature proves this one is middleware rather than the endpoint being checked. */
const isMiddlewareEntry = (routes: readonly MountedRoute[], index: number): boolean => {
  const route = routes[index];
  if (!route || route.method !== 'ALL') return false;
  return routes.slice(index + 1).some((candidate) => signature(candidate) === signature(route));
};

/** The mutating trading endpoints the app really mounts WITHOUT a demo guard — the exact population the exemption list is claiming to describe. A trading route that does carry a guard is not an exemption and must not be listed as one. */
const mountedUnguardedTradingWrites = (routes: readonly MountedRoute[]): string[] => {
  const found = routes
    .filter((route, index) => {
      if (isMiddlewareEntry(routes, index)) return false;
      // A guard registered with a concrete method is itself a route entry sharing the endpoint's signature; counting it would list a guarded route as an exemption.
      if (isDemoGuard(route.handler)) return false;
      if (!isTradingSurface(route) || route.method === 'GET') return false;
      return !routes
        .slice(0, index)
        .some((candidate) => isDemoGuard(candidate.handler) && guardMatches(candidate, route));
    })
    .map(signature);
  return [...new Set(found)].sort();
};

/**
 * Routes that spend the operator's stored AI-provider credential. A model call bills a third party, so unlike every other hazard on a demo box there is no testnet equivalent and no budget to absorb it — the charter's default for a credential-writing route is exposed-unless-guarded, so this fails closed with no exemption list to add to.
 *
 * Non-GET only: the advisor's list and prompt reads are deliberately left open so saved suggestions stay legible in the demo, and neither calls a model.
 */
const spendsAiCredential = (route: MountedRoute): boolean =>
  route.method !== 'GET' &&
  route.path
    .split('/')
    .some((segment) => /^(?:ai[-_]?)?(?:advisor|advice|llm|prompt|completion)s?$/i.test(segment));

const sensitiveRoute = (route: MountedRoute): boolean => {
  if (isDemoGuard(route.handler)) return false;
  if (PUBLIC_ROUTES_WITH_SENSITIVE_NAMES.has(signature(route))) return false;
  // Ahead of the trading clause, which reaches the two advisor POSTs only by accident of their sitting under `/backtests`. The name regex below matches none of `advisor`, `llm` or `prompt`, so an AI route mounted anywhere else would be invisible — the same hole `reconcile-fees` and `diagnosis/runs` each needed their own clause to close.
  if (spendsAiCredential(route)) return true;
  // Checked before the name-based clauses so the exemption is a decision about THIS route rather than a hole the regex happens not to reach. A trading write absent from the list is sensitive.
  if (isTradingSurface(route) && route.method !== 'GET') {
    return !INTENTIONALLY_UNGUARDED_TRADING_ROUTES.has(signature(route));
  }
  const sensitiveName = route.path
    .split('/')
    .some((segment) =>
      /api[-_]?key|authorization[-_]?header|bot[-_]?token|credential|secret|token|password|webhook|sign[-_]?(?:in|out|up)|backup|restore|notifier?|notify|ai[-_]?provider/i.test(
        segment,
      ),
    );
  if (sensitiveName) return true;
  if (route.path === '/api/accounts' && route.method === 'POST') return true;
  if (route.path === '/api/retention-config' && route.method === 'PATCH') return true;
  // No "sensitive" segment name, so it needs its own clause or this backstop cannot see it. It starts a weighted, un-deduped Binance pull from a single button: the hazard is the operator's request budget, not a secret. Its sibling `trade-archive-backfill` needs no clause here — its path carries `/symbols`, so the trading-surface return above reaches it first and, being absent from the exemption set, calls it sensitive.
  if (route.path.endsWith('/reconcile-fees') && route.method === 'POST') return true;
  // Rename and delete of the account the sandbox IS. Not name-sensitive, so without this clause only the hand-written contract above would notice a dropped guard.
  if (
    route.path === '/api/accounts/:accountId' &&
    (route.method === 'PATCH' || route.method === 'DELETE')
  )
    return true;
  return route.path.endsWith('/diagnosis/runs') && route.method === 'POST';
};

const unguardedSensitiveRoutes = (routes: readonly MountedRoute[]): string[] => {
  const unguarded: string[] = [];
  routes.forEach((route, index) => {
    if (isMiddlewareEntry(routes, index)) return;
    if (!sensitiveRoute(route)) return;
    const handlerChain = routes.slice(0, index);
    const guarded = handlerChain.some(
      (candidate) => isDemoGuard(candidate.handler) && guardMatches(candidate, route),
    );
    if (!guarded) unguarded.push(signature(route));
  });
  return [...new Set(unguarded)].sort();
};

describe('mounted live-demo guard topology', () => {
  it('matches the declared requireNotDemo route contract exactly', () => {
    const app = mountedApp();
    const guarded = app.routes
      .filter((route) => isDemoGuard(route.handler))
      .map(signature)
      .sort();

    expect(guarded).toEqual([...DEMO_GUARD_CONTRACT].sort());
  });

  it('independently rejects sensitive routes missing a guard', () => {
    const app = mountedApp();
    expect(unguardedSensitiveRoutes(app.routes)).toEqual([]);

    const synthetic: MountedRoute[] = [
      {
        method: 'ALL',
        path: '/api/account/llm-credentials',
        handler: (): void => undefined,
      },
    ];
    expect(unguardedSensitiveRoutes(synthetic)).toEqual(['ALL /api/account/llm-credentials']);

    expect(
      unguardedSensitiveRoutes([
        { method: 'GET', path: '/api/account/webhook', handler: (): void => undefined },
      ]),
    ).toEqual(['GET /api/account/webhook']);
  });

  it('enumerates the intentionally unguarded trading surface exactly', () => {
    // Exact equality in both directions. A trading write added to the product and not to the list fails the detector test above; one removed from the product leaves a stale entry here, which would quietly re-open the hole for a future route that reused the signature.
    expect(mountedUnguardedTradingWrites(mountedApp().routes)).toEqual(
      [...INTENTIONALLY_UNGUARDED_TRADING_ROUTES].sort(),
    );
  });

  it('flags a NEW unguarded trading route even though the surface is exempt', () => {
    // The half that was vacuous before. `sensitiveRoute`'s name regex and its hand-written backstops match none of symbols / manual-orders / backtests, so this whole area was invisible to the detector rather than deliberately excused — and a route mounted here that genuinely needed a guard would have been invisible with it.
    const synthetic: MountedRoute[] = [
      {
        method: 'POST',
        path: '/api/accounts/:accountId/profiles/:profileId/symbols/:symbol/liquidate-all',
        handler: (): void => undefined,
      },
    ];
    expect(unguardedSensitiveRoutes(synthetic)).toEqual([
      'POST /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/liquidate-all',
    ]);
  });

  it('flags a NEW AI-spend route mounted outside the backtest path', () => {
    // The half the trading clause cannot prove: strip `/backtests` from the path and every existing clause goes blind, yet the hazard — a stranger's click billing the operator's AI provider — is identical.
    expect(
      unguardedSensitiveRoutes([
        {
          method: 'POST',
          path: '/api/accounts/:accountId/profiles/:profileId/ai-advice',
          handler: (): void => undefined,
        },
      ]),
    ).toEqual(['POST /api/accounts/:accountId/profiles/:profileId/ai-advice']);

    // The discriminating half: the advisor READS call no model and are deliberately open, so a clause that flagged them would force a permanent exemption for a route that is correct as it stands.
    expect(
      unguardedSensitiveRoutes([
        {
          method: 'GET',
          path: '/api/accounts/:accountId/profiles/:profileId/backtests/:runId/advisor',
          handler: (): void => undefined,
        },
        {
          method: 'GET',
          path: '/api/accounts/:accountId/profiles/:profileId/backtests/:runId/advisor/manual/prompt',
          handler: (): void => undefined,
        },
      ]),
    ).toEqual([]);
  });

  it('still ignores a trading READ, which moves nothing', () => {
    // The discriminating half: a clause that flagged every trading path would put dozens of harmless list endpoints into the exemption inventory and make it unmaintainable.
    expect(
      unguardedSensitiveRoutes([
        {
          method: 'GET',
          path: '/api/accounts/:accountId/profiles/:profileId/symbols',
          handler: (): void => undefined,
        },
      ]),
    ).toEqual([]);
  });
});
