import {
  AdvisorListResponse,
  AdvisorResultSchema,
  BacktestCreatedSchema,
  BacktestListResponse,
  BacktestRunDetailSchema,
  CandleList,
  ImproveConfigPromptResponseSchema,
  type AdvisorListResponse as AdvisorListResponseType,
  type AdvisorResult,
  type BacktestCreated,
  type BacktestInterval,
  type BacktestListResponse as BacktestListResponseType,
  type BacktestParams,
  type BacktestRunDetail,
  type ImproveConfigPromptResponse,
  type ImproveConfigMode,
} from '@app/contracts';
import { z } from 'zod';

import { apiFetch, encodePathSegment } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/**
 * Launch a backtest for the profile; returns the run id to poll. With
 * `opts.force` the API bypasses its identical-config dedup and always creates a
 * fresh run (`deduped:false`) — the "run fresh anyway" path off the dedup dialog.
 * `force` is a query param, kept out of {@link BacktestParams} so it can never
 * perturb the run signature the dedup keys on.
 */
export const createBacktest = (
  profileId: string,
  body: BacktestParams,
  opts: { force?: boolean } = {},
): Promise<BacktestCreated> =>
  apiFetch(
    accountPath(`/profiles/${encodePathSegment(profileId)}/backtests`),
    BacktestCreatedSchema,
    {
      method: 'POST',
      body,
      query: { force: opts.force ? true : undefined },
    },
  );

/** Status + embedded result (once done) for one run. */
export const fetchBacktestRun = (profileId: string, runId: string): Promise<BacktestRunDetail> =>
  apiFetch(
    accountPath(`/profiles/${encodePathSegment(profileId)}/backtests/${encodePathSegment(runId)}`),
    BacktestRunDetailSchema,
    { method: 'GET' },
  );

/** Abort a queued/running run; returns the run's post-abort detail (cancelled). */
export const abortBacktest = (profileId: string, runId: string): Promise<BacktestRunDetail> =>
  apiFetch(
    accountPath(
      `/profiles/${encodePathSegment(profileId)}/backtests/${encodePathSegment(runId)}/abort`,
    ),
    BacktestRunDetailSchema,
    { method: 'POST' },
  );

/** Re-run a finished (error/cancelled) run's config as a fresh run; returns the new id. */
export const retryBacktest = (profileId: string, runId: string): Promise<BacktestCreated> =>
  apiFetch(
    accountPath(
      `/profiles/${encodePathSegment(profileId)}/backtests/${encodePathSegment(runId)}/retry`,
    ),
    BacktestCreatedSchema,
    { method: 'POST' },
  );

/**
 * Delete a finished run from the history. The API 409s a run that is still the
 * profile baseline or in-flight; the caller surfaces that message and leaves
 * the row.
 */
export const deleteBacktest = (profileId: string, runId: string): Promise<void> =>
  apiFetch(
    accountPath(`/profiles/${encodePathSegment(profileId)}/backtests/${encodePathSegment(runId)}`),
    z.void(),
    { method: 'DELETE' },
  );

/** Query key for a run's persisted advisor variants (the poll the UI rehydrates from). */
export const backtestAdvisorQueryKey = (profileId: string, runId: string): readonly unknown[] => [
  'backtest',
  'advisor',
  profileId,
  runId,
];

/**
 * All persisted advisor variants for a finished run. The advisor is durable per
 * (profile, run, variant), so a reload rehydrates saved suggestions from here
 * with no fresh (re-billed) model call.
 */
export const fetchAdvisorResults = (
  profileId: string,
  runId: string,
): Promise<AdvisorListResponseType> =>
  apiFetch(
    accountPath(
      `/profiles/${encodePathSegment(profileId)}/backtests/${encodePathSegment(runId)}/advisor`,
    ),
    AdvisorListResponse,
    { method: 'GET' },
  );

/**
 * Start (or regenerate) one advisor variant. The study worker generates it in
 * the background; the route returns 202 with the row now `running`, which the
 * poll flips to `done`. Throws an `ApiError` with status 503 when the study
 * worker is offline or has no Anthropic credential — the caller surfaces the
 * "not configured" note. Allowed from a `done`/`error` row (regenerate); a row
 * already `running` returns 202 without enqueuing a second job.
 */
export const startAdvisor = (
  profileId: string,
  runId: string,
  variant: ImproveConfigMode,
): Promise<AdvisorResult> =>
  apiFetch(
    accountPath(
      `/profiles/${encodePathSegment(profileId)}/backtests/${encodePathSegment(runId)}/advisor/${encodePathSegment(variant)}`,
    ),
    AdvisorResultSchema,
    { method: 'POST' },
  );

/**
 * The exact advisor prompt for manual use, for an operator without a Console API
 * key. Copy it into claude.ai, then feed the reply to {@link parseImproveConfigReply}.
 * No API key needed server-side, so this never 503s (unlike {@link startAdvisor}).
 */
export const fetchImproveConfigPrompt = (
  profileId: string,
  runId: string,
): Promise<ImproveConfigPromptResponse> =>
  apiFetch(
    accountPath(
      `/profiles/${encodePathSegment(profileId)}/backtests/${encodePathSegment(runId)}/advisor/manual/prompt`,
    ),
    ImproveConfigPromptResponseSchema,
    { method: 'GET' },
  );

/**
 * Validate the model reply pasted back from claude.ai and persist it to the run's
 * `manual` variant slot. The API extracts the JSON, checks the shape (422 if it
 * can't), partitions the suggestions against the strategy schema, and writes the
 * row `done` synchronously (no queue, no credential). Returns the persisted
 * `manual` result; it coexists with the server-generated variants.
 */
export const parseImproveConfigReply = (
  profileId: string,
  runId: string,
  reply: string,
): Promise<AdvisorResult> =>
  apiFetch(
    accountPath(
      `/profiles/${encodePathSegment(profileId)}/backtests/${encodePathSegment(runId)}/advisor/manual`,
    ),
    AdvisorResultSchema,
    { method: 'POST', body: { reply } },
  );

/**
 * A page of the profile's runs, newest first.
 *
 * `filter` is the only narrowing the server implements. A `kind` param used to ride along beside it and was discarded on arrival — nothing stored on a run distinguishes one kind from another — so it is gone from the wire rather than left as a param the server ignores.
 *
 * @param profileId - Profile whose run history is being paged.
 * @param cursor - The previous page's `nextCursor`; null starts at the newest run.
 * @param limit - Page size; null takes the server default, which keeps the canonical first-page URL param-free.
 * @param filter - Outcome narrowing (profit/loss/error) from the runs-table toolbar; null returns every run.
 * @returns The page of runs with its next cursor and the total matching the same filter.
 */
export const fetchBacktestList = (
  profileId: string,
  cursor: string | null = null,
  limit: number | null = null,
  filter: string | null = null,
): Promise<BacktestListResponseType> => {
  return apiFetch(
    accountPath(`/profiles/${encodePathSegment(profileId)}/backtests`),
    BacktestListResponse,
    { method: 'GET', query: { cursor, limit, filter } },
  );
};

/**
 * Cache key for one page of {@link fetchBacktestList}. Every argument that changes the request changes the key, so a filter or page-size switch reads a separate cache entry instead of showing the previous page's rows under the new toolbar state.
 *
 * @param profileId - Profile whose run history is being paged.
 * @param cursor - The page cursor, null for the first page.
 * @param limit - Page size, null when the server default applies.
 * @param filter - Outcome narrowing, null when unfiltered.
 * @returns The query key tuple.
 */
export const backtestListQueryKey = (
  profileId: string,
  cursor: string | null = null,
  limit: number | null = null,
  filter: string | null = null,
): readonly unknown[] => ['backtest', 'list', profileId, cursor, limit, filter];

export const backtestRunQueryKey = (profileId: string, runId: string): readonly unknown[] => [
  'backtest',
  'run',
  profileId,
  runId,
];

/**
 * Candles for one symbol over a finished run's window, for the price chart.
 * Reuses the symbol candles endpoint (live Binance klines for the historical
 * range — the same public data the run backfilled). The endpoint returns at
 * most 1000 klines per call, so a long run's chart is truncated to its first
 * 1000 candles at `interval`; the trade table still lists every trade.
 */
export const fetchBacktestCandles = (
  profileId: string,
  symbol: string,
  interval: BacktestInterval,
  fromMs: number,
  toMs: number,
): Promise<CandleList> => {
  return apiFetch(
    accountPath(
      `/profiles/${encodePathSegment(profileId)}/symbols/${encodePathSegment(symbol)}/candles`,
    ),
    CandleList,
    {
      method: 'GET',
      query: {
        interval,
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
      },
    },
  );
};

export const backtestCandlesQueryKey = (
  profileId: string,
  symbol: string,
  interval: string,
  fromMs: number,
  toMs: number,
): readonly unknown[] => ['backtest', 'candles', profileId, symbol, interval, fromMs, toMs];
