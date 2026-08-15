import { BinanceApiError } from '@app/binance';
import type { Decision, DecisionResult } from '@app/strategy-core';
import { describe, expect, it } from 'vitest';

import {
  ORDER_REFUSAL_PROBE_MS,
  buildOrderRequestIdentity,
  orderRefusalGate,
  orderRefusalIdentityKey,
  parseOrderRefusalState,
  transitionOrderRefusal,
  type OrderRefusalState,
} from '../../src/tick/order-refusal-circuit.js';

type Placement = Extract<Decision, { type: 'place-order' }>;

const NOW = 1_700_000_000_000;

const PLACE: Placement = {
  type: 'place-order',
  intent: {
    symbol: 'BTCUSDT',
    side: 'BUY',
    reason: 'entry',
    clientOrderId: 'client-1',
  },
  params: {
    type: 'STOP_LOSS_LIMIT',
    quantity: '0.010',
    price: '50000',
    stopPrice: '50100',
    timeInForce: 'GTC',
  },
};

const rejected = (
  code = -2010,
  msg = 'Account has insufficient balance for requested action.',
): Extract<DecisionResult, { ok: false }> => {
  const cause = new BinanceApiError({ status: 400, code, msg }, false, 'rejected');
  return {
    ok: false,
    retryable: false,
    phase: 'rejected',
    reason: cause.message,
    cause,
  };
};

const resultOutcome = (decision: Placement, result: DecisionResult) => ({
  kind: 'result' as const,
  decision,
  result,
});

const countThree = (decision = PLACE): OrderRefusalState => ({
  v: 1,
  request: buildOrderRequestIdentity(decision),
  rejection: {
    code: -2010,
    msg: 'Account has insufficient balance for requested action.',
  },
  count: 3,
  nextProbeAtMs: NOW + ORDER_REFUSAL_PROBE_MS,
});

describe('order-refusal request identity', () => {
  it('uses exactly the fields transmitted to Binance', () => {
    expect(buildOrderRequestIdentity(PLACE)).toEqual({
      clientOrderId: 'client-1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'STOP_LOSS_LIMIT',
      quantity: '0.010',
      price: '50000',
      stopPrice: '50100',
      timeInForce: 'GTC',
    });
  });

  it.each([
    ['clientOrderId', { intent: { ...PLACE.intent, clientOrderId: 'client-2' } }],
    ['symbol', { intent: { ...PLACE.intent, symbol: 'ETHUSDT' } }],
    ['side', { intent: { ...PLACE.intent, side: 'SELL' as const } }],
    ['type', { params: { ...PLACE.params, type: 'LIMIT' as const } }],
    ['quantity', { params: { ...PLACE.params, quantity: '0.020' } }],
    ['price', { params: { ...PLACE.params, price: '49999' } }],
    ['stopPrice', { params: { ...PLACE.params, stopPrice: '50099' } }],
    ['timeInForce', { params: { ...PLACE.params, timeInForce: 'IOC' as const } }],
  ])('treats a changed %s as a new request', (_field, patch) => {
    const changed = { ...PLACE, ...patch } as Placement;
    expect(orderRefusalGate(countThree(), changed, NOW)).toEqual({ defer: false, probe: false });
    expect(
      transitionOrderRefusal(countThree(), resultOutcome(changed, rejected()), NOW),
    ).toMatchObject({
      state: { request: buildOrderRequestIdentity(changed), count: 1 },
      event: null,
    });
  });

  it('ignores strategy-only metadata that is not transmitted', () => {
    const changed: Placement = {
      ...PLACE,
      intent: {
        ...PLACE.intent,
        reason: 'another-reason',
        meta: { grid: 2 },
        overrideActionId: 'override-1',
        deferrable: true,
      },
    };

    expect(buildOrderRequestIdentity(changed)).toEqual(buildOrderRequestIdentity(PLACE));
    expect(orderRefusalGate(countThree(), changed, NOW)).toEqual({ defer: true, probe: false });
  });
});

describe('order-refusal gate', () => {
  it.each([
    ['entry', PLACE],
    [
      'exit',
      {
        ...PLACE,
        intent: { ...PLACE.intent, side: 'SELL' as const, reason: 'exit' },
        params: { type: 'MARKET' as const, quantity: '0.010' },
      },
    ],
    [
      'protective stop',
      {
        ...PLACE,
        intent: { ...PLACE.intent, side: 'SELL' as const, reason: 'protective-stop' },
      },
    ],
  ])('suppresses an identical %s until the exact probe boundary', (_name, decision) => {
    const state = countThree(decision as Placement);
    expect(
      orderRefusalGate(state, decision as Placement, NOW + ORDER_REFUSAL_PROBE_MS - 1),
    ).toEqual({ defer: true, probe: false });
    expect(orderRefusalGate(state, decision as Placement, NOW + ORDER_REFUSAL_PROBE_MS)).toEqual({
      defer: false,
      probe: true,
    });
  });

  it('fails open without a valid state', () => {
    expect(orderRefusalGate(null, PLACE, NOW)).toEqual({ defer: false, probe: false });
    expect(parseOrderRefusalState('{bad json')).toBeNull();
    expect(parseOrderRefusalState(undefined)).toBeUndefined();
  });
});

describe('order-refusal state round-trip', () => {
  // Every order type the strategies can emit, because a type the writer emits
  // and the reader rejects reads back as "no state": the count restarts at one
  // on every tick and the circuit never trips. `STOP_LOSS` is the exchange-native
  // trailing protective stop, exactly the order a price band keeps refusing.
  it.each(['LIMIT', 'MARKET', 'STOP_LOSS', 'STOP_LOSS_LIMIT'] as const)(
    'survives a %s request through storage',
    (type) => {
      const state = countThree({
        ...PLACE,
        params: { ...PLACE.params, type },
      } as Placement);
      expect(parseOrderRefusalState(JSON.stringify(state))).toEqual(state);
    },
  );

  it.each(['GTC', 'IOC', 'FOK'] as const)('survives a %s time-in-force', (timeInForce) => {
    const state = countThree({
      ...PLACE,
      params: { ...PLACE.params, timeInForce },
    } as Placement);
    expect(parseOrderRefusalState(JSON.stringify(state))).toEqual(state);
  });

  it('rejects a request field storage should never hold', () => {
    const state = countThree();
    const withBadType = {
      ...state,
      request: { ...state.request, type: 'OCO' },
    };
    expect(parseOrderRefusalState(JSON.stringify(withBadType))).toBeNull();
  });

  // Names carried on `Object.prototype`, which an `in` membership test answers
  // true for. The state is JSON read back from Redis, so a guard that accepts
  // them would hand an inherited member on as a union value.
  it.each(['toString', 'constructor', 'hasOwnProperty'])(
    'rejects the inherited member %s as an order type',
    (type) => {
      const state = countThree();
      const inherited = { ...state, request: { ...state.request, type } };
      expect(parseOrderRefusalState(JSON.stringify(inherited))).toBeNull();
    },
  );

  it.each(['toString', 'constructor'])(
    'rejects the inherited member %s as a time-in-force',
    (timeInForce) => {
      const state = countThree();
      const inherited = { ...state, request: { ...state.request, timeInForce } };
      expect(parseOrderRefusalState(JSON.stringify(inherited))).toBeNull();
    },
  );
});

describe('order-refusal transitions', () => {
  it('trips only after three identical request and rejection pairs', () => {
    const one = transitionOrderRefusal(null, resultOutcome(PLACE, rejected()), NOW);
    const two = transitionOrderRefusal(one.state, resultOutcome(PLACE, rejected()), NOW + 1);
    const three = transitionOrderRefusal(two.state, resultOutcome(PLACE, rejected()), NOW + 2);

    expect(one).toMatchObject({ state: { count: 1 }, event: null });
    expect(two).toMatchObject({ state: { count: 2 }, event: null });
    expect(three).toEqual({
      state: {
        v: 1,
        request: buildOrderRequestIdentity(PLACE),
        rejection: {
          code: -2010,
          msg: 'Account has insufficient balance for requested action.',
        },
        count: 3,
        nextProbeAtMs: NOW + 2 + ORDER_REFUSAL_PROBE_MS,
      },
      event: 'tripped',
    });
  });

  it.each([
    ['different code', rejected(-1013, 'Filter failure: LOT_SIZE')],
    ['different raw message', rejected(-2010, 'Market is closed.')],
  ])('resets to one on a %s', (_name, result) => {
    const next = transitionOrderRefusal(countThree(), resultOutcome(PLACE, result), NOW);
    expect(next).toMatchObject({ state: { count: 1 }, event: null });
  });

  it('refreshes the probe deadline and emits a probe event on the same rejection', () => {
    const next = transitionOrderRefusal(countThree(), resultOutcome(PLACE, rejected()), NOW);
    expect(next).toMatchObject({
      state: { count: 3, nextProbeAtMs: NOW + ORDER_REFUSAL_PROBE_MS },
      event: 'probe-refused',
    });
  });

  it('preserves a closed circuit on policy deferral and reschedules a due probe that never ran', () => {
    const state = countThree();
    expect(
      transitionOrderRefusal(
        state,
        { kind: 'circuit-deferred', decision: PLACE },
        NOW + ORDER_REFUSAL_PROBE_MS - 1,
      ),
    ).toEqual({ state, event: null });

    expect(
      transitionOrderRefusal(
        state,
        { kind: 'not-attempted', decision: PLACE },
        NOW + ORDER_REFUSAL_PROBE_MS,
      ),
    ).toMatchObject({
      state: { count: 3, nextProbeAtMs: NOW + 2 * ORDER_REFUSAL_PROBE_MS },
      event: null,
    });
  });

  it('preserves counts one and two when a sibling cancel or budget gate prevents placement', () => {
    const one = transitionOrderRefusal(null, resultOutcome(PLACE, rejected()), NOW).state;
    const two = transitionOrderRefusal(one, resultOutcome(PLACE, rejected()), NOW).state;
    expect(transitionOrderRefusal(one, { kind: 'not-attempted', decision: PLACE }, NOW).state).toBe(
      one,
    );
    expect(transitionOrderRefusal(two, { kind: 'not-attempted', decision: PLACE }, NOW).state).toBe(
      two,
    );
  });

  it.each([
    [
      'retryable rejection',
      {
        ok: false,
        retryable: true,
        phase: 'rejected',
        reason: 'rate limited',
        cause: new BinanceApiError(
          { status: 429, code: -1003, msg: 'Too many requests' },
          true,
          'rejected',
        ),
      } satisfies DecisionResult,
    ],
    [
      'ambiguous failure',
      {
        ok: false,
        retryable: true,
        phase: 'ambiguous',
        reason: 'timeout',
      } satisfies DecisionResult,
    ],
    [
      'local pre-call refusal',
      {
        ok: false,
        retryable: false,
        phase: 'pre-call',
        reason: 'no balance',
      } satisfies DecisionResult,
    ],
    ['success', { ok: true } satisfies DecisionResult],
  ])('clears on %s', (_name, result) => {
    expect(transitionOrderRefusal(countThree(), resultOutcome(PLACE, result), NOW)).toEqual({
      state: null,
      event: null,
    });
  });

  it('clears when no placement remains after the daily halt', () => {
    expect(transitionOrderRefusal(countThree(), null, NOW)).toEqual({ state: null, event: null });
  });

  it('uses the full request and rejection identity for the stable condition/throttle key', () => {
    const state = countThree();
    expect(orderRefusalIdentityKey(state)).toHaveLength(64);
    expect(orderRefusalIdentityKey(state)).toBe(orderRefusalIdentityKey({ ...state }));
    expect(
      orderRefusalIdentityKey({
        ...state,
        rejection: { ...state.rejection, msg: 'Market is closed.' },
      }),
    ).not.toBe(orderRefusalIdentityKey(state));
  });
});
