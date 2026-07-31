import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * Integration coverage for the ai-provider router: a fresh account reads the
 * seeded defaults with secrets masked, a PATCH persists provider + model +
 * secret (a later GET reflects it via `has*` booleans), a blank secret on a
 * subsequent PATCH preserves the stored one, the probe answers, and reads
 * require a session.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const headers = (userId: string): Record<string, string> => ({
  'x-test-user-id': userId,
  'content-type': 'application/json',
});

interface View {
  provider: string;
  anthropic: { model: string; hasApiKey: boolean; hasOauthToken: boolean };
  openai: { baseUrl: string; model: string; hasApiKey: boolean };
}

const patchBody = (over: Partial<{ apiKey: string; anthropicModel: string }> = {}) => ({
  provider: 'anthropic',
  anthropic: {
    model: over.anthropicModel ?? 'claude-sonnet-5',
    ...(over.apiKey !== undefined ? { apiKey: over.apiKey } : {}),
  },
  openai: { baseUrl: 'http://host.docker.internal:11434/v1', model: 'qwen2.5' },
});

describeIfInfra('ai-provider router', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('GET returns seeded defaults with secrets masked', async () => {
    const res = await fx.app.request('/api/account/ai-provider', {
      headers: headers(fx.alice.userId),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as View;
    expect(body.provider).toBe('anthropic');
    expect(body.anthropic.model).toBe('claude-sonnet-5');
    expect(body.anthropic.hasApiKey).toBe(false);
    expect(body.openai.baseUrl).toContain('11434');
    // Never leaks a raw secret field.
    expect(JSON.stringify(body)).not.toContain('apiKey');
  });

  it('PATCH persists provider/model/secret and GET reflects it via has* booleans', async () => {
    const patch = await fx.app.request('/api/account/ai-provider', {
      method: 'PATCH',
      headers: headers(fx.alice.userId),
      body: JSON.stringify(
        patchBody({ apiKey: 'sk-ant-secret', anthropicModel: 'claude-opus-4-8' }),
      ),
    });
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as View;
    expect(body.anthropic.model).toBe('claude-opus-4-8');
    expect(body.anthropic.hasApiKey).toBe(true);
    expect(body.openai.model).toBe('qwen2.5');

    const after = (await (
      await fx.app.request('/api/account/ai-provider', { headers: headers(fx.alice.userId) })
    ).json()) as View;
    expect(after.anthropic.hasApiKey).toBe(true);
    expect(after.anthropic.model).toBe('claude-opus-4-8');
  });

  it('PATCH with a blank secret preserves the stored key', async () => {
    // No apiKey field → keep the previously stored 'sk-ant-secret'.
    const patch = await fx.app.request('/api/account/ai-provider', {
      method: 'PATCH',
      headers: headers(fx.alice.userId),
      body: JSON.stringify(patchBody({ anthropicModel: 'claude-sonnet-5' })),
    });
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as View;
    expect(body.anthropic.hasApiKey).toBe(true); // preserved, not cleared
    expect(body.anthropic.model).toBe('claude-sonnet-5');
  });

  it('POST /test answers with a boolean ok for an unreachable endpoint', async () => {
    // Point at a refused local port so the probe fails fast and offline.
    await fx.app.request('/api/account/ai-provider', {
      method: 'PATCH',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({
        provider: 'openai-compatible',
        anthropic: { model: 'claude-sonnet-5' },
        openai: { baseUrl: 'http://127.0.0.1:9/v1', model: 'm' },
      }),
    });
    const res = await fx.app.request('/api/account/ai-provider/test', {
      method: 'POST',
      headers: headers(fx.alice.userId),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; detail: string };
    expect(body.ok).toBe(false);
    expect(typeof body.detail).toBe('string');
  });

  it('POST /test short-circuits offline when the openai model is missing', async () => {
    await fx.app.request('/api/account/ai-provider', {
      method: 'PATCH',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({
        provider: 'openai-compatible',
        anthropic: { model: 'claude-sonnet-5' },
        openai: { baseUrl: 'http://host.docker.internal:11434/v1', model: '' },
      }),
    });
    const res = await fx.app.request('/api/account/ai-provider/test', {
      method: 'POST',
      headers: headers(fx.alice.userId),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; detail: string };
    expect(body.ok).toBe(false);
    expect(body.detail).toMatch(/base url and model required/i);
  });

  it('GET requires a session', async () => {
    const res = await fx.app.request('/api/account/ai-provider');
    expect(res.status).toBe(401);
  });
});
