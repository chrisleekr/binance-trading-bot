import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Global singleton holding the AI-assist provider settings. System-wide (one
 * master account), so exactly one row exists; the `id = 1` CHECK plus a default
 * of 1 make a second row impossible.
 *
 * Secrets (`anthropic_*`, `openai_api_key`) are plaintext at rest by design,
 * consistent with `api_keys` / `profile_notifiers.secrets`. The API projection
 * layer strips them before serialization (never sent to the browser).
 */
export const aiProviderConfig = pgTable(
  'ai_provider_config',
  {
    id: integer('id').primaryKey().default(1),
    provider: text('provider').notNull().default('anthropic'),
    anthropicApiKey: text('anthropic_api_key').notNull().default(''),
    anthropicOauthToken: text('anthropic_oauth_token').notNull().default(''),
    anthropicModel: text('anthropic_model').notNull().default('claude-sonnet-5'),
    openaiBaseUrl: text('openai_base_url')
      .notNull()
      .default('http://host.docker.internal:11434/v1'),
    openaiApiKey: text('openai_api_key').notNull().default(''),
    openaiModel: text('openai_model').notNull().default(''),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('ai_provider_config_singleton', sql`${table.id} = 1`),
    check(
      'ai_provider_config_provider',
      sql`${table.provider} in ('anthropic', 'openai-compatible')`,
    ),
  ],
);

export type AiProviderConfigRow = typeof aiProviderConfig.$inferSelect;
