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
  'POST /api/accounts',
  'POST /api/accounts/:accountId/profiles/:profileId/diagnosis/runs',
] as const;

const PUBLIC_ROUTES_WITH_SENSITIVE_NAMES = new Set([
  'GET /api/accounts/:accountId/profiles/:profileId/notify-providers',
  'POST /api/auth/sign-up',
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

const sensitiveRoute = (route: MountedRoute): boolean => {
  if (isDemoGuard(route.handler)) return false;
  if (PUBLIC_ROUTES_WITH_SENSITIVE_NAMES.has(signature(route))) return false;
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
  return route.path.endsWith('/diagnosis/runs') && route.method === 'POST';
};

const unguardedSensitiveRoutes = (routes: readonly MountedRoute[]): string[] => {
  const unguarded: string[] = [];
  routes.forEach((route, index) => {
    // Hono records each `use()` middleware as ALL. A later route with the same
    // signature proves this entry is middleware, not the endpoint being checked.
    if (
      route.method === 'ALL' &&
      routes.slice(index + 1).some((candidate) => signature(candidate) === signature(route))
    ) {
      return;
    }
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
});
