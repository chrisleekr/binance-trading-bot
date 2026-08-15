import { z } from 'zod';

/**
 * The named conditions a profile can be in — "something is true right now, and
 * has been since a known time".
 *
 * A closed set on purpose. Every entry has a producer that writes it and a
 * reader that ranks it; the charter refuses seams built for hypothetical future
 * adopters, so a new condition arrives with both ends wired, not before.
 *
 * These name the CONDITION, never the specific reason. The reason is the `code`,
 * and per-strategy codes come from each strategy's own reason attribution — a
 * list of them here would make the diagnosis strategy-aware, which is exactly
 * what the plugin contract exists to prevent.
 */
export const CONDITIONS = [
  /** Per (profile, symbol): the strategy declined to open a position this tick. */
  'entry-blocked',
  /** Per (profile, symbol): a HELD position did not exit this tick, and why. */
  'exit-blocked',
  /** Per profile: discovery has not completed a scan recently enough to trust. */
  'discovery-stale',
  /** Per profile: discovery keeps refusing to admit anything on breadth grounds. */
  'discovery-breadth-blocked',
  /** Per profile: the stored config no longer satisfies its own schema. */
  'config-invalid',
  /**
   * Per (profile, symbol): the protective stop the strategy wants cannot be
   * placed, so the position may be sitting with nothing guarding it. Distinct
   * from `exit-blocked`, which says a held position chose not to sell; here the
   * strategy did decide, and the exchange will not take the order.
   */
  'protective-stop-blocked',
] as const;

export type Condition = (typeof CONDITIONS)[number];

export const conditionSchema = z.enum(CONDITIONS);

/**
 * How much a condition matters when several are open at once.
 *
 * `blocking` means the profile cannot trade until it changes. `degraded` means
 * it still can, but on stale or untrustworthy inputs. Nothing here is "error" —
 * a blocked entry is usually the strategy working correctly, and colouring it
 * as a fault trains the operator to ignore it.
 */
export type ConditionSeverity = 'blocking' | 'degraded';

export const CONDITION_SEVERITY: Record<Condition, ConditionSeverity> = {
  'entry-blocked': 'degraded',
  'exit-blocked': 'degraded',
  'discovery-stale': 'degraded',
  'discovery-breadth-blocked': 'degraded',
  'config-invalid': 'blocking',
  // Not `blocking`: the profile keeps trading every other symbol, and only one
  // position is exposed. Ranking it blocking would roll the whole-profile
  // verdict up to "blocked", which claims the bot has stopped when it has not.
  'protective-stop-blocked': 'degraded',
};

/**
 * Uniform `action_logs.ctx` payload for every condition edge, whichever
 * subsystem wrote it. One shape is the point: `ctx->>'source' = 'condition'`
 * yields every state change in the system in one query, instead of a per-feature
 * log grammar that has to be parsed differently for each producer.
 */
export const conditionCtxSchema = z.object({
  source: z.literal('condition'),
  condition: z.string(),
  /** Null marks the edge where the condition resolved. */
  code: z.string().nullable(),
  previousCode: z.string().nullable(),
  /** When the span this edge closes or opens began. */
  sinceMs: z.number(),
  detail: z.unknown().optional(),
});

export type ConditionCtx = z.infer<typeof conditionCtxSchema>;
