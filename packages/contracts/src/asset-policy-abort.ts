// Why a discovery cycle refused to rank, and how that reads to the operator.
//
// The cause starts in the worker's asset-policy check, is parked in Redis as a durable record, and ends up as a diagnosis finding on the profile page, so it crosses worker→api→web exactly the way `CONDITIONS` does and lives here for the same reason: one vocabulary, one place, no per-layer copy of the same strings.

import { z } from 'zod';

/**
 * Why one asset-policy snapshot was refused. Closed, and each member names a distinct upstream fault with a distinct remedy: a dead classification route is a schema change to chase at Binance, a cross-check gap is a stale or partial feed that may clear on its own, an empty admission map is this worker's own exchange-info cache being cold, and the two feed causes are the fetch itself failing — one where no answer arrived, one where the answer could not be read as this feed.
 */
export const ASSET_POLICY_ABORT_CAUSES = [
  'no-product-rows',
  'stablecoin-route-empty',
  'fiat-route-empty',
  'empty-admission-map',
  'cross-check-gap',
  'product-feed-unreachable',
  'product-feed-unreadable',
] as const;

export type AssetPolicyAbortCause = (typeof ASSET_POLICY_ABORT_CAUSES)[number];

/**
 * What the operator is told when a cycle aborted on this cause.
 *
 * Total over the union, with no fallback string anywhere: an unmapped cause has to fail at compile time, because the one thing this copy exists to prevent is a finding that names the fault in the enum's own words. The sentences say what stopped and what it costs, never the internal route name, and they gloss the term the first time it appears — an operator reading this page is being told their coin list stopped moving, and "stablecoin route" means nothing to them without it.
 */
export const ASSET_POLICY_ABORT_CAUSE_COPY: Record<AssetPolicyAbortCause, string> = {
  'no-product-rows':
    'Binance returned no coin catalogue at all, so nothing could be checked against it. Until it answers again, auto-discovery will not pick coins it cannot vet, and your coin list stays exactly as it is.',
  'stablecoin-route-empty':
    'Binance listed no stablecoins at all — a stablecoin is a coin pegged to a currency, like USDC, and the bot refuses to trade them because they barely move. An empty list means the check that keeps them out could not have kept anything out, so this scan was abandoned rather than trusted.',
  'fiat-route-empty':
    'Binance listed no national-currency markets at all — those are pairs priced in money like EUR or TRY, which the bot leaves alone. An empty list means the check that excludes them was not excluding anything, so this scan was abandoned rather than trusted.',
  'empty-admission-map':
    "The bot's own copy of the Binance trading rules is empty, so it had nothing to check the coin catalogue against. This is local and usually clears once the rules are refreshed.",
  'cross-check-gap':
    'The coin catalogue and the live Binance market list disagree about which coins exist, so the classification cannot be trusted for either side of the gap. Discovery stops rather than admit a coin it may have classified from stale data.',
  'product-feed-unreachable':
    'The bot could not reach Binance to fetch the coin catalogue at all — the request timed out, was refused, or came back as an error page. Nothing could be checked, so your coin list stays exactly as it is. A single failure like this often clears by itself on the next scan.',
  'product-feed-unreadable':
    'Binance answered, but not with anything the bot could make sense of: the reply was not valid data, was the wrong shape, or was far bigger than this catalogue has ever been. It was thrown away rather than half-trusted, so your coin list stays exactly as it is. Unlike a connection that simply failed, this one is unlikely to fix itself and usually needs someone to look at it.',
};

/**
 * The durable note that a profile's last discovery cycle refused to rank, and when.
 *
 * Parsed on read rather than trusted, because it is a plain Redis value that survives redeploys: a record written by an older worker, or hand-edited, must degrade to "no abort recorded" instead of putting an unknown cause on the operator's page.
 */
export const assetPolicyAbortRecordSchema = z.object({
  cause: z.enum(ASSET_POLICY_ABORT_CAUSES),
  /** When the NEWEST refusal happened, epoch ms. Rewritten every aborting cycle, so it dates the last attempt and never the fault. */
  atMs: z.number(),
  /** When this run of refusals started, epoch ms, carried forward while the cause holds. Optional because a record parked by an earlier worker has only `atMs`, and the reader falls back to it rather than dropping a real abort. This is what the operator is shown as the duration: `atMs` alone would restate a six-day outage as "for 12m", because every cycle rewrites it one refresh period later, which is the exact distinction between a chronic fault and an unlucky scan that this finding exists to make. */
  firstAtMs: z.number().optional(),
});

export type AssetPolicyAbortRecord = z.infer<typeof assetPolicyAbortRecordSchema>;
