import { z } from 'zod';
import { DecimalString } from './decimal.js';
import { BacktestProgressDetailSchema } from './backtest.js';

/**
 * Topic discriminator on the server→client WS envelope. The set is closed at
 * the schema layer so the client's exhaustiveness checks fail at compile time
 * if a new topic ships without typed-payload coverage.
 */
export const WsTopic = z.enum([
  'symbol-state',
  'orders',
  'logs',
  'profile-state',
  'heartbeat',
  'resync-required',
  'backtest-progress',
  'backtest-complete',
]);
/** {@link WsTopic} runtime value as a TypeScript union. */
export type WsTopic = z.infer<typeof WsTopic>;

/**
 * Per-symbol live state pushed on every tick. Decimals are wire-encoded as
 * strings so JS receivers don't lose precision on small price ticks.
 *
 * avgEntryPrice is intentionally absent: it changes only on fills, and the
 * `orders` topic already invalidates the dashboard query which re-reads the
 * ledger. Keeping it out of the tick frame avoids coupling mark-price updates
 * to position-state coherence.
 */
export const SymbolStatePayload = z.object({
  symbol: z.string(),
  currentPrice: DecimalString.nullable(),
});
/** TS type derived from {@link SymbolStatePayload} so consumers don't re-run z.infer at every call site. */
export type SymbolStatePayload = z.infer<typeof SymbolStatePayload>;

/**
 * Order-change notification. Emitted by the executor whenever an order is
 * placed or cancelled; the client treats it purely as a signal to invalidate
 * its order/dashboard queries and does not read the fields, so every field is
 * optional and the payload describes "something changed about an order" rather
 * than a full snapshot.
 */
export const OrdersPayload = z.object({
  orderId: z.number().int().optional(),
  clientOrderId: z.string().optional(),
  status: z.string().optional(),
  reason: z.string().optional(),
});
/** TS type derived from {@link OrdersPayload} so consumers don't re-run z.infer at every call site. */
export type OrdersPayload = z.infer<typeof OrdersPayload>;

/**
 * Strategy log line forwarded to the operator UI. `symbol` is nullable for
 * profile-scoped (cross-symbol) entries; `ctx` is opaque to keep the schema
 * stable while strategies evolve their structured-log shape.
 */
export const LogsPayload = z.object({
  symbol: z.string().nullable(),
  level: z.string(),
  msg: z.string(),
  ctx: z.unknown().optional(),
});
/** TS type derived from {@link LogsPayload} so consumers don't re-run z.infer at every call site. */
export type LogsPayload = z.infer<typeof LogsPayload>;

/**
 * Profile-level health metrics pushed at most once per tick. Drives the
 * operator's "is my bot alive" indicator without requiring a poll.
 */
export const ProfileStatePayload = z.object({
  enabled: z.boolean(),
  lastTickAt: z.iso.datetime().nullable(),
  lastTickLatencyMs: z.number().int().nonnegative().nullable(),
});
/** TS type derived from {@link ProfileStatePayload} so consumers don't re-run z.infer at every call site. */
export type ProfileStatePayload = z.infer<typeof ProfileStatePayload>;

/**
 * Server liveness ping. The envelope's `ts` is the actual timestamp; the
 * payload is empty so future fields can be added without bumping schema
 * version or breaking existing clients.
 */
export const HeartbeatPayload = z.object({});
/** TS type derived from {@link HeartbeatPayload} so consumers don't re-run z.infer at every call site. */
export type HeartbeatPayload = z.infer<typeof HeartbeatPayload>;

/**
 * Sent when the client's `?since=<seq>` is older than the Redis stream's
 * earliest entry; the client must refetch via REST. `reason` is optional
 * context; absence implies a generic "stream gap".
 */
export const ResyncRequiredPayload = z.object({
  reason: z.string().optional(),
});
/** TS type derived from {@link ResyncRequiredPayload} so consumers don't re-run z.infer at every call site. */
export type ResyncRequiredPayload = z.infer<typeof ResyncRequiredPayload>;

/**
 * Progress tick for a running backtest, emitted by the worker so an open UI
 * advances its progress live without polling. The durable run row is the source
 * of truth; this is the low-latency overlay. `pct` is 0–100; the phase/count
 * fields ({@link BacktestProgressDetailSchema}) drive the phase label, the
 * "candle X of Y" counter, and the ETA.
 */
export const BacktestProgressPayload = z.object({
  runId: z.uuid(),
  pct: z.number().int().min(0).max(100),
  ...BacktestProgressDetailSchema.shape,
});
/** TS type derived from {@link BacktestProgressPayload}. */
export type BacktestProgressPayload = z.infer<typeof BacktestProgressPayload>;
/** The fields the engine reports each tick, before the worker stamps `runId`. */
export type BacktestProgressUpdate = Omit<BacktestProgressPayload, 'runId'>;

/**
 * Signals a backtest reached a terminal state; the client re-fetches the
 * persisted result/status row. Carries only the id — the payload is not the
 * result, which is read from the durable row.
 */
export const BacktestCompletePayload = z.object({
  runId: z.uuid(),
});
/** TS type derived from {@link BacktestCompletePayload}. */
export type BacktestCompletePayload = z.infer<typeof BacktestCompletePayload>;

// Shared envelope fields. `seq` is monotonic per `(userId, profileId)`,
// assigned by the worker before XADD into `events:<u>:<p>:stream`; `ts` is the
// emit instant. Clients filter by `topic` and use `seq` to drive resume/resync.
const envelopeBase = { seq: z.number().int().nonnegative(), ts: z.iso.datetime() } as const;

/**
 * Server→client envelope, modelled as a discriminated union on `topic` so the
 * topic↔payload relationship is a compile-time fact: a consumer that narrows
 * on `topic` gets the matching payload type, and the worker's `emitEvent`
 * (typed via {@link WsPayloadFor}) rejects a payload that does not match its
 * topic. This is what makes the {@link WsTopic} JSDoc's exhaustiveness promise
 * real rather than aspirational.
 */
export const WsEvent = z.discriminatedUnion('topic', [
  z.object({ ...envelopeBase, topic: z.literal('symbol-state'), payload: SymbolStatePayload }),
  z.object({ ...envelopeBase, topic: z.literal('orders'), payload: OrdersPayload }),
  z.object({ ...envelopeBase, topic: z.literal('logs'), payload: LogsPayload }),
  z.object({ ...envelopeBase, topic: z.literal('profile-state'), payload: ProfileStatePayload }),
  z.object({ ...envelopeBase, topic: z.literal('heartbeat'), payload: HeartbeatPayload }),
  z.object({
    ...envelopeBase,
    topic: z.literal('resync-required'),
    payload: ResyncRequiredPayload,
  }),
  z.object({
    ...envelopeBase,
    topic: z.literal('backtest-progress'),
    payload: BacktestProgressPayload,
  }),
  z.object({
    ...envelopeBase,
    topic: z.literal('backtest-complete'),
    payload: BacktestCompletePayload,
  }),
]);
/** TS type derived from {@link WsEvent} so consumers don't re-run z.infer at every call site. */
export type WsEvent = z.infer<typeof WsEvent>;

/** Payload type for a given topic — the per-topic narrowing of {@link WsEvent}. */
export type WsPayloadFor<T extends WsTopic> = Extract<WsEvent, { topic: T }>['payload'];

// Compile-time exhaustiveness: errors if a `WsTopic` member has no `WsEvent`
// variant, so adding a topic without typed-payload coverage fails the build.
type _AssertEveryTopicCovered = WsTopic extends WsEvent['topic'] ? true : never;
const _everyTopicCovered: _AssertEveryTopicCovered = true;
void _everyTopicCovered;

// =============================================================================
// Redis stream field codec (worker XADD writer ↔ api XRANGE replay reader)
// =============================================================================
//
// A `WsEvent` is persisted to the `events:<u>:<p>:stream` replay stream as a
// flat XADD field tuple. The encode/decode pair below is the single source of
// that field layout, so the worker writer and the api replay reader cannot
// drift — and the reader validates against `WsEvent`, closing the gap where
// the replay (reconnect) path forwarded a hand-reconstructed envelope without
// the type guarantee the live pub/sub path already has.

/**
 * Flat XADD argument tuple (`name, value, …`) for one envelope. Takes the
 * structural envelope rather than the `WsEvent` union: the caller (`emitEvent`)
 * has already type-checked the topic↔payload pairing, and encoding needs no
 * re-validation — that strictness lives on the `decode` side, which reads
 * untrusted stream bytes.
 */
export const encodeWsEventStreamFields = (event: {
  readonly seq: number;
  readonly topic: WsTopic;
  readonly ts: string;
  readonly payload: unknown;
}): string[] => [
  'seq',
  String(event.seq),
  'topic',
  event.topic,
  'ts',
  event.ts,
  'payload',
  JSON.stringify(event.payload),
];

/**
 * Reconstruct a validated `WsEvent` from XRANGE fields, or `null` when the
 * entry does not satisfy the contract (field drift or a corrupt stored
 * payload). Callers must not forward a `null` to clients.
 */
export const decodeWsEventStreamFields = (fields: readonly string[]): WsEvent | null => {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key === undefined || value === undefined) continue;
    if (key === 'seq') {
      obj[key] = Number(value);
    } else if (key === 'payload') {
      try {
        obj[key] = JSON.parse(value);
      } catch {
        return null;
      }
    } else {
      obj[key] = value;
    }
  }
  const parsed = WsEvent.safeParse(obj);
  return parsed.success ? parsed.data : null;
};
