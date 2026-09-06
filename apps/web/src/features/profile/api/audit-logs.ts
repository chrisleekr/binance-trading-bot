import { AuditLogListResponse } from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/** The largest page the audit-log route will serve. A reader that plots or counts a whole window asks for this rather than the backend's UI-sized default of 25, which is a page size for a scrolling list and a silent truncation for anything else. Pinned here rather than inferred, because the route's cap is what bounds a request, not what a caller may omit. */
export const AUDIT_LOG_MAX_LIMIT = 200;

/**
 * One page of a profile's audit log.
 *
 * `limit` is optional so the paged panel keeps taking the backend's small default; a caller that summarises or plots the whole window passes {@link AUDIT_LOG_MAX_LIMIT} and reads `nextCursor` to learn whether even that was enough. Omitting it is what let a marker layer plot the newest 25 of 60 config changes, bunched at the right-hand end, and report the truncated count as fact.
 *
 * @param profileId - The profile whose log to read.
 * @param cursor - Opaque continuation token from a previous response's `nextCursor`, or null to start at the newest row.
 * @param events - Event-name filter; empty means every event.
 * @param window - Inclusive `createdAt` bounds, so a chart reads only the range it is plotting instead of paging back from now.
 * @param limit - Rows to ask for. Omit for the backend's default page size.
 * @returns The page, newest first, with the token for the next one or null at the end of the log.
 */
export const fetchProfileAuditLogs = (
  profileId: string,
  cursor: string | null,
  events: readonly string[] = [],
  window?: { from?: string; to?: string },
  limit?: number,
): Promise<AuditLogListResponse> => {
  return apiFetch(accountPath(`/profiles/${profileId}/audit-logs`), AuditLogListResponse, {
    method: 'GET',
    // The API reads repeatable `event` parameters, so the shared serializer receives the array rather than a comma-joined value the backend would treat as one unknown event.
    // `window` bounds the read to a plotted range. Without it a chart marking operator actions on an old window has to page backwards from now until it reaches that window, which for a distant one is the whole log.
    query: {
      cursor,
      event: events,
      from: window?.from ?? null,
      to: window?.to ?? null,
      limit: limit ?? null,
    },
  });
};

/**
 * URL the Export button navigates to. Returning a string (rather than the
 * fetched body) lets the browser handle the streaming download via an
 * `<a href>` click — apiFetch is wrong for binary/large payloads.
 */
export const auditLogsExportUrl = (accountId: string, profileId: string): string =>
  `/api/accounts/${encodeURIComponent(accountId)}/profiles/${encodeURIComponent(profileId)}/audit-logs/export`;
