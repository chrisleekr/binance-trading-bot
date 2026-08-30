// Profile log queries: the paged reader, its filter options, the export URL,
// and the raw per-tick trace.
//
// The export deliberately reuses the same filter object as the reader. A
// download that quietly widened or narrowed the filter would be worse than no
// download, because the operator would draw conclusions from a file that does
// not match what they were looking at.

import { ActionLogPageResponse, ActionLogSymbolsResponse, TickTraceResponse } from '@app/contracts';

import { apiDownloadUrl, apiFetch, encodePathSegment } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/** Operator-chosen narrowing, shared by the reader and the export. */
export interface LogFilter {
  readonly levels: readonly string[];
  readonly symbols: readonly string[];
  readonly source?: string;
  readonly q?: string;
  readonly from?: string;
  readonly to?: string;
}

export const emptyLogFilter: LogFilter = { levels: [], symbols: [] };

export const profileLogsQueryKey = (
  profileId: string,
  filter: LogFilter,
  cursor: string | null,
): readonly unknown[] => ['profile-logs', profileId, filter, cursor];

export const fetchProfileLogs = (
  profileId: string,
  filter: LogFilter,
  cursor: string | null,
): Promise<ActionLogPageResponse> => {
  return apiFetch(accountPath(`/profiles/${profileId}/logs`), ActionLogPageResponse, {
    method: 'GET',
    // Multi-value log filters remain comma-joined because the API parses one CSV value for each key.
    query: {
      levels: filter.levels.length > 0 ? filter.levels.join(',') : undefined,
      symbols: filter.symbols.length > 0 ? filter.symbols.join(',') : undefined,
      source: filter.source,
      q: filter.q,
      from: filter.from,
      to: filter.to,
      cursor,
    },
  });
};

export const fetchProfileLogSymbols = (profileId: string): Promise<ActionLogSymbolsResponse> =>
  apiFetch(accountPath(`/profiles/${profileId}/logs/symbols`), ActionLogSymbolsResponse, {
    method: 'GET',
  });

/**
 * One window of raw trace entries, newest-first. `before` is a stream id from a
 * previous window's `oldestStreamId`; the server makes the bound exclusive, so
 * walking back cannot repeat the entry it resumed from.
 */
export const fetchTickTrace = (
  profileId: string,
  symbol: string | null,
  before: string | null = null,
): Promise<TickTraceResponse> => {
  return apiFetch(accountPath(`/profiles/${profileId}/tick-trace`), TickTraceResponse, {
    method: 'GET',
    query: { symbol, before },
  });
};

/**
 * URL the Export button navigates to. A plain string, not a fetch: the browser
 * streams the download through an `<a href>` click, and apiFetch would buffer
 * the whole file in memory first — the exact failure this export was built to
 * avoid.
 */
export const profileLogsExportUrl = (
  accountId: string,
  profileId: string,
  filter: LogFilter,
): string =>
  apiDownloadUrl(
    `/accounts/${encodePathSegment(accountId)}/profiles/${encodePathSegment(profileId)}/logs/export`,
    {
      levels: filter.levels.length > 0 ? filter.levels.join(',') : undefined,
      symbols: filter.symbols.length > 0 ? filter.symbols.join(',') : undefined,
      source: filter.source,
      q: filter.q,
      from: filter.from,
      to: filter.to,
    },
  );
