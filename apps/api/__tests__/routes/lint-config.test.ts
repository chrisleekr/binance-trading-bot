// Lint-config route test. The shared setupApp harness uses an empty strategy
// registry by design, so this builds a minimal app with the REAL registry
// (buildStrategyRegistry) — the route is pure (no DB), so no infra is needed.

import { describe, expect, it } from 'vitest';
import { buildStrategyRegistry } from '@app/strategy-registry';
import { asUserId, type ConfigLintResponse } from '@app/contracts';
import { createApiStrategyRegistry } from '../../src/strategies/registry.js';
import { strategiesRouter } from '../../src/routes/strategies.js';
import { errorHandler } from '../../src/middleware/error.js';
import { createApiHono } from '../../src/types.js';
import type { DI } from '../../src/di.js';

const USER = asUserId('00000000-0000-4000-8000-00000000a001');

// Minimal app: a stub middleware seeds userId (so requireUser passes), then the
// real strategies router mounted with a DI carrying only what the route reads.
const app = (() => {
  const di = { strategies: createApiStrategyRegistry(buildStrategyRegistry()) } as unknown as DI;
  const a = createApiHono();
  a.use('*', async (c, next) => {
    c.set('userId', USER);
    await next();
  });
  a.onError(errorHandler({ error: () => undefined } as never));
  a.route('/api', strategiesRouter(di));
  return a;
})();

const gridConfig = {
  symbol: 'BTCUSDT',
  candleInterval: '1h',
  buy: {
    enabled: true,
    entrySizing: { mode: 'fixed', amount: '15' },
    gridLevels: [
      { triggerPercentage: '1', maxPurchaseAmount: '15' },
      { triggerPercentage: '0.99', maxPurchaseAmount: '15' },
    ],
  },
  sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
};

const lint = (name: string, config: unknown) =>
  app.request(`/api/strategies/${name}/lint-config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config }),
  });

describe('strategies lint-config route', () => {
  it('returns the inert-entry-sizing diagnostic for a grid config', async () => {
    const res = await lint('trailing-trade', gridConfig);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigLintResponse;
    expect(body.diagnostics.map((d) => d.code)).toContain('entry-sizing-ignored-in-grid');
  });

  it('returns no diagnostics for a clean no-grid config', async () => {
    const res = await lint('trailing-trade', {
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '15' } },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ConfigLintResponse).diagnostics).toEqual([]);
  });

  it('returns no diagnostics (not an error) for a schema-invalid draft', async () => {
    const res = await lint('trailing-trade', { not: 'a valid config' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ConfigLintResponse).diagnostics).toEqual([]);
  });

  it('404s for an unknown strategy', async () => {
    const res = await lint('no-such-strategy', gridConfig);
    expect(res.status).toBe(404);
  });
});
