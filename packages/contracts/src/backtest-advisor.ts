import { z } from 'zod';
import { ConfigSuggestionSchema, DroppedSuggestionSchema } from './backtest.js';

/**
 * Which advisor variant a persisted result belongs to. The five generation
 * variants (`safe` plus the four EXPLORE lenses) mirror {@link ImproveConfigMode};
 * `manual` is a distinct slot for a result the operator produced by pasting a
 * claude.ai reply back, so a server-generated `safe` row and a manual run coexist
 * on the same run without clobbering each other.
 */
export const AdvisorVariant = z.enum([
  'safe',
  'ride-trend',
  'trade-more',
  'aggressive',
  'defensive',
  'manual',
]);
export type AdvisorVariant = z.infer<typeof AdvisorVariant>;

/**
 * Lifecycle of a persisted advisor result. `running` is a claimed slot with a
 * background job in flight; `done` carries suggestions; `error` records that the
 * generation failed (see `errorReason`). The UI polls a `running` row until it
 * leaves that state.
 */
export const AdvisorStatus = z.enum(['running', 'done', 'error']);
export type AdvisorStatus = z.infer<typeof AdvisorStatus>;

/**
 * Why an advisor generation ended in `error`. `not-configured` means the study
 * worker's selected AI provider had no usable config when the job ran; `failed`
 * is any other generation failure (model error, timeout, all samples rejected).
 * Null on a `running`/`done` row.
 */
export const AdvisorErrorReason = z.enum(['not-configured', 'failed']);
export type AdvisorErrorReason = z.infer<typeof AdvisorErrorReason>;

/**
 * A durable per-(profile, run, variant) advisor result. Survives reload/tab-close
 * so the operator rehydrates saved suggestions without a fresh (re-billed) model
 * call. `suggestions`/`dropped` are the same shapes the improve-config route
 * returns; both are empty until the row reaches `done`. `summary` is null while
 * running and on an errored row.
 */
export const AdvisorResultSchema = z.object({
  id: z.uuid(),
  variant: AdvisorVariant,
  status: AdvisorStatus,
  summary: z.string().nullable(),
  suggestions: z.array(ConfigSuggestionSchema),
  dropped: z.array(DroppedSuggestionSchema),
  errorReason: AdvisorErrorReason.nullable(),
  updatedAt: z.iso.datetime(),
});
export type AdvisorResult = z.infer<typeof AdvisorResultSchema>;

/**
 * All persisted advisor variants for one run, served by the list route the UI
 * rehydrates from. Object-wrapped (not a bare array) so the response can grow a
 * top-level field later without a breaking shape change.
 */
export const AdvisorListResponse = z.object({
  results: z.array(AdvisorResultSchema),
});
export type AdvisorListResponse = z.infer<typeof AdvisorListResponse>;
