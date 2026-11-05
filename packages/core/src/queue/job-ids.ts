// '|' because bullmq 5.58.7+ `Job.validateOptions` throws `Custom Id cannot contain :` when a custom id contains ':' and does not split into exactly 3 parts (the 3-part exception is for legacy repeatable ids), and the BullMQ docs say a custom id "must not contain the : separator as it will be translated in 2 different values". '|' cannot occur in a uuid, Binance symbol, or ms timestamp.
/**
 * Joins id segments with '|'. A part holding ':' or '|' could trip the BullMQ id rule or forge an extra segment so two different inputs collide, so it is refused here and a malformed value fails at the producer, not at BullMQ add time.
 * @param parts - The id segments in order; each must be free of ':' and '|'.
 * @returns The '|'-joined job id.
 */
const join = (...parts: readonly (string | number)[]): string => {
  for (const part of parts) {
    if (/[:|]/.test(String(part))) {
      throw new Error(`job id part must not contain ':' or '|': ${String(part)}`);
    }
  }
  return parts.join('|');
};

/**
 * Static id for the per-(profile, symbol) tick: BullMQ rejects an `.add()` whose id already exists in any state, so a burst of events collapses into one waiting/active tick. The producer MUST pair it with `removeOnComplete: true` / `removeOnFail: true`, because a retained terminal job still occupies the id and the slot would never reopen.
 * @param profileId - The profile whose symbol is ticked.
 * @param symbol - The Binance symbol being ticked.
 * @returns The static coalescing id.
 */
export const tickJobId = (profileId: string, symbol: string): string =>
  join('tick', profileId, symbol);

/**
 * Timestamped id for an operator-triggered tick: unique per call so it never coalesces with, or is dropped behind, the static tick id.
 * @param profileId - The profile whose symbol is ticked.
 * @param symbol - The Binance symbol being ticked.
 * @param atMs - Enqueue time in epoch ms, supplied by the caller so the id is the only thing that differs between clicks.
 * @returns A unique id.
 */
export const manualTickJobId = (profileId: string, symbol: string, atMs: number): string =>
  join('tick', profileId, symbol, atMs);

/**
 * Static id for a symbol reconcile. A reconcile converges to truth rather than incrementing, so N enqueues for one (profile, symbol) are worth one run; a burst (a -2011 fill plus the -2010 SELL rejection it causes on the next tick) collapses while the job is waiting or active. The producer MUST pair it with `removeOnComplete: true` / `removeOnFail: true` or the retained job keeps the id occupied.
 * @param profileId - The profile being reconciled.
 * @param symbol - The Binance symbol being reconciled.
 * @returns The static coalescing id.
 */
export const symbolReconcileJobId = (profileId: string, symbol: string): string =>
  join('reconcile-symbol', profileId, symbol);

/**
 * Static id for a backtest run's job, so a redelivered enqueue of the same run is deduped. The sweep cron derives the same id to find the run's job. Every run (a retry included) has a fresh run id, so a retained terminal job never blocks a later enqueue and the producer needs no removal option.
 * @param runId - The backtest run row id.
 * @returns The static coalescing id.
 */
export const backtestJobId = (runId: string): string => join('backtest', runId);

/**
 * Static id for a profile diagnosis run's job. Each click mints a fresh run id, so this dedupes a redelivery of that run's job, not a second click, and a retained terminal job never blocks a later enqueue.
 * @param runId - The diagnosis run row id.
 * @returns The static coalescing id.
 */
export const diagnosisJobId = (runId: string): string => join('diagnosis', runId);

/**
 * Static id for a profile subscribe, so duplicate enable requests collapse while one is waiting or active. The producer MUST pair it with `removeOnComplete: true` / `removeOnFail: true`.
 * @param profileId - The profile being subscribed to its market streams.
 * @returns The static coalescing id.
 */
export const subscribeJobId = (profileId: string): string => join('subscribe', profileId);

/**
 * Static id for a profile unsubscribe, so duplicate disable requests collapse while one is waiting or active. The producer MUST pair it with `removeOnComplete: true` / `removeOnFail: true`.
 * @param profileId - The profile being unsubscribed from its market streams.
 * @returns The static coalescing id.
 */
export const unsubscribeJobId = (profileId: string): string => join('unsubscribe', profileId);

/**
 * Static id for cancelling one order, so a double-clicked cancel collapses while one is waiting or active. The producer MUST pair it with `removeOnComplete: true` / `removeOnFail: true`.
 * @param orderId - The order row id to cancel.
 * @returns The static coalescing id.
 */
export const cancelOrderJobId = (orderId: string): string => join('cancel', orderId);

/**
 * Timestamped id for archiving a grid: unique per call, never coalesces.
 * @param profileId - The profile owning the grid.
 * @param symbol - The Binance symbol of the grid.
 * @param atMs - Enqueue time in epoch ms, making the id unique per call.
 * @returns A unique id.
 */
export const archiveGridJobId = (profileId: string, symbol: string, atMs: number): string =>
  join('archive-grid', profileId, symbol, atMs);

/**
 * Timestamped id for resetting a grid: unique per call, never coalesces.
 * @param profileId - The profile owning the grid.
 * @param symbol - The Binance symbol of the grid.
 * @param atMs - Enqueue time in epoch ms, making the id unique per call.
 * @returns A unique id.
 */
export const resetGridJobId = (profileId: string, symbol: string, atMs: number): string =>
  join('reset-grid', profileId, symbol, atMs);

/**
 * Timestamped id for applying an average entry price override: unique per call, never coalesces.
 * @param profileId - The profile owning the position.
 * @param symbol - The Binance symbol of the position.
 * @param atMs - Enqueue time in epoch ms, making the id unique per call.
 * @returns A unique id.
 */
export const applyAepJobId = (profileId: string, symbol: string, atMs: number): string =>
  join('apply-aep', profileId, symbol, atMs);

/**
 * Timestamped id for verifying an account's API key: unique per call, never coalesces.
 * @param accountId - The account whose key is verified.
 * @param atMs - Enqueue time in epoch ms, making the id unique per call.
 * @returns A unique id.
 */
export const verifyKeyJobId = (accountId: string, atMs: number): string =>
  join('verify-key', accountId, atMs);

/**
 * Timestamped id for an archive backfill requested by the operator: unique per call, never coalesces.
 * @param profileId - The profile whose archive is backfilled.
 * @param symbol - The Binance symbol being backfilled.
 * @param atMs - Schedule time in epoch ms, making the id unique per call.
 * @returns A unique id.
 */
export const backfillArchiveJobId = (profileId: string, symbol: string, atMs: number): string =>
  join('backfill-archive', profileId, symbol, atMs);

/**
 * Timestamped id for an archive backfill scheduled by the recovery sweep: the `sweep` segment keeps it distinct from an operator-requested backfill for the same symbol and instant. Unique per call, never coalesces.
 * @param profileId - The profile whose archive is backfilled.
 * @param symbol - The Binance symbol being backfilled.
 * @param atMs - Schedule time in epoch ms, making the id unique per call.
 * @returns A unique id.
 */
export const backfillArchiveSweepJobId = (
  profileId: string,
  symbol: string,
  atMs: number,
): string => join('backfill-archive', 'sweep', profileId, symbol, atMs);
