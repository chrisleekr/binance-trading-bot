import {
  ProfileArchiveListResponse,
  TradeArchiveBackfillResponse,
  UnreconstructableDismissResponse,
  type ArchivePeriod,
} from '@app/contracts';
import { z } from 'zod';

import { apiFetch } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

const NoBody = z.unknown();

/** Which reads the server should run for this request. `rollup` answers the by-intent and by-source bands only; the page, the recoverable set and the unreconstructable set come back OMITTED, not empty. */
export type ArchiveView = 'full' | 'rollup';

/**
 * Paginated profile-level archive reader. Period defaults to 'a' (all
 * time) — operator narrows via the dropdown. `tz` is the operator's configured
 * display zone (callers read it from `useTimezone`); the server cuts the
 * day/week/month boundaries in it, so it belongs in the caller's query key.
 *
 * `view` belongs in the caller's query key alongside `tz` for the same reason: a rollup response and a full one are different answers to the same URL, and caching one under the other's key would hand a page-rendering surface a response that carries no page.
 */
export const fetchProfileArchive = (
  profileId: string,
  period: ArchivePeriod,
  cursor: string | null,
  tz: string,
  view: ArchiveView = 'full',
): Promise<ProfileArchiveListResponse> => {
  return apiFetch(accountPath(`/profiles/${profileId}/trade-archive`), ProfileArchiveListResponse, {
    method: 'GET',
    query: {
      period,
      tz,
      view,
      ...(cursor !== null ? { cursor } : {}),
    },
  });
};

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
