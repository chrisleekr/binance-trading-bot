// Per-profile cap on how many coins may be held at once. Pure split plus an in-process lease, so the tick handler can make "count held, filter, apply" atomic across the symbols of one profile without a distributed lock.

import type { Decision } from '@app/strategy-core';
import type { ChainByKey } from 'lib/chain-by-key.js';
import { suppressBuyEntries, type SuppressResult } from './halt-filter.js';

/** Window in which a FILLED entry still counts as held. The fill-adopter writes the cost-basis row asynchronously after a MARKET entry fills, so without this a just-filled entry is briefly invisible to the count. */
export const POSITION_CAP_RECENT_FILL_WINDOW_MS: number = 15 * 60_000;

/** Chain key serialising the count-and-apply region of every tick of one profile. */
export const positionCapKey = (profileId: string): string => `position-cap:${profileId}`;

/** The split's outcome plus how many coins were held when it was made, for the log line. */
export interface PositionCapResult extends SuppressResult {
  readonly held: number;
}

/**
 * Drops BUY entries for a coin the profile does not hold once it already holds `max` coins. A coin already held keeps its BUYs (adds are not new positions), and SELL, cancel, event and KV decisions are never touched, so exits and stops keep running.
 *
 * @param decisions - This tick's decisions after the entry-halt filter.
 * @param symbol - The coin this tick is for.
 * @param heldSymbols - Distinct coins the profile holds or is entering.
 * @param max - The configured cap; callers pass only values above 0.
 * @returns `kept` and `dropped` as in `suppressBuyEntries` (`dropped` is empty when the cap does not bind) and `held`, the count of held coins.
 */
export const applyPositionCap = (
  decisions: readonly Decision[],
  symbol: string,
  heldSymbols: ReadonlySet<string>,
  max: number,
): PositionCapResult => {
  const held = heldSymbols.size;
  if (heldSymbols.has(symbol) || held < max) return { kept: decisions, dropped: [], held };
  return { ...suppressBuyEntries(decisions), held };
};

/**
 * Waits for `key` on the chain and holds it until the returned function is called, so a caller can keep the key across a region that is not one closure. Always acquire from inside an already-running chain on a different key and never the reverse, or two ticks can deadlock.
 *
 * @param chain - The worker's shared per-key executor.
 * @param key - The chain key to hold.
 * @returns A release function that is safe to call more than once.
 */
export const acquireLease = async (chain: ChainByKey, key: string): Promise<() => void> => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await new Promise<void>((acquired) => {
    void chain.run(key, () => {
      acquired();
      return held;
    });
  });
  return release;
};
