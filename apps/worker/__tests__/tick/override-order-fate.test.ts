import { describe, expect, it } from 'vitest';
import type { Decision } from '@app/strategy-core';

import { resolveOverrideOrderFate } from '../../src/tick/override-settlement.js';
import type { AppliedDecision } from '../../src/executor/live-executor.js';

const OVERRIDE = 'ov-1';

// The operator's exit, fused with the retraction of the stop that was protecting the position. It carries the override id on the same `intent` a bare placement would, and it puts the same SELL on the exchange, so attribution that reads the variant rather than the id settles the wrong row.
const replacement = (overrideActionId?: string): Decision =>
  ({
    type: 'replace-order',
    cancelOrderId: 42,
    reason: 'tt-protective-stop-superseded',
    intent: {
      symbol: 'BTCUSDT',
      side: 'SELL',
      reason: 'manual',
      clientOrderId: 'c-exit',
      ...(overrideActionId !== undefined ? { overrideActionId } : {}),
    },
    params: { type: 'MARKET', quantity: '1' },
  }) as Decision;

const applied = (decision: Decision, ok: boolean): AppliedDecision =>
  ({
    decision,
    result: ok
      ? { ok: true }
      : { ok: false, retryable: false, phase: 'rejected', reason: 'binance said no' },
  }) as AppliedDecision;

describe('resolveOverrideOrderFate over a replacement', () => {
  it('attributes a replacement carrying the override id', () => {
    expect(resolveOverrideOrderFate(OVERRIDE, [applied(replacement(OVERRIDE), true)], [])).toEqual({
      kind: 'placed',
    });
  });

  // Without this the row settles `rejected` with "the strategy did not act", while the exit it fused went out and may have filled.
  it('reports the replacement’s own failure rather than "the strategy did not act"', () => {
    const fate = resolveOverrideOrderFate(OVERRIDE, [applied(replacement(OVERRIDE), false)], []);
    expect(fate.kind).toBe('failed');
  });

  it('sees a replacement the breaker dropped as suppressed, not absent', () => {
    expect(resolveOverrideOrderFate(OVERRIDE, [], [replacement(OVERRIDE)])).toMatchObject({
      kind: 'suppressed',
    });
  });

  it('still ignores a replacement carrying no override id', () => {
    expect(resolveOverrideOrderFate(OVERRIDE, [applied(replacement(), true)], [])).toEqual({
      kind: 'none',
    });
  });
});
