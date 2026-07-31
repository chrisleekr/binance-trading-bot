import { eq, sql } from 'drizzle-orm';
import { aiProviderConfig, type AiProviderConfigRow } from '../schema/ai-provider-config.js';
import type { Database } from './_db.js';

// Global singleton: AI-assist provider settings are system-wide, not
// account-scoped, so these are db-first with no userId / ProfileScope. The
// migration seeds the single `id = 1` row, so reads always find it.

const SINGLETON_ID = 1;

/** Resolved provider values the route commits after applying blank-preserves-secret. */
export interface AiProviderConfigUpsert {
  provider: string;
  anthropicApiKey: string;
  anthropicOauthToken: string;
  anthropicModel: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
}

export async function get(db: Database): Promise<AiProviderConfigRow> {
  const rows = await db
    .select()
    .from(aiProviderConfig)
    .where(eq(aiProviderConfig.id, SINGLETON_ID))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error('ai-provider-config.get: singleton row missing (migration not applied?)');
  }
  return row;
}

export async function upsert(
  db: Database,
  input: AiProviderConfigUpsert,
): Promise<AiProviderConfigRow> {
  const [row] = await db
    .update(aiProviderConfig)
    .set({ ...input, updatedAt: sql`now()` })
    .where(eq(aiProviderConfig.id, SINGLETON_ID))
    .returning();
  if (!row) {
    throw new Error('ai-provider-config.upsert: singleton row missing (migration not applied?)');
  }
  return row;
}
