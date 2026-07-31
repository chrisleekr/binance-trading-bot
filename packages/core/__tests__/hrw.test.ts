import { describe, expect, it } from 'vitest';
import { rendezvousOwner } from '../src/hrw/hrw.js';

describe('rendezvousOwner', () => {
  it('returns null for an empty member set', () => {
    expect(rendezvousOwner('account-1', [])).toBeNull();
  });

  it('returns the sole member', () => {
    expect(rendezvousOwner('account-1', ['pod-a'])).toBe('pod-a');
  });

  it('is deterministic across calls and independent of member order', () => {
    const members = ['pod-a', 'pod-b', 'pod-c', 'pod-d'];
    const owner = rendezvousOwner('account-1', members);
    expect(rendezvousOwner('account-1', members)).toBe(owner);
    expect(rendezvousOwner('account-1', [...members].reverse())).toBe(owner);
    expect(rendezvousOwner('account-1', ['pod-c', 'pod-a', 'pod-d', 'pod-b'])).toBe(owner);
    expect(members).toContain(owner);
  });

  it('distributes distinct keys across members (not all to one)', () => {
    const members = ['pod-a', 'pod-b', 'pod-c'];
    const owners = new Set(
      Array.from({ length: 60 }, (_, i) => rendezvousOwner(`account-${i}`, members)),
    );
    // With 60 keys over 3 members a well-distributed hash claims all three.
    expect(owners).toEqual(new Set(members));
  });

  it('reassigns minimally when a non-owner is removed', () => {
    const members = ['pod-a', 'pod-b', 'pod-c', 'pod-d'];
    const keys = Array.from({ length: 200 }, (_, i) => `account-${i}`);
    const before = new Map(keys.map((k) => [k, rendezvousOwner(k, members)]));

    // Remove a member; only keys owned by the departed member may move.
    const departed = 'pod-b';
    const survivors = members.filter((m) => m !== departed);
    for (const k of keys) {
      const owner = rendezvousOwner(k, survivors);
      if (before.get(k) !== departed) {
        // Keys the departed member did not own keep their owner exactly.
        expect(owner).toBe(before.get(k));
      } else {
        // Keys it did own re-home onto a surviving member.
        expect(survivors).toContain(owner);
      }
    }
  });

  it('adds a member without moving keys away from each other', () => {
    const base = ['pod-a', 'pod-b', 'pod-c'];
    const grown = [...base, 'pod-d'];
    const keys = Array.from({ length: 200 }, (_, i) => `account-${i}`);
    for (const k of keys) {
      const before = rendezvousOwner(k, base);
      const after = rendezvousOwner(k, grown);
      // A key either keeps its old owner or moves to the newcomer — never
      // hops between two pre-existing members.
      expect(after === before || after === 'pod-d').toBe(true);
    }
  });

  it('stays deterministic when a member id repeats', () => {
    // Duplicate ids hit the equal-score comparison and must resolve to that id
    // regardless of position. This pins determinism under duplicate ids; it does
    // NOT exercise the lexical-swap branch (that needs two DISTINCT ids with a
    // colliding 64-bit score, which is not constructible without stubbing the
    // hash). Real deployments never have duplicate hostname:pid ids.
    expect(rendezvousOwner('k', ['pod-a', 'pod-a'])).toBe('pod-a');
    expect(rendezvousOwner('k', ['pod-b', 'pod-a', 'pod-b'])).toBe(
      rendezvousOwner('k', ['pod-a', 'pod-b']),
    );
  });
});
