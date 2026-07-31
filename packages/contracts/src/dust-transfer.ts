import { z } from 'zod';
import { DecimalString } from './decimal.js';

/**
 * One asset row eligible for Binance's BNB dust-conversion. `canDustTransfer`
 * encodes Binance's own eligibility rule so the operator UI can grey out
 * non-convertible holdings without re-implementing the check.
 */
export const DustAsset = z.object({
  asset: z.string(),
  free: DecimalString,
  locked: DecimalString,
  estimatedBTC: DecimalString,
  canDustTransfer: z.boolean(),
});
/** TS type derived from {@link DustAsset} so consumers don't re-run z.infer at every call site. */
export type DustAsset = z.infer<typeof DustAsset>;

/** Response for `GET /dust-transfer`. Plain list; Binance returns the eligible set in one call. */
export const DustTransferList = z.array(DustAsset);
/** TS type derived from {@link DustTransferList} so consumers don't re-run z.infer at every call site. */
export type DustTransferList = z.infer<typeof DustTransferList>;

/**
 * Worker-cached dust snapshot. The `dust-snapshot` cron writes this Redis
 * value from Binance's `dust-btc` endpoint; the `GET /dust-transfer` route
 * serves `assets` straight from it. `fetchedAt` records when the cron last
 * refreshed the set — cache metadata, not currently surfaced past the API.
 */
export const DustSnapshot = z.object({
  assets: DustTransferList,
  fetchedAt: z.iso.datetime(),
});
/** TS type derived from {@link DustSnapshot} so consumers don't re-run z.infer at every call site. */
export type DustSnapshot = z.infer<typeof DustSnapshot>;

/** Body for `POST /dust-transfer`. Capped at 64 to match Binance's per-call limit so partial failures are obvious. */
export const DustTransferRequest = z.object({
  assets: z.array(z.string().min(1).max(16)).min(1).max(64),
});
/** TS type derived from {@link DustTransferRequest} so consumers don't re-run z.infer at every call site. */
export type DustTransferRequest = z.infer<typeof DustTransferRequest>;

/**
 * Acknowledgement that the dust transfer was queued as an override action.
 * Actual Binance call happens off the request thread so a slow Binance API
 * never times out the operator's click.
 */
export const DustTransferResponse = z.object({
  scheduledAt: z.iso.datetime(),
  overrideActionId: z.uuid(),
});
/** TS type derived from {@link DustTransferResponse} so consumers don't re-run z.infer at every call site. */
export type DustTransferResponse = z.infer<typeof DustTransferResponse>;

/**
 * One past dust conversion for the operator's history. `convertedAssets` /
 * `bnbReceived` come from Binance's convertDust response, recorded when the
 * worker finalises the action — null until then (pending/processing) since the
 * outcome isn't known before the call. `status` folds the override-action
 * lifecycle (pending/processing/consumed) into operator-facing words.
 */
export const DustConversionRecord = z.object({
  id: z.uuid(),
  requestedAssets: z.array(z.string()),
  convertedAssets: z.array(z.string()).nullable(),
  bnbReceived: DecimalString.nullable(),
  status: z.enum(['pending', 'processing', 'done']),
  createdAt: z.iso.datetime(),
  consumedAt: z.iso.datetime().nullable(),
});
/** TS type derived from {@link DustConversionRecord}. */
export type DustConversionRecord = z.infer<typeof DustConversionRecord>;

/** Response for `GET /dust-transfer/history`: most-recent-first conversion list. */
export const DustConversionHistory = z.array(DustConversionRecord);
/** TS type derived from {@link DustConversionHistory}. */
export type DustConversionHistory = z.infer<typeof DustConversionHistory>;
