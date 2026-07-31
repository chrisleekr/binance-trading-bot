// Scheduled-backup config queries. The GET returns the stored config plus
// derived status (last run, next due, on-disk dumps); the PUT writes the three
// operator-editable fields back. apiFetch validates the response against the
// shared contract schema, so a drift between API and web fails loudly at the
// boundary rather than rendering wrong status.

import { BackupConfigResponse, type BackupConfigPut } from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';

/** Fetch the current backup config plus derived status for the settings panel. */
export const fetchBackupConfig = (): Promise<BackupConfigResponse> =>
  apiFetch('/backup/config', BackupConfigResponse, { method: 'GET' });

/**
 * Write the operator-edited backup config.
 *
 * The server re-validates the body and returns the same response shape (config
 * plus refreshed status), so the caller repopulates from the response rather
 * than re-fetching. An out-of-range value the client guard missed comes back as
 * a 422 the caller surfaces verbatim.
 */
export const putBackupConfig = (body: BackupConfigPut): Promise<BackupConfigResponse> =>
  apiFetch('/backup/config', BackupConfigResponse, { method: 'PUT', body });
