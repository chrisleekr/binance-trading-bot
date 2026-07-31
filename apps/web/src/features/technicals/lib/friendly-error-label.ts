// Operator-friendly mapping of the raw fetch-status `error` string the
// worker writes after a failed Technicals compute batch. The cron's
// error surface comes from three sources: the Binance public klines REST
// call (`Binance klines: ...`), the pipeline commit (`pipeline: ...`),
// and the parse step (`row shape unexpected` / `response not an array`).
// This module maps each to one of four remediation buckets so the
// operator sees what side of the pipeline broke without reading the source.
//
// Shared by the dashboard health pill and the symbol panel body's
// empty-state diagnostic so both surfaces agree on what an error means.

/**
 * Map a raw fetch-status `error` string to an operator-readable label.
 *
 *  - `binance rate-limited` — Binance returned 418/429 on the public
 *    klines call. The cron auto-retries the next tick; persistent
 *    rate-limit suggests the worker IP is being throttled.
 *  - `binance rejected` — any other 4xx (bad symbol, malformed request).
 *    Operator should inspect the configured symbol list.
 *  - `binance error` — Binance returned 5xx. Transient; the next tick retries.
 *  - `binance timeout` — request did not complete within the 10s budget.
 *  - `kline parse error` — Binance's response shape diverged from the
 *    documented array-of-arrays format.
 *  - `redis commit failed` — the pipeline SET batch failed; check Redis
 *    health.
 *
 * Unrecognised labels fall through unchanged so a new error surface still
 * renders without code change.
 */
export function friendlyErrorLabel(raw: string): string {
  const stripped = raw.replace(/^all \d+ rows? failed:\s*/i, '');
  if (/HTTP (418|429)\b/i.test(stripped)) return 'binance rate-limited';
  if (/HTTP 4\d\d\b/i.test(stripped)) return 'binance rejected';
  if (/HTTP 5\d\d\b/i.test(stripped)) return 'binance error';
  if (/timeout|abort/i.test(stripped)) return 'binance timeout';
  if (/row shape|response not an array/i.test(stripped)) return 'kline parse error';
  if (/^pipeline:/i.test(stripped)) return 'redis commit failed';
  return stripped;
}
