// GET/PATCH/POST /account/ai-provider — system-wide AI-assist provider settings
// (advisor). One master account, so this is a global singleton, not
// profile-scoped. Secrets are never sent to the browser: GET projects them to
// `has*` booleans; PATCH treats a blank/omitted secret as "leave unchanged" so
// the form never has to round-trip a key.

import {
  AiProviderConfigUpdate,
  AiProviderConfigView,
  AiProviderTestResult,
  ErrorEnvelope,
  type AiProviderConfig,
} from '@app/contracts';
import { repo, toAiProviderConfig, type AiProviderConfigRow } from '@app/db';
import { createRoute } from '@hono/zod-openapi';

import type { DI } from 'di.js';
import { requireUser } from 'middleware/require-user.js';
import { requireNotDemo } from 'middleware/require-not-demo.js';
import { createApiHono, type ApiHono } from 'types.js';

const PROBE_TIMEOUT_MS = 8000;

/** Row → wire-safe view: secrets become `has*` booleans, never the raw value. */
const toView = (row: AiProviderConfigRow) => ({
  provider:
    row.provider === 'openai-compatible' ? ('openai-compatible' as const) : ('anthropic' as const),
  anthropic: {
    model: row.anthropicModel,
    hasApiKey: row.anthropicApiKey !== '',
    hasOauthToken: row.anthropicOauthToken !== '',
  },
  openai: {
    baseUrl: row.openaiBaseUrl,
    model: row.openaiModel,
    hasApiKey: row.openaiApiKey !== '',
  },
});

/**
 * Blank/omitted incoming secret means "keep the stored one". By design there is no
 * way to CLEAR a secret through this route (rotate only) — switching provider is the
 * escape hatch; do not "fix" this to clear on blank or it breaks preserve-on-blank.
 */
const keepSecret = (incoming: string | undefined, current: string): string =>
  incoming && incoming.length > 0 ? incoming : current;

/**
 * Lightweight reachability probe of the CURRENTLY STORED config (the operator
 * saves, then tests). Anthropic and OpenAI-compatible both expose an
 * authenticated `GET /models` that validates the credential without spending
 * generation tokens.
 */
async function probeProvider(cfg: AiProviderConfig): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    if (cfg.provider === 'anthropic') {
      const { apiKey, oauthToken } = cfg.anthropic;
      if (!apiKey && !oauthToken) return { ok: false, detail: 'No Anthropic credential set' };
      const res = await fetch('https://api.anthropic.com/v1/models', {
        signal: controller.signal,
        headers: {
          'anthropic-version': '2023-06-01',
          ...(apiKey ? { 'x-api-key': apiKey } : { authorization: `Bearer ${oauthToken}` }),
        },
      });
      return { ok: res.ok, detail: res.ok ? 'Anthropic reachable' : `HTTP ${res.status}` };
    }
    const { baseUrl, apiKey, model } = cfg.openai;
    if (!baseUrl || !model) return { ok: false, detail: 'Base URL and model required' };
    // Trailing slashes come off in a loop rather than via `/\/+$/`: the anchored
    // quantifier backtracks from every start position, so an operator-supplied
    // base URL ending in a long run of slashes costs quadratic time to reject.
    let probeBase = baseUrl;
    while (probeBase.endsWith('/')) probeBase = probeBase.slice(0, -1);
    const res = await fetch(`${probeBase}/models`, {
      signal: controller.signal,
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    });
    return { ok: res.ok, detail: res.ok ? 'Endpoint reachable' : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

const getRoute = createRoute({
  method: 'get',
  path: '/account/ai-provider',
  tags: ['account'],
  responses: {
    200: {
      description: 'AI provider settings (secrets masked)',
      content: { 'application/json': { schema: AiProviderConfigView } },
    },
  },
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/account/ai-provider',
  tags: ['account'],
  request: {
    body: { content: { 'application/json': { schema: AiProviderConfigUpdate } } },
  },
  responses: {
    200: {
      description: 'updated (secrets masked)',
      content: { 'application/json': { schema: AiProviderConfigView } },
    },
    400: { description: 'BAD_REQUEST', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const testRoute = createRoute({
  method: 'post',
  path: '/account/ai-provider/test',
  tags: ['account'],
  responses: {
    200: {
      description: 'reachability probe of the stored provider config',
      content: { 'application/json': { schema: AiProviderTestResult } },
    },
  },
});

export const aiProviderRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/account/ai-provider', requireUser());
  app.use('/account/ai-provider/test', requireUser());
  // Holds the operator's AI provider key — off in demo.
  app.use('/account/ai-provider', requireNotDemo(di));
  app.use('/account/ai-provider/test', requireNotDemo(di));

  app.openapi(getRoute, async (c) => {
    const row = await repo.aiProviderConfig.get(di.db);
    return c.json(toView(row), 200);
  });

  app.openapi(patchRoute, async (c) => {
    const body = c.req.valid('json');
    const cur = await repo.aiProviderConfig.get(di.db);
    const row = await repo.aiProviderConfig.upsert(di.db, {
      provider: body.provider,
      anthropicApiKey: keepSecret(body.anthropic.apiKey, cur.anthropicApiKey),
      anthropicOauthToken: keepSecret(body.anthropic.oauthToken, cur.anthropicOauthToken),
      anthropicModel: body.anthropic.model,
      openaiBaseUrl: body.openai.baseUrl,
      openaiApiKey: keepSecret(body.openai.apiKey, cur.openaiApiKey),
      openaiModel: body.openai.model,
    });
    // Audit the selection, never the secrets.
    c.set('auditEvent', { event: 'set-ai-provider', payload: { provider: body.provider } });
    return c.json(toView(row), 200);
  });

  app.openapi(testRoute, async (c) => {
    const cfg = toAiProviderConfig(await repo.aiProviderConfig.get(di.db));
    return c.json(await probeProvider(cfg), 200);
  });

  return app;
};
