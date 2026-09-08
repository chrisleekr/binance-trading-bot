import {
  ProfileArchiveListResponse,
  TradeArchiveBackfillResponse,
  TradeArchiveDetailResponse,
  UnreconstructableDismissResponse,
  type ArchivePeriod,
  type ArchiveSort,
  type ArchiveSortDir,
  type SymbolSource,
} from '@app/contracts';
import { z } from 'zod';

import { apiDownloadUrl, apiFetch } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

const NoBody = z.unknown();

/** Which reads the server should run for this request. `rollup` answers the by-intent and by-source bands only; the page, the recoverable set and the unreconstructable set come back OMITTED, not empty. */
export type ArchiveView = 'full' | 'rollup';

/**
 * Everything that scopes one archive read: the window, the ordering, the row filters and which reads to run.
 *
 * One object rather than positional arguments, because the caller must put exactly these fields in its query key — a positional list that grew to ten would make "the key covers the request" something a reader has to verify by counting.
 */
export interface ArchiveQueryParams {
  /** Preset window. Ignored for the bounds `from`/`to` supply, but still sent, since the server resolves the window from whichever it was given. */
  readonly period: ArchivePeriod;
  readonly cursor: string | null;
  /** The operator's display zone. The server cuts the day/week/month boundaries in it, so it scopes the response and belongs in the key. */
  readonly tz: string;
  readonly view?: ArchiveView;
  /** Explicit ISO range, overriding `period` on the server when either bound is present. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly sort?: ArchiveSort | undefined;
  readonly dir?: ArchiveSortDir | undefined;
  readonly symbol?: string | undefined;
  readonly exitIntent?: string | undefined;
  readonly source?: SymbolSource | undefined;
}

/** The row filter the ledger has applied, if any. A subset of {@link ArchiveQueryParams} so it spreads straight into a read. */
export type ArchiveFilter = Pick<ArchiveQueryParams, 'symbol' | 'exitIntent' | 'source'>;

/**
 * Paginated profile-level archive reader.
 *
 * `view` belongs in the caller's query key alongside `tz` for the same reason: a rollup response and a full one are different answers to the same URL, and caching one under the other's key would hand a page-rendering surface a response that carries no page.
 *
 * @param profileId - Profile whose archive to read.
 * @param q - The window, ordering and filters; every field of it must appear in the caller's query key.
 * @returns The page, the period rollups, and the window the server actually resolved.
 */
export const fetchProfileArchive = (
  profileId: string,
  q: ArchiveQueryParams,
): Promise<ProfileArchiveListResponse> => {
  return apiFetch(accountPath(`/profiles/${profileId}/trade-archive`), ProfileArchiveListResponse, {
    method: 'GET',
    // Spelled out rather than built by a helper shared with the export below: the query-drift gate reads these keys statically off the literal and checks them against the route's own schema, and a helper hides both call sites from it. The duplication is what makes the check possible.
    query: {
      period: q.period,
      tz: q.tz,
      view: q.view ?? 'full',
      cursor: q.cursor,
      from: q.from,
      to: q.to,
      sort: q.sort,
      dir: q.dir,
      symbol: q.symbol,
      exitIntent: q.exitIntent,
      source: q.source,
    },
  });
};

/**
 * URL of the NDJSON export for one archive selection.
 *
 * A URL the browser navigates to, not a fetch: the response is a streamed attachment, and buffering it through JS to re-offer it as a blob would hold the whole file in memory and lose the server's filename.
 *
 * @param profileId - Profile whose archive to export.
 * @param q - The same window, ordering and filters the screen is showing.
 * @returns A same-origin API path with the selection encoded in its query string.
 */
export const archiveExportUrl = (profileId: string, q: ArchiveQueryParams): string =>
  apiDownloadUrl(accountPath(`/profiles/${profileId}/trade-archive/export`), {
    period: q.period,
    tz: q.tz,
    from: q.from,
    to: q.to,
    sort: q.sort,
    dir: q.dir,
    symbol: q.symbol,
    exitIntent: q.exitIntent,
    source: q.source,
  });

/**
 * The fills behind one archived cycle, fetched when its detail sheet opens.
 *
 * @param profileId - Profile that owns the row.
 * @param archiveId - The row's id.
 * @returns Its order summaries, without the raw exchange payloads the list already omits.
 */
export const fetchArchiveDetail = (
  profileId: string,
  archiveId: string,
): Promise<TradeArchiveDetailResponse> =>
  apiFetch(
    accountPath(`/profiles/${profileId}/trade-archive/${archiveId}`),
    TradeArchiveDetailResponse,
    { method: 'GET' },
  );

/** DELETE wraps the existing per-archive endpoint (returns 204; body unused). */
export const deleteArchiveEntry = (profileId: string, archiveId: string): Promise<unknown> =>
  apiFetch(accountPath(`/profiles/${profileId}/trade-archive/${archiveId}`), NoBody, {
    method: 'DELETE',
  });

/**
 * One-off recovery: reconstruct historic round-trips for a symbol from Binance
 * trade history and insert the missing archive rows. Returns 202; the worker
 * runs the reconstruction. The symbol need not still be subscribed.
 */
export const backfillTradeArchive = (
  profileId: string,
  symbol: string,
): Promise<TradeArchiveBackfillResponse> =>
  apiFetch(
    accountPath(`/profiles/${profileId}/symbols/${symbol}/trade-archive-backfill`),
    TradeArchiveBackfillResponse,
    { method: 'POST', body: {} },
  );

/** Hide (`dismissed: true`) or un-hide a coin from the "no recoverable history" note. */
export const dismissUnreconstructable = (
  profileId: string,
  symbol: string,
  dismissed: boolean,
): Promise<UnreconstructableDismissResponse> =>
  apiFetch(
    accountPath(`/profiles/${profileId}/symbols/${symbol}/unreconstructable-dismiss`),
    UnreconstructableDismissResponse,
    { method: 'POST', body: { dismissed } },
  );
