import type { AiProviderConfig } from '@app/contracts';
import { describe, expect, it } from 'vitest';
import { buildImproveConfigManualPrompt, createLlm } from '../src/llm.js';

const anthropicConfig = (over: Partial<AiProviderConfig['anthropic']> = {}): AiProviderConfig => ({
  provider: 'anthropic',
  anthropic: { apiKey: '', oauthToken: '', model: 'claude-sonnet-5', ...over },
  openai: { baseUrl: '', apiKey: '', model: '' },
});

const openaiConfig = (over: Partial<AiProviderConfig['openai']> = {}): AiProviderConfig => ({
  provider: 'openai-compatible',
  anthropic: { apiKey: '', oauthToken: '', model: '' },
  openai: { baseUrl: 'http://host:11434/v1', apiKey: '', model: 'qwen2.5', ...over },
});

describe('createLlm', () => {
  it('reports unavailable and throws when the anthropic provider has no credential', async () => {
    const llm = createLlm(anthropicConfig());
    expect(llm.available).toBe(false);
    await expect(
      llm.improveConfig(
        { strategyName: 's', strategyVersion: '1', configSchema: {}, context: {} },
        'safe',
      ),
    ).rejects.toThrow(/not configured/);
  });

  it('treats a whitespace-only anthropic credential as absent', () => {
    expect(createLlm(anthropicConfig({ apiKey: '  ', oauthToken: '  ' })).available).toBe(false);
  });

  it('reports available with an anthropic API key (no network call at construction)', () => {
    expect(createLlm(anthropicConfig({ apiKey: 'sk-test-key' })).available).toBe(true);
  });

  it('reports available with only an anthropic OAuth token', () => {
    expect(createLlm(anthropicConfig({ oauthToken: 'sk-ant-oat-test' })).available).toBe(true);
  });

  it('reports available for an openai-compatible provider with base URL and model', () => {
    expect(createLlm(openaiConfig()).available).toBe(true);
  });

  it('reports unavailable for an openai-compatible provider missing its model', () => {
    expect(createLlm(openaiConfig({ model: '' })).available).toBe(false);
  });

  it('reports unavailable for an openai-compatible provider missing its base URL', () => {
    expect(createLlm(openaiConfig({ baseUrl: '  ' })).available).toBe(false);
  });
});

describe('buildImproveConfigManualPrompt', () => {
  it('renders the system text, run context, and a JSON-output instruction', () => {
    const prompt = buildImproveConfigManualPrompt(
      {
        strategyName: 'trailing-trade',
        strategyVersion: '1.2.3',
        configSchema: { type: 'object', properties: { candleInterval: { type: 'string' } } },
        context: { metrics: { totalReturnPct: -3.5 } },
      },
      'safe',
    );
    expect(prompt).toContain('Strategy trailing-trade@1.2.3');
    expect(prompt).toContain('candleInterval'); // schema embedded
    expect(prompt).toContain('totalReturnPct'); // run context embedded
    expect(prompt).toContain('Respond with ONLY a JSON object');
    expect(prompt).toContain('"suggestions"'); // the expected output schema
  });

  it('describes and renders TOON 4 nested objects and uniform object arrays consistently', () => {
    const prompt = buildImproveConfigManualPrompt(
      {
        strategyName: 'trailing-trade',
        strategyVersion: '1.2.3',
        configSchema: {},
        context: {
          metrics: { totalReturnPct: -3.5 },
          roundTrips: [
            { symbol: 'BTCUSDT', pnlPct: 1.25 },
            { symbol: 'ETHUSDT', pnlPct: -0.5 },
          ],
        },
      },
      'safe',
    );

    expect(prompt).toContain('nested objects use indentation');
    expect(prompt).toContain('metrics:\n  totalReturnPct: -3.5');
    expect(prompt).toContain('roundTrips[2]{symbol,pnlPct}:\n  BTCUSDT,1.25\n  ETHUSDT,-0.5');
  });
});
