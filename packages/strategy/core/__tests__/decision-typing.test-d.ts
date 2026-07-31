// Type-level contract for the generic `Decision<Events>` discriminant.
//
// These tests live in a `.test-d.ts` file so a compile error here surfaces
// as a tsc failure during `bun run typecheck`. The body is intentionally
// minimal — the visible assertions are the `// @ts-expect-error` lines that
// flag missing or wrong-shape emit-event payloads at the call site.

import { z } from 'zod';
import type { Decision } from '../src/decision.js';

// Runtime value exists only to derive `Events` via `typeof`; `_`-prefixed to
// mark its value as intentionally unused.
const _events = {
  'tick-snapshot': {
    topic: 'symbol-state',
    payload: z.object({
      symbol: z.string(),
      tsMs: z.number().int().nonnegative(),
    }),
  },
} as const;
type Events = typeof _events;

// Well-formed emit: typed `eventType` + payload that satisfies the schema.
const ok: Decision<Events> = {
  type: 'emit-event',
  eventType: 'tick-snapshot',
  payload: { symbol: 'BTCUSDT', tsMs: 1 },
};
void ok;

const badTopic: Decision<Events> = {
  type: 'emit-event',
  // @ts-expect-error — `wrong-topic` is not a key of the events map.
  eventType: 'wrong-topic',
  payload: { symbol: 'BTCUSDT', tsMs: 1 },
};
void badTopic;

const badPayload: Decision<Events> = {
  type: 'emit-event',
  eventType: 'tick-snapshot',
  // @ts-expect-error — payload is missing the required `tsMs` field.
  payload: { symbol: 'BTCUSDT' },
};
void badPayload;

// place-order / cancel-order / noop remain assignable without an events
// map; they are generic-irrelevant variants.
const placeOrder: Decision<Events> = {
  type: 'place-order',
  intent: {
    symbol: 'BTCUSDT',
    side: 'BUY',
    reason: 'grid-buy',
    clientOrderId: 'cid',
  },
  params: { type: 'MARKET', quantity: '1' },
};
void placeOrder;
