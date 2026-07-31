import type { AiProviderConfig } from '@app/contracts';
import type { AiProviderConfigRow } from './schema/ai-provider-config.js';

/**
 * Map the stored singleton row to the resolved {@link AiProviderConfig} the llm
 * factory consumes. Pure; lives outside `repo/` so it is not subject to the
 * ProfileScope-first AST check (it takes a row, not a `Database`/`ProfileScope`).
 * The DB CHECK constraint guarantees `provider` is one of the two literals; the
 * ternary narrows `text` to the union.
 */
export const toAiProviderConfig = (row: AiProviderConfigRow): AiProviderConfig => ({
  provider: row.provider === 'openai-compatible' ? 'openai-compatible' : 'anthropic',
  anthropic: {
    apiKey: row.anthropicApiKey,
    oauthToken: row.anthropicOauthToken,
    model: row.anthropicModel,
  },
  openai: {
    baseUrl: row.openaiBaseUrl,
    apiKey: row.openaiApiKey,
    model: row.openaiModel,
  },
});
