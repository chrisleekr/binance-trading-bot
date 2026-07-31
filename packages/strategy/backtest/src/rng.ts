import type { RNG } from '@app/strategy-core';

const MASK64 = (1n << 64n) - 1n;
const GAMMA = 0x9e3779b97f4a7c15n;
const MIX1 = 0xbf58476d1ce4e5b9n;
const MIX2 = 0x94d049bb133111ebn;
const TWO_POW_53 = 9007199254740992; // 2^53, the float53 denominator

/**
 * Seeded splitmix64 PRNG. Pure BigInt arithmetic — no `Math.random` and no
 * `Math.*` at all, so it satisfies both determinism (a fixed seed always
 * yields the same stream) and the strategy-package restriction that bans
 * the `Math` global. `next()` returns a double in [0, 1).
 *
 * splitmix64 is the standard seeding generator (used to seed xoshiro); its
 * statistical quality is more than adequate for a strategy's tie-breaking
 * use of `rng`, and being a pure function of the seed it is fully replayable.
 */
export class SeededRng implements RNG {
  private state: bigint;

  constructor(seed: number | bigint) {
    this.state = BigInt(seed) & MASK64;
  }

  next(): number {
    this.state = (this.state + GAMMA) & MASK64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * MIX1) & MASK64;
    z = ((z ^ (z >> 27n)) * MIX2) & MASK64;
    z = z ^ (z >> 31n);
    // Top 53 bits → a uniform double in [0, 1).
    return Number(z >> 11n) / TWO_POW_53;
  }
}
