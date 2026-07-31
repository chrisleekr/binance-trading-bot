import { z } from 'zod';

import { TechnicalsBundleConfigSchema, TechnicalsSignalSchema } from './technicals.js';

/**
 * One per-interval entry inside a recommendations row. `signal` is `null`
 * when the worker has not yet cached a recommendation for this
 * (symbol, interval) pair — typical right after the operator adds a new
 * interval to the strategy config.
 */
export const TechnicalsIntervalRecommendation = z.object({
  interval: z.string().min(1),
  signal: TechnicalsSignalSchema.nullable(),
});
/** TS type derived from {@link TechnicalsIntervalRecommendation}. */
export type TechnicalsIntervalRecommendation = z.infer<typeof TechnicalsIntervalRecommendation>;

/**
 * One row in the per-profile Technicals recommendations response. `signals`
 * is one entry per configured interval; the UI renders each as its own tab
 * or pane. A flat list (rather than a keyed map) preserves the operator's
 * configured order in the response.
 */
export const TechnicalsRecommendationItem = z.object({
  symbol: z.string(),
  signals: z.array(TechnicalsIntervalRecommendation),
});
/** TS type derived from {@link TechnicalsRecommendationItem} so consumers don't re-run z.infer at every call site. */
export type TechnicalsRecommendationItem = z.infer<typeof TechnicalsRecommendationItem>;

/**
 * Reply for `GET /profiles/:profileId/technicals/recommendations`. The
 * response is a flat array because the route is bounded by the profile's
 * configured symbols; the client uses `fetchedAt` to render a "last
 * refreshed" pill so the operator can sanity-check the 15s poll cadence.
 */
export const TechnicalsResponse = z.object({
  items: z.array(TechnicalsRecommendationItem),
  fetchedAt: z.iso.datetime(),
  // Per-profile Technicals config. Carries the freshness gate
  // (`useOnlyWithinMin`, `ifExpires`) used to render the staleness pill
  // AND the configured intervals (`intervals[]`) so the panel can render
  // its per-interval tab strip in the operator's configured order. The
  // worker's technicals-gate keys on the same block so the panel pill and the
  // worker veto threshold are always identical.
  technicals: TechnicalsBundleConfigSchema,
  // True when the Technicals master switch is on for this profile
  // (strategy-specific config flag, defaults to true). When false the
  // strategy's buy gate bypasses Technicals entirely — the panel still
  // renders the signal but flags the gate as inactive so an operator does
  // not assume a SELL verdict will actually veto a buy.
  gateActive: z.boolean().default(true),
});
/** TS type derived from {@link TechnicalsResponse} so consumers don't re-run z.infer at every call site. */
export type TechnicalsResponse = z.infer<typeof TechnicalsResponse>;
