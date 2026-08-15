import { createHash } from 'node:crypto';
import { BinanceApiError } from '@app/binance';
import type { Decision, DecisionResult } from '@app/strategy-core';

export const ORDER_REFUSAL_THRESHOLD = 3;
export const ORDER_REFUSAL_PROBE_MS = 60_000;
export const ORDER_REFUSAL_TTL_MS = 900_000;

export type PlacementDecision = Extract<Decision, { type: 'place-order' }>;

export interface OrderRequestIdentity {
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly side: PlacementDecision['intent']['side'];
  readonly type: PlacementDecision['params']['type'];
  readonly quantity: string;
  readonly price: string | null;
  readonly stopPrice: string | null;
  readonly timeInForce: NonNullable<PlacementDecision['params']['timeInForce']> | null;
}

export interface OrderRejectionIdentity {
  readonly code: number;
  readonly msg: string;
}

interface OrderRefusalBase {
  readonly v: 1;
  readonly request: OrderRequestIdentity;
  readonly rejection: OrderRejectionIdentity;
}

export type OrderRefusalState =
  | (OrderRefusalBase & { readonly count: 1 | 2 })
  | (OrderRefusalBase & { readonly count: 3; readonly nextProbeAtMs: number });

export type OrderPlacementOutcome =
  | { readonly kind: 'circuit-deferred'; readonly decision: PlacementDecision }
  | { readonly kind: 'not-attempted'; readonly decision: PlacementDecision }
  | {
      readonly kind: 'result';
      readonly decision: PlacementDecision;
      readonly result: DecisionResult;
    };

export interface OrderRefusalTransition {
  readonly state: OrderRefusalState | null;
  readonly event: 'tripped' | 'probe-refused' | null;
}

export const buildOrderRequestIdentity = (decision: PlacementDecision): OrderRequestIdentity => ({
  clientOrderId: decision.intent.clientOrderId,
  symbol: decision.intent.symbol,
  side: decision.intent.side,
  type: decision.params.type,
  quantity: decision.params.quantity,
  price: decision.params.price ?? null,
  stopPrice: decision.params.stopPrice ?? null,
  timeInForce: decision.params.timeInForce ?? null,
});

const sameRequest = (a: OrderRequestIdentity, b: OrderRequestIdentity): boolean =>
  a.clientOrderId === b.clientOrderId &&
  a.symbol === b.symbol &&
  a.side === b.side &&
  a.type === b.type &&
  a.quantity === b.quantity &&
  a.price === b.price &&
  a.stopPrice === b.stopPrice &&
  a.timeInForce === b.timeInForce;

const sameRejection = (a: OrderRejectionIdentity, b: OrderRejectionIdentity): boolean =>
  a.code === b.code && a.msg === b.msg;

const structuralRejection = (result: DecisionResult): OrderRejectionIdentity | null => {
  if (
    result.ok ||
    result.phase !== 'rejected' ||
    result.retryable ||
    !(result.cause instanceof BinanceApiError)
  ) {
    return null;
  }
  return { code: result.cause.code, msg: result.cause.msg };
};

export const orderRefusalGate = (
  state: OrderRefusalState | null | undefined,
  decision: PlacementDecision,
  nowMs: number,
): { readonly defer: boolean; readonly probe: boolean } => {
  if (
    state?.count !== ORDER_REFUSAL_THRESHOLD ||
    !sameRequest(state.request, buildOrderRequestIdentity(decision))
  ) {
    return { defer: false, probe: false };
  }
  return nowMs < state.nextProbeAtMs
    ? { defer: true, probe: false }
    : { defer: false, probe: true };
};

export const transitionOrderRefusal = (
  previous: OrderRefusalState | null,
  outcome: OrderPlacementOutcome | null,
  nowMs: number,
): OrderRefusalTransition => {
  if (outcome === null) return { state: null, event: null };

  const request = buildOrderRequestIdentity(outcome.decision);
  if (outcome.kind === 'circuit-deferred') {
    return previous && sameRequest(previous.request, request)
      ? { state: previous, event: null }
      : { state: null, event: null };
  }

  if (outcome.kind === 'not-attempted') {
    if (!previous || !sameRequest(previous.request, request)) return { state: null, event: null };
    if (previous.count !== 3) {
      return { state: previous, event: null };
    }
    if (nowMs < previous.nextProbeAtMs) {
      return { state: previous, event: null };
    }
    return {
      state: { ...previous, nextProbeAtMs: nowMs + ORDER_REFUSAL_PROBE_MS },
      event: null,
    };
  }

  const rejection = structuralRejection(outcome.result);
  if (rejection === null) return { state: null, event: null };

  const same =
    previous !== null &&
    sameRequest(previous.request, request) &&
    sameRejection(previous.rejection, rejection);
  if (!same) {
    return { state: { v: 1, request, rejection, count: 1 }, event: null };
  }
  if (previous.count === 1) {
    return { state: { v: 1, request, rejection, count: 2 }, event: null };
  }
  return {
    state: {
      v: 1,
      request,
      rejection,
      count: 3,
      nextProbeAtMs: nowMs + ORDER_REFUSAL_PROBE_MS,
    },
    event: previous.count === 2 ? 'tripped' : 'probe-refused',
  };
};

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

// Keyed rather than a `!==` chain, and `satisfies Record<union, true>` rather
// than a plain literal: a member the writer can emit but the reader rejects
// makes every persisted state read as absent, so the count restarts at one on
// every tick and the circuit never trips. The record shape fails the build when
// the emitted union grows, which a chain of comparisons cannot.
const REQUEST_TYPES = {
  LIMIT: true,
  MARKET: true,
  STOP_LOSS: true,
  STOP_LOSS_LIMIT: true,
} as const satisfies Record<OrderRequestIdentity['type'], true>;

const TIME_IN_FORCE = {
  GTC: true,
  IOC: true,
  FOK: true,
} as const satisfies Record<NonNullable<OrderRequestIdentity['timeInForce']>, true>;

// Own-property, not `in`: `in` walks the prototype chain, so a persisted value
// of `toString` or `constructor` would pass the guard and be handed on as a
// member of the union. The state is JSON read back from Redis, so the reader
// cannot assume the writer produced it.
const isRequestType = (v: unknown): v is OrderRequestIdentity['type'] =>
  typeof v === 'string' && Object.hasOwn(REQUEST_TYPES, v);

const isTimeInForce = (v: unknown): v is NonNullable<OrderRequestIdentity['timeInForce']> =>
  typeof v === 'string' && Object.hasOwn(TIME_IN_FORCE, v);

const parseRequest = (value: unknown): OrderRequestIdentity | null => {
  const r = recordOf(value);
  if (!r) return null;
  const { clientOrderId, symbol, side, type, quantity, price, stopPrice, timeInForce } = r;
  if (
    typeof clientOrderId !== 'string' ||
    typeof symbol !== 'string' ||
    (side !== 'BUY' && side !== 'SELL') ||
    !isRequestType(type) ||
    typeof quantity !== 'string' ||
    (price !== null && typeof price !== 'string') ||
    (stopPrice !== null && typeof stopPrice !== 'string') ||
    (timeInForce !== null && !isTimeInForce(timeInForce))
  ) {
    return null;
  }
  return { clientOrderId, symbol, side, type, quantity, price, stopPrice, timeInForce };
};

export const parseOrderRefusalState = (
  raw: string | null | undefined,
): OrderRefusalState | null | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  try {
    const r = recordOf(JSON.parse(raw));
    const request = parseRequest(r?.['request']);
    const rejection = recordOf(r?.['rejection']);
    const code = rejection?.['code'];
    const msg = rejection?.['msg'];
    const count = r?.['count'];
    if (
      r?.['v'] !== 1 ||
      request === null ||
      typeof code !== 'number' ||
      !Number.isInteger(code) ||
      typeof msg !== 'string' ||
      (count !== 1 && count !== 2 && count !== 3)
    ) {
      return null;
    }
    const base = { v: 1 as const, request, rejection: { code, msg } };
    if (count === 1) return { ...base, count: 1 };
    if (count === 2) return { ...base, count: 2 };
    const nextProbeAtMs = r?.['nextProbeAtMs'];
    return typeof nextProbeAtMs === 'number' && Number.isFinite(nextProbeAtMs)
      ? { ...base, count: 3, nextProbeAtMs }
      : null;
  } catch {
    return null;
  }
};

export const orderRefusalIdentityKey = (
  state: Pick<OrderRefusalState, 'request' | 'rejection'>,
): string =>
  createHash('sha256')
    .update(JSON.stringify({ request: state.request, rejection: state.rejection }))
    .digest('hex');
