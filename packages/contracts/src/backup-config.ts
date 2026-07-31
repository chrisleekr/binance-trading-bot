import { z } from 'zod';

/**
 * Operator-editable scheduled-backup settings. The worker cron reads the stored
 * row; this is the write contract the config route validates a request body
 * against, so out-of-range values are rejected at the edge rather than reaching
 * the cron. `intervalHours` caps at one year (8760h); `retentionCount` at 365
 * kept dumps, both generous ceilings that still bound a fat-fingered entry.
 */
export const BackupConfigPut = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(8760),
  retentionCount: z.number().int().min(1).max(365),
});
export type BackupConfigPut = z.infer<typeof BackupConfigPut>;

/** One on-disk dump file the status panel lists, newest-first. `sizeBytes` is the stat size; `modifiedAt` its mtime. */
export const BackupFileInfo = z.object({
  name: z.string(),
  sizeBytes: z.number(),
  modifiedAt: z.iso.datetime(),
});
export type BackupFileInfo = z.infer<typeof BackupFileInfo>;

/**
 * Backup config plus derived status for the UI. `nextDueAt` is null when
 * disabled or before the first run (the panel shows "pending first backup");
 * otherwise the last run plus the interval. `recentBackups` is the on-disk dump
 * listing, newest-first.
 */
export const BackupConfigResponse = z.object({
  enabled: z.boolean(),
  intervalHours: z.number(),
  retentionCount: z.number(),
  lastBackupAt: z.iso.datetime().nullable(),
  nextDueAt: z.iso.datetime().nullable(),
  recentBackups: z.array(BackupFileInfo),
});
export type BackupConfigResponse = z.infer<typeof BackupConfigResponse>;
