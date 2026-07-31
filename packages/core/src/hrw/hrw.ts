// Rendezvous (highest-random-weight) hashing.
//
// Picks a single deterministic owner for `key` among `members`. Each member is
// scored by hashing (member, key) together; the highest-scoring member owns the
// key. Two properties make this the right primitive for distributing per-account
// subscriptions across a worker fleet with no coordination:
//   1. Deterministic — every pod that sees the same member set computes the same
//      owner, so ownership needs no lock and no held key.
//   2. Minimal reassignment — adding or removing one member only remaps the keys
//      that scored highest to (or on) that member; every other key keeps its
//      owner. A departing pod hands off only its own accounts, not the whole map.

import { createHash } from 'node:crypto';

/**
 * Owner of `key` among `members`, or `null` when `members` is empty. Pure and
 * order-independent: ties (astronomically unlikely with a 64-bit score) break on
 * the lexically smaller member id so the result never depends on iteration order.
 */
export const rendezvousOwner = (key: string, members: readonly string[]): string | null => {
  let best: string | null = null;
  let bestScore = -1n; // scores are unsigned 64-bit, so any real score wins
  for (const member of members) {
    const score = hrwScore(member, key);
    if (score > bestScore || (score === bestScore && best !== null && member < best)) {
      bestScore = score;
      best = member;
    }
  }
  return best;
};

/**
 * 64-bit unsigned score for a (member, key) pair. The `\0` separator keeps
 * ("ab","c") and ("a","bc") from colliding to the same digest input.
 */
const hrwScore = (member: string, key: string): bigint => {
  const digest = createHash('sha1').update(member).update('\0').update(key).digest();
  return digest.readBigUInt64BE(0);
};
