import { z } from 'zod';
import { BinanceMode } from './profiles.js';

// Orphan orders: orders open on the Binance master account that no local
// `orders` row tracks. The worker's `orphan-orders-detect` cron writes the
// current set to a global Redis snapshot (the API cannot reach Binance), and
// the API serves + adopts from it. Shared here so the writer (worker) and the
// readers (api, web) agree on one shape.

// `mode` (reused from profiles) records which Binance environment the orphan
// lives on. A `test` and a `live` profile are different accounts
// (testnet.binance.vision vs api.binance.com) with independent order books, so
// an order id is only meaningful paired with its mode and an orphan can only be
// adopted into a profile of the same mode.

/**
 * One orphan order as projected from a Binance `OpenOrderDto`. `orderId` is a
 * STRING: Binance numeric order ids can exceed 2^53, which a JSON number would
 * silently round, so the id rides as a decimal string end-to-end and is parsed
 * to `bigint` only at the DB boundary.
 */
export const OrphanOrderSchema = z.object({
  orderId: z.string(),
  // The account whose key pair found this order. `mode` alone cannot name it
  // once the operator owns two accounts on the same environment, and a link into
  // the app needs the account it is scoped under.
  accountId: z.string(),
  symbol: z.string(),
  side: z.enum(['BUY', 'SELL']),
  type: z.string(),
  price: z.string(),
  origQty: z.string(),
  status: z.string(),
  clientOrderId: z.string(),
  timeMs: z.number(),
  mode: BinanceMode,
});
export type OrphanOrder = z.infer<typeof OrphanOrderSchema>;

/**
 * The full current orphan set plus when it was computed, so the UI can show
 * staleness ("as of N minutes ago") rather than implying a live read.
 */
export const OrphanSnapshotSchema = z.object({
  computedAtMs: z.number(),
  orphans: z.array(OrphanOrderSchema),
});
export type OrphanSnapshot = z.infer<typeof OrphanSnapshotSchema>;

/**
 * An orphan as served to the operator: the snapshot fields plus the DERIVED
 * owning profile — the one whose strategy proves it emitted this clientOrderId,
 * recomputed from that strategy's own id scheme.
 *
 * Null means the order is not adoptable at all: no strategy on the account can
 * prove it placed it (an order placed by hand, by another bot, or one whose id
 * folds runtime data that cannot be re-derived), or more than one profile claims
 * it. There is deliberately no operator picker: the only safe destination for a
 * lost order is the profile that placed it, since that is the only one that
 * recognises the id and can reprice or cancel the order. Anywhere else, the order
 * rests forever locking the base asset against its true owner.
 */
export const OrphanOrderViewSchema = OrphanOrderSchema.extend({
  ownerProfileId: z.string().nullable(),
  ownerProfileName: z.string().nullable(),
});
export type OrphanOrderView = z.infer<typeof OrphanOrderViewSchema>;

// No profile list: the destination is derived, so there is nothing to pick from,
// and the derived owner's name rides inline on each orphan as `ownerProfileName`.
export const OrphanOrdersResponseSchema = z.object({
  // Null when no snapshot has been computed yet (cron has not run since boot).
  computedAtMs: z.number().nullable(),
  orphans: z.array(OrphanOrderViewSchema),
});
export type OrphanOrdersResponse = z.infer<typeof OrphanOrdersResponseSchema>;

// NO `profileId`: the destination is DERIVED from the clientOrderId, never chosen.
// Accepting one would re-open the exact hole that let an operator hand trailing-
// trade's protective stops to a momentum profile.
export const AdoptOrphanRequestSchema = z.object({
  orderId: z.string().min(1),
  // The environment the orphan was found on. Required because an order id is
  // unique only within one Binance account, so (orderId, mode) — not orderId
  // alone — identifies the orphan to adopt.
  mode: BinanceMode,
});
export type AdoptOrphanRequest = z.infer<typeof AdoptOrphanRequestSchema>;

export const AdoptOrphanResponseSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  profileId: z.string(),
  binanceOrderId: z.string(),
});
export type AdoptOrphanResponse = z.infer<typeof AdoptOrphanResponseSchema>;
