import { ConfigLintRequest, ConfigLintResponse, ErrorEnvelope, StrategyList } from '@app/contracts';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { toWireDiagnostic } from 'lib/order-feasibility.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import { createApiHono, type ApiHono } from 'types.js';

const listRoute = createRoute({
  method: 'get',
  path: '/strategies',
  tags: ['strategies'],
  responses: {
    200: {
      description: 'available strategies',
      content: { 'application/json': { schema: StrategyList } },
    },
    401: {
      description: 'UNAUTHENTICATED',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

const lintRoute = createRoute({
  method: 'post',
  path: '/strategies/{name}/lint-config',
  tags: ['strategies'],
  request: {
    params: z.object({ name: z.string() }),
    body: { content: { 'application/json': { schema: ConfigLintRequest } } },
  },
  responses: {
    200: {
      description: 'advisory config diagnostics (empty when nothing is inert)',
      content: { 'application/json': { schema: ConfigLintResponse } },
    },
    404: {
      description: 'NOT_FOUND (unknown strategy)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

export const strategiesRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/strategies', requireUser());
  app.use('/strategies/*', requireUser());
  app.openapi(listRoute, (c) => c.json(di.strategies.describeAll(), 200));

  // Strategy-scoped advisory lint: flags silently-inert / conflicting settings the
  // schema can't reject, for a config with no profile context (symbol-agnostic).
  // A schema-invalid config returns no diagnostics (the form's own validation
  // surfaces the hard errors). The profile config panel uses the profile-scoped
  // `POST /profiles/:id/lint-config`, which also runs the per-symbol feasibility
  // check; this route is the profile-independent lint.
  app.openapi(lintRoute, (c) => {
    const { name } = c.req.valid('param');
    const { config } = c.req.valid('json');
    const strategy = di.strategies.get(name);
    if (!strategy) throw new HttpError('NOT_FOUND', 'strategy');
    const parsed = strategy.configSchema.safeParse(config);
    if (!parsed.success || !strategy.lintConfig) return c.json({ diagnostics: [] }, 200);
    const diagnostics = strategy.lintConfig(parsed.data).map((d) => toWireDiagnostic(d));
    return c.json({ diagnostics }, 200);
  });

  return app;
};
