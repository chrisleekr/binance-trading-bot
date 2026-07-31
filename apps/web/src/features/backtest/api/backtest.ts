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
      ...(opts.force ? { query: { force: true } } : {}),
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

/** A page of the profile's runs, newest first; pass the previous page's
 * `nextCursor` to fetch the next page. `limit` sets the page size and `filter`
 * narrows by outcome (profit/loss/error — the runs-table filter); both default
 * to the whole unfiltered, server-default-sized page. */
export const fetchBacktestList = (
  profileId: string,
  cursor: string | null = null,
  limit: number | null = null,
  filter: string | null = null,
  kind: string | null = null,
): Promise<BacktestListResponseType> => {
  const params = new URLSearchParams();
  if (cursor !== null) params.set('cursor', cursor);
  if (limit !== null) params.set('limit', String(limit));
  if (filter !== null) params.set('filter', filter);
  if (kind !== null) params.set('kind', kind);
  const query = params.toString();
  return apiFetch(
    accountPath(`/profiles/${encodePathSegment(profileId)}/backtests${query ? `?${query}` : ''}`),
    BacktestListResponse,
    { method: 'GET' },
  );
};

export const backtestListQueryKey = (
  profileId: string,
  cursor: string | null = null,
  limit: number | null = null,
  filter: string | null = null,
  kind: string | null = null,
): readonly unknown[] => ['backtest', 'list', profileId, cursor, limit, filter, kind];

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
  const search = new URLSearchParams({
    interval,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
  });
  return apiFetch(
    accountPath(
      `/profiles/${encodePathSegment(profileId)}/symbols/${encodePathSegment(symbol)}/candles?${search.toString()}`,
    ),
    CandleList,
    { method: 'GET' },
  );
};

export const backtestCandlesQueryKey = (
  profileId: string,
  symbol: string,
  interval: string,
  fromMs: number,
  toMs: number,
): readonly unknown[] => ['backtest', 'candles', profileId, symbol, interval, fromMs, toMs];
