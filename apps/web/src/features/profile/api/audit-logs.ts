import { AuditLogListResponse } from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/**
 * Page size matches the backend default. The backend is the single source
 * of truth for sane limits; the client just doesn't pass `limit` so a tweak
 * in the API doesn't need a coordinated frontend bump.
 */
export const fetchProfileAuditLogs = (
  profileId: string,
  cursor: string | null,
  events: readonly string[] = [],
): Promise<AuditLogListResponse> => {
  return apiFetch(accountPath(`/profiles/${profileId}/audit-logs`), AuditLogListResponse, {
    method: 'GET',
    // The API reads repeatable `event` parameters, so the shared serializer receives the array rather than a comma-joined value the backend would treat as one unknown event.
    query: { cursor, event: events },
  });
};

/**
 * URL the Export button navigates to. Returning a string (rather than the
 * fetched body) lets the browser handle the streaming download via an
 * `<a href>` click — apiFetch is wrong for binary/large payloads.
 */
export const auditLogsExportUrl = (accountId: string, profileId: string): string =>
  `/api/accounts/${encodeURIComponent(accountId)}/profiles/${encodeURIComponent(profileId)}/audit-logs/export`;
