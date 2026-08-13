// Profile log queries: the paged reader, its filter options, the export URL,
// and the raw per-tick trace.
//
// The export deliberately reuses the same filter object as the reader. A
// download that quietly widened or narrowed the filter would be worse than no
// download, because the operator would draw conclusions from a file that does
// not match what they were looking at.

import { ActionLogPageResponse, ActionLogSymbolsResponse, TickTraceResponse } from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';
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

/**
 * Filters as query parameters. Multi-value filters go as one comma-joined
 * value, matching the server's `csv` parser — repeatable params would need a
 * different reader on both ends for no gain.
 */
const filterQuery = (filter: LogFilter): Record<string, string> => {
  const q: Record<string, string> = {};
  if (filter.levels.length > 0) q['levels'] = filter.levels.join(',');
  if (filter.symbols.length > 0) q['symbols'] = filter.symbols.join(',');
  if (filter.source) q['source'] = filter.source;
  if (filter.q) q['q'] = filter.q;
  if (filter.from) q['from'] = filter.from;
  if (filter.to) q['to'] = filter.to;
  return q;
};

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
  const query = filterQuery(filter);
  if (cursor !== null) query['cursor'] = cursor;
  return apiFetch(accountPath(`/profiles/${profileId}/logs`), ActionLogPageResponse, {
    method: 'GET',
    ...(Object.keys(query).length > 0 ? { query } : {}),
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
  const query: Record<string, string> = {};
  if (symbol !== null) query['symbol'] = symbol;
  if (before !== null) query['before'] = before;
  return apiFetch(accountPath(`/profiles/${profileId}/tick-trace`), TickTraceResponse, {
    method: 'GET',
    ...(Object.keys(query).length > 0 ? { query } : {}),
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
): string => {
  const params = new URLSearchParams(filterQuery(filter));
  const qs = params.toString();
  const base = `/api/accounts/${encodeURIComponent(accountId)}/profiles/${encodeURIComponent(profileId)}/logs/export`;
  return qs === '' ? base : `${base}?${qs}`;
};
