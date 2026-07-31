import { describe, expect, it } from 'vitest';
import { BinanceApiError } from '@app/binance';

import { classifyBinanceError } from '../../src/executor/binance-error-taxonomy.js';

/**
 * `phase` decides whether a failed order may be re-issued. Get it wrong in the
 * safe direction and an operator's force-sell is silently dropped; get it wrong
 * in the unsafe direction and the bot places a SECOND live market order on a
 * request that already filled.
 *
 * The classification itself lives in `@app/binance` (only the REST client knows
 * whether Binance's answer was readable); what is asserted here is that the
 * taxonomy carries it through to the `DecisionResult` faithfully, and that it
 * never conflates `phase` with `retryable` — they answer different questions.
 */
const err = (status: number, code: number, msg: string, phase: 'rejected' | 'ambiguous') =>
  new BinanceApiError({ status, code, msg }, false, phase);

describe('classifyBinanceError', () => {
  it("carries the error's phase onto every failure verdict without touching retryable", () => {
    const transient = classifyBinanceError(err(429, -1003, 'too many requests', 'rejected'));
    expect(transient.result).toMatchObject({ ok: false, retryable: true, phase: 'rejected' });

    const logic = classifyBinanceError(err(400, -2010, 'insufficient balance', 'rejected'));
    expect(logic.result).toMatchObject({ ok: false, retryable: false, phase: 'rejected' });

    // A 5xx stays retryable (the cause is transient) AND ambiguous (it may have
    // executed). The two verdicts are independent, and both are needed.
    const serverError = classifyBinanceError(err(503, -1001, 'internal error', 'ambiguous'));
    expect(serverError.result).toMatchObject({ ok: false, retryable: true, phase: 'ambiguous' });

    // An unreadable error body: the REST client could not read a code, so it
    // stamped `ambiguous`, and the taxonomy must not downgrade that to rejected.
    const unreadable = classifyBinanceError(err(418, 0, 'teapot', 'ambiguous'));
    expect(unreadable.result).toMatchObject({ ok: false, retryable: false, phase: 'ambiguous' });
  });

  it('flags an illegal-value-range code as an emergency (a bug in us, not Binance)', () => {
    expect(classifyBinanceError(err(400, -1102, 'bad param', 'rejected')).emergency).toBe(true);
  });

  it('still short-circuits a duplicate clientOrderId as success', () => {
    expect(classifyBinanceError(err(400, -2026, 'duplicate order', 'rejected')).result).toEqual({
      ok: true,
    });
  });
});
