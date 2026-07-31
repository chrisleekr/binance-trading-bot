// Binance error code → DecisionResult classification.
//
// Binance error codes: https://developers.binance.com/docs/binance-spot-api-docs/errors

import type { BinanceApiError } from '@app/binance';
import type { DecisionResult } from '@app/strategy-core';

export interface ClassifiedError {
  readonly result: DecisionResult;
  readonly emergency: boolean;
}

/**
 * Maps a Binance failure onto the executor's `DecisionResult`.
 *
 * Both verdicts on the result are read off the error, not re-derived here:
 * `retryable` ("will trying again ever work?") and `phase` ("did it provably not
 * execute?") are precomputed inside `@app/binance` at throw time, by the only
 * code that can see whether Binance's answer was readable. They answer different
 * questions and must not be conflated — a 5xx is retryable AND ambiguous.
 *
 * What this function still owns is the mapping from code to SEVERITY: which
 * failures are transient, which are the operator's problem, and which are a bug
 * in us (`emergency`).
 */
export const classifyBinanceError = (err: BinanceApiError): ClassifiedError => {
  const { status, code, phase } = err;
  const message = err.message;
  // Idempotent retry: duplicate clientOrderId
  if (code === -2026) {
    return {
      result: { ok: true },
      emergency: false,
    };
  }
  // Transient: rate limit / network / server timeout / oversize / HTTP 5xx
  if (
    code === -1003 ||
    code === -1006 ||
    code === -1007 ||
    code === -1015 ||
    (status >= 500 && status < 600) ||
    status === 429
  ) {
    return {
      result: {
        ok: false,
        retryable: true,
        phase,
        reason: `binance transient ${code}: ${message}`,
      },
      emergency: false,
    };
  }
  // -1021: timestamp out of recv window. Non-retryable here because the
  // binance client resyncs server time and retries once before the error
  // surfaces; a -1021 that reaches this classifier is a persistent host-clock
  // skew the caller cannot fix by retrying (the operator must fix the clock).
  if (code === -1021) {
    return {
      result: {
        ok: false,
        retryable: false,
        phase,
        reason: `binance recvWindow ${code}: ${message}`,
      },
      emergency: false,
    };
  }
  // Logic: non-retryable
  if (
    code === -1013 || // filter failure
    code === -2010 || // NEW_ORDER_REJECTED
    code === -2011 // CANCEL_REJECTED, treat as already-cancelled by caller
  ) {
    return {
      result: { ok: false, retryable: false, phase, reason: `binance logic ${code}: ${message}` },
      emergency: false,
    };
  }
  // Bug: illegal value range
  if (code <= -1100 && code >= -1199) {
    return {
      result: { ok: false, retryable: false, phase, reason: `binance illegal ${code}: ${message}` },
      emergency: true,
    };
  }
  // Unknown: conservative non-retryable
  return {
    result: {
      ok: false,
      retryable: false,
      phase,
      reason: `binance unknown ${status}/${code}: ${message}`,
    },
    emergency: false,
  };
};

export const minuteBucketOf = (nowMs: number): number => Math.floor(nowMs / 60_000);
