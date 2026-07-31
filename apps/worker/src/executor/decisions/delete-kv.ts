import type { Decision, DecisionResult, ExecutorContext } from '@app/strategy-core';
import { asProfileId, asUserId } from '@app/contracts';
import { resolveBindings, type DecisionDeps } from './_types.js';

/**
 * `delete-kv` removes a cross-symbol KV entry (tracker #267) from the profile's
 * KV store. Idempotent — deleting an absent key is a no-op success. A persist
 * failure is non-retryable and fails loud, like {@link setKvHandler}.
 */
export const deleteKvHandler = async (
  deps: DecisionDeps,
  ctx: ExecutorContext,
  decision: Extract<Decision, { type: 'delete-kv' }>,
): Promise<DecisionResult> => {
  const userId = asUserId(ctx.userId);
  const profileId = asProfileId(ctx.profileId);
  const bindings = await resolveBindings(deps, userId, profileId);
  try {
    await bindings.persistence.deleteKv(decision.key);
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.logger.error({ profileId, kvKey: decision.key, err: reason }, 'delete-kv: persist failed');
    return {
      ok: false,
      retryable: false,
      phase: 'pre-call',
      reason: `delete-kv "${decision.key}": ${reason}`,
    };
  }
};
