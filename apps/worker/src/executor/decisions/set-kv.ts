import type { Decision, DecisionResult, ExecutorContext } from '@app/strategy-core';
import { asProfileId, asUserId } from '@app/contracts';
import { resolveBindings, type DecisionDeps } from './_types.js';

/**
 * `set-kv` persists a cross-symbol KV entry into the profile's
 * KV store via the bound persistence. The key is strategy-owned and namespaced;
 * the value is JSON-opaque. No exchange call. A persist failure is non-retryable
 * (a deterministic DB error repeats next tick) and fails loud — never a silent
 * success — but does NOT short-circuit sibling decisions (it is off the order
 * path; `applyAll` only breaks on a failed place-order).
 */
export const setKvHandler = async (
  deps: DecisionDeps,
  ctx: ExecutorContext,
  decision: Extract<Decision, { type: 'set-kv' }>,
): Promise<DecisionResult> => {
  const userId = asUserId(ctx.userId);
  const profileId = asProfileId(ctx.profileId);
  const bindings = await resolveBindings(deps, userId, profileId);
  try {
    await bindings.persistence.setKv(decision.key, decision.value);
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.logger.error({ profileId, kvKey: decision.key, err: reason }, 'set-kv: persist failed');
    return {
      ok: false,
      retryable: false,
      phase: 'pre-call',
      reason: `set-kv "${decision.key}": ${reason}`,
    };
  }
};
