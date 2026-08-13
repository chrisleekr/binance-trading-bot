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
  const query: Record<string, string | readonly string[] | undefined> = {};
  if (cursor !== null) query['cursor'] = cursor;
  // The API uses repeatable `?event=...`. Sending the array directly lets
  // apiFetch's buildUrl emit one parameter per element rather than a CSV
  // string the backend would reject as a single unknown event name.
  if (events.length > 0) query['event'] = events;
  return apiFetch(accountPath(`/profiles/${profileId}/audit-logs`), AuditLogListResponse, {
    method: 'GET',
    ...(Object.keys(query).length > 0 ? { query } : {}),
  });
};

/**
 * URL the Export button navigates to. Returning a string (rather than the
 * fetched body) lets the browser handle the streaming download via an
 * `<a href>` click — apiFetch is wrong for binary/large payloads.
 */
export const auditLogsExportUrl = (accountId: string, profileId: string): string =>
  `/api/accounts/${encodeURIComponent(accountId)}/profiles/${encodeURIComponent(profileId)}/audit-logs/export`;
