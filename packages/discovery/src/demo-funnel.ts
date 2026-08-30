import type { DiscoveryFunnel } from './funnel.js';

/**
 * The ticker ladder of the seeded demo scans, fixed across every scan.
 *
 * These are a view of the whole exchange and barely move between two scans fifteen minutes apart, so varying them would be noise rather than signal. The shape is chosen so the deepest proportional cut lands on `changeBand`: the funnel panel calls out the worst drop as the choke and tells the reader that is the setting to look at first, and the gainers band is a stage the operator can actually tune, unlike the quote or asset-policy rows.
 */
const TICKER_COUNTS = {
  universe: 1247,
  quote: 486,
  assetPolicy: 462,
  blacklist: 458,
  liquidity: 214,
  activity: 121,
  spread: 113,
  changeBand: 27,
} as const;

/**
 * Builds one seeded demo scan's funnel, for the discovery screenshot the docs embed.
 *
 * It lives beside the real `DiscoveryFunnel` and is typed as one so the compiler owns the stage set: the payload is written by a seeder under `scripts/`, which no tsconfig covers, and a renamed or dropped rung there would ship a docs screenshot whose ladder is silently short with every gate green.
 *
 * @param candidate - The scan's candidate-segment survivors plus its diff outcome: `probed` klines fetched, `age`/`trend`/`eligible` survivors, `added` symbols the cycle admitted, `kept` symbols it retained.
 * @returns A complete funnel, with the ticker rungs fixed and the candidate rungs taken from the argument.
 */
export function demoScanFunnel(candidate: {
  readonly probed: number;
  readonly age: number;
  readonly trend: number;
  readonly eligible: number;
  readonly added: number;
  readonly kept: number;
}): DiscoveryFunnel {
  return {
    ...TICKER_COUNTS,
    probed: candidate.probed,
    age: candidate.age,
    trend: candidate.trend,
    eligible: candidate.eligible,
    added: candidate.added,
    kept: candidate.kept,
    removed: 0,
    breadthOk: true,
  };
}
