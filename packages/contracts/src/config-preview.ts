import { z } from 'zod';

/**
 * Wire mirror of the strategy-core `PreviewRow`. Restated here rather than imported because strategy-core carries no contracts dependency, and this boundary needs a zod schema the OpenAPI document can describe.
 *
 * Every money field is a decimal string. A row is either price-bearing, a level the tick would act on, or price-less, a basket target carrying `symbol` / `weight` / `drift`.
 */
export const PreviewRow = z.object({
  code: z.string(),
  label: z.string().optional(),
  tone: z.enum(['entry', 'buy', 'sell', 'trail', 'stop', 'neutral']),
  price: z.string().optional(),
  limitPrice: z.string().optional(),
  quantity: z.string().optional(),
  trigger: z.boolean().optional(),
  triggerWhen: z.enum(['above', 'below']).optional(),
  skip: z.string().optional(),
  symbol: z.string().optional(),
  weight: z.string().optional(),
  drift: z.string().optional(),
  note: z.string().optional(),
  chartLine: z.boolean().optional(),
});
export type PreviewRow = z.infer<typeof PreviewRow>;

export const PreviewSection = z.object({
  title: z.string(),
  rows: z.array(PreviewRow),
});
export type PreviewSection = z.infer<typeof PreviewSection>;

/**
 * Request body for `POST /profiles/:profileId/symbols/:symbol/preview-config`.
 *
 * `config` is a candidate per-symbol OVERRIDE, not a whole configuration: it is merged over the profile's config exactly the way a stored override would be, so what comes back is the projection for the configuration that would actually run. Omitting it previews what is live now, which is the only way to compare a candidate against the current behaviour without first writing it.
 */
export const ConfigPreviewRequest = z.object({
  config: z.unknown().optional(),
});
export type ConfigPreviewRequest = z.infer<typeof ConfigPreviewRequest>;

/**
 * Response for the preview route: the projected levels, and the effective merged configuration they were computed from.
 *
 * `effectiveConfig` is returned alongside the sections because the projection alone cannot show which of two settings produced a level, and a caller comparing a candidate against the live configuration needs to see what the merge actually resolved to.
 */
export const ConfigPreviewResponse = z.object({
  sections: z.array(PreviewSection),
  effectiveConfig: z.unknown(),
  /** Null when no price is cached for the symbol, which makes every price-bearing row a projection off the cost basis alone. */
  currentPrice: z.string().nullable(),
  /** Null when the position has no recorded cost basis, which is the normal state for a symbol that is flat. */
  entryPrice: z.string().nullable(),
  /** The price the projection is anchored on. Every strategy projection is relative to an entry, so a flat symbol is projected from the live price as the entry a first buy would fill at, which is what both operator views already do. Null only when neither a cost basis nor a cached price exists, and the sections are then empty. */
  anchorPrice: z.string().nullable(),
  /** Which of the two the anchor came from. Without it a caller cannot tell a projection off a real position from one off a hypothetical first entry, and those carry very different weight. */
  anchorBasis: z.enum(['position', 'current-price', 'none']),
  /** Candle intervals the projection got no candles for, whether the request failed or came back with no rows, and empty when every window carried history. A projection that reads candles emits no rows at all when handed none, so without this list a caller cannot tell a guard that is switched off from one whose history never arrived, and the two lead to opposite decisions. Windows are deduplicated by interval before they are requested, so the interval names the window. */
  missingCandleWindows: z.array(z.string()),
});
export type ConfigPreviewResponse = z.infer<typeof ConfigPreviewResponse>;
