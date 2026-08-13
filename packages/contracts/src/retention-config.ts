import { z } from 'zod';

/**
 * Bounds the operator can set a log horizon to. The floor of 1 day exists
 * because 0 would mean "delete everything on the next sweep", which no UI
 * affordance should be able to express by accident; the ceiling keeps a
 * fat-fingered entry from turning the hypertable into an unbounded archive.
 */
const RetentionDays = z.number().int().min(1).max(365);

/**
 * Write contract for the retention singleton. Every field is optional: the
 * Settings card saves one section at a time, and arming deep capture must not
 * have to restate the retention numbers it did not touch.
 *
 * `debugCapture` is expressed as a duration rather than an absolute deadline so
 * the server owns the clock — a client with a skewed clock cannot arm a capture
 * that never expires.
 */
export const RetentionConfigPatch = z
  .object({
    actionLogDays: RetentionDays.optional(),
    /**
     * Newest action-log rows kept per profile, enforced by the same nightly
     * sweep as the age horizon. A second, independent bound because the two
     * answer different failures: the horizon caps how far back history reaches,
     * the cap keeps one noisy profile from turning the table into an archive
     * before the horizon comes round. Per profile, so a busy profile cannot
     * evict a quiet one's history.
     */
    actionLogMaxRows: z.number().int().min(1_000).max(10_000_000).optional(),
    auditLogDays: RetentionDays.optional(),
    /**
     * Redis trim length for the raw per-tick trace, applied to each profile's
     * stream separately. Larger reaches further back and survives a longer
     * drainer outage; the memory cost per entry is dominated by the audit
     * payload the strategy emits, so it is strategy-specific rather than a fixed
     * figure.
     */
    auditStreamMaxlen: z.number().int().min(1_000).max(5_000_000).optional(),
    debugCapture: z
      .object({
        profileId: z.uuid(),
        /** Capped at 24h so an armed capture always lapses on its own. */
        minutes: z.number().int().min(1).max(1440),
      })
      .nullable()
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'patch must set at least one field' });
export type RetentionConfigPatch = z.infer<typeof RetentionConfigPatch>;

/** Deep-capture state as the UI renders it. Null when nothing is armed or the window has lapsed. */
export const DebugCaptureStatus = z
  .object({
    profileId: z.uuid(),
    until: z.iso.datetime(),
  })
  .nullable();
export type DebugCaptureStatus = z.infer<typeof DebugCaptureStatus>;

/**
 * Current retention settings. This is the single source of truth for how long
 * logs live — the prune crons read the same row on every run, so what the UI
 * shows here is what will actually be applied on the next sweep.
 */
export const RetentionConfigResponse = z.object({
  actionLogDays: z.number().int(),
  actionLogMaxRows: z.number().int(),
  auditLogDays: z.number().int(),
  auditStreamMaxlen: z.number().int(),
  debugCapture: DebugCaptureStatus,
  updatedAt: z.iso.datetime(),
});
export type RetentionConfigResponse = z.infer<typeof RetentionConfigResponse>;
